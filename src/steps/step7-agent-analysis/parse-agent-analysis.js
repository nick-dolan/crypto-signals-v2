function invalidAnalysis (message) {
  throw new Error(`Invalid Copilot analysis: ${message}`)
}

function isObject (value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function assertExactKeys (value, expectedKeys, label) {
  if (!isObject(value)) {
    invalidAnalysis(`${label} must be an object`)
  }

  const actual = Object.keys(value).sort()
  const expected = [...expectedKeys].sort()

  if (
    actual.length !== expected.length
    || actual.some((key, index) => key !== expected[index])
  ) {
    invalidAnalysis(`${label} has an unexpected structure`)
  }
}

function assertProbability (value, label) {
  if (
    !Number.isFinite(value)
    || value < 0
    || value > 1
    || Number(value.toFixed(2)) !== value
  ) {
    invalidAnalysis(`${label} must be a number from 0 to 1 with at most two decimals`)
  }
}

function assertStringArray (value, maxLength, label) {
  if (!Array.isArray(value) || value.length > maxLength) {
    invalidAnalysis(`${label} must contain at most ${maxLength} items`)
  }

  if (value.some(item => (
    typeof item !== "string"
    || !item.trim()
    || item.length > 500
  ))) {
    invalidAnalysis(`${label} must contain short non-empty strings`)
  }
}

function evidenceValueMatches (token, value) {
  const normalized = token.replace(
    /^[^\p{L}\p{N}_+.-]+|[^\p{L}\p{N}_+.-]+$/gu,
    "",
  )

  if (Number.isFinite(value)) {
    return Number(normalized) === value
  }

  if (typeof value === "string" || typeof value === "boolean" || value === null) {
    return normalized === String(value)
  }

  return Array.isArray(value) && value.some(item => (
    normalized === String(item)
  ))
}

function assertEvidenceReferences (observations, payload, row, label) {
  for (const observation of observations) {
    const references = [...observation.matchAll(
      /(?:^|[\s,(;])([A-Za-z][A-Za-z0-9_]*)\s*=\s*([^\s,;:)]+)/g,
    )]

    if (references.length === 0) {
      invalidAnalysis(`${label} must reference a payload field as field=value`)
    }

    for (const [, field, token] of references) {
      const fieldIndex = payload.schema.indexOf(field)

      if (fieldIndex < 0) {
        invalidAnalysis(`${label} references unknown field ${field}`)
      }

      if (!evidenceValueMatches(token, row[fieldIndex])) {
        invalidAnalysis(`${label} contains a value that does not match ${field}`)
      }
    }
  }
}

function getCandidateSymbols (payload) {
  if (!Array.isArray(payload?.schema) || !Array.isArray(payload?.candidates)) {
    invalidAnalysis("step 6 payload is incomplete")
  }

  const symbolIndex = payload.schema.indexOf("symbol")

  if (symbolIndex < 0) {
    invalidAnalysis("step 6 payload does not define symbol")
  }

  const symbols = payload.candidates.map(row => row?.[symbolIndex])

  if (
    symbols.some(symbol => typeof symbol !== "string" || !symbol)
    || payload.candidateCount !== symbols.length
  ) {
    invalidAnalysis("step 6 payload contains invalid candidates")
  }

  return symbols
}

export function parseAgentAnalysis (content, payload) {
  if (typeof content !== "string" || !content.trim()) {
    invalidAnalysis("response must be a non-empty string")
  }

  let analysis

  try {
    analysis = JSON.parse(content)
  } catch (error) {
    const details = error instanceof Error ? error.message : "unknown JSON error"

    invalidAnalysis(`response is not valid JSON: ${details}`)
  }

  assertExactKeys(
    analysis,
    ["schemaVersion", "asOf", "topCandidates", "assessments"],
    "response",
  )

  if (analysis.schemaVersion !== 1) {
    invalidAnalysis("schemaVersion must equal 1")
  }

  if (analysis.asOf !== payload.asOf) {
    invalidAnalysis("asOf does not match the agent payload")
  }

  const symbols = getCandidateSymbols(payload)

  if (!Array.isArray(analysis.assessments) || analysis.assessments.length !== symbols.length) {
    invalidAnalysis("assessments must contain every candidate")
  }

  analysis.assessments.forEach((assessment, index) => {
    assertExactKeys(
      assessment,
      [
        "symbol",
        "movementProbability",
        "estimateConfidence",
        "directionBias",
        "drivers",
        "counterSignals",
      ],
      `assessment ${index}`,
    )

    if (assessment.symbol !== symbols[index]) {
      invalidAnalysis(`assessment ${index} has an unexpected symbol`)
    }

    assertProbability(
      assessment.movementProbability,
      `assessment ${assessment.symbol} movementProbability`,
    )

    if (!["low", "medium", "high"].includes(assessment.estimateConfidence)) {
      invalidAnalysis(`assessment ${assessment.symbol} has invalid estimateConfidence`)
    }

    if (!["up", "down", "unclear"].includes(assessment.directionBias)) {
      invalidAnalysis(`assessment ${assessment.symbol} has invalid directionBias`)
    }

    assertStringArray(assessment.drivers, 3, `assessment ${assessment.symbol} drivers`)
    assertStringArray(
      assessment.counterSignals,
      2,
      `assessment ${assessment.symbol} counterSignals`,
    )
    assertEvidenceReferences(
      assessment.drivers,
      payload,
      payload.candidates[index],
      `assessment ${assessment.symbol} drivers`,
    )
    assertEvidenceReferences(
      assessment.counterSignals,
      payload,
      payload.candidates[index],
      `assessment ${assessment.symbol} counterSignals`,
    )

    if (assessment.drivers.length + assessment.counterSignals.length === 0) {
      invalidAnalysis(`assessment ${assessment.symbol} must explain its estimate`)
    }
  })

  const expectedTop = analysis.assessments
    .map((assessment, index) => ({ assessment, index }))
    .sort((first, second) => (
      second.assessment.movementProbability - first.assessment.movementProbability
      || first.index - second.index
    ))
    .slice(0, Math.min(5, symbols.length))

  if (!Array.isArray(analysis.topCandidates) || analysis.topCandidates.length !== expectedTop.length) {
    invalidAnalysis("topCandidates has an unexpected length")
  }

  analysis.topCandidates.forEach((candidate, index) => {
    assertExactKeys(
      candidate,
      ["symbol", "movementProbability", "explanation"],
      `top candidate ${index}`,
    )

    const expected = expectedTop[index].assessment

    if (
      candidate.symbol !== expected.symbol
      || candidate.movementProbability !== expected.movementProbability
    ) {
      invalidAnalysis(`top candidate ${index} does not match assessments`)
    }

    if (
      typeof candidate.explanation !== "string"
      || !candidate.explanation.trim()
      || candidate.explanation.length > 500
      || /\d/.test(candidate.explanation)
    ) {
      invalidAnalysis(`top candidate ${candidate.symbol} has an invalid explanation`)
    }

    const technicalField = payload.schema.find(field => (
      candidate.explanation.includes(field)
    ))

    if (technicalField) {
      invalidAnalysis(
        `top candidate ${candidate.symbol} explanation contains ${technicalField}`,
      )
    }
  })

  return analysis
}
