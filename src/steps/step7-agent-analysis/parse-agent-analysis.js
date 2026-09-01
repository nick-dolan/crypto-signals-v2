import { isArray, isError, isFinite, isObject, isString } from "../../helpers/utils.typed.js"

export class InvalidCopilotAnalysisError extends Error {
  constructor (message) {
    super(`Invalid Copilot analysis: ${message}`)
    this.name = "InvalidCopilotAnalysisError"
  }
}

function invalidAnalysis (message) {
  throw new InvalidCopilotAnalysisError(message)
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
    !isFinite(value)
    || value < 0
    || value > 1
    || Number(value.toFixed(2)) !== value
  ) {
    invalidAnalysis(`${label} must be a number from 0 to 1 with at most two decimals`)
  }
}

function formatEvidenceValue (value) {
  return isArray(value) ? JSON.stringify(value) : String(value)
}

function normalizeObservations (value, maxLength, payload, row, label) {
  if (!isArray(value) || value.length > maxLength) {
    invalidAnalysis(`${label} must contain at most ${maxLength} items`)
  }

  const marketContext = isObject(payload.marketContext) ? payload.marketContext : {}
  const evidenceByField = new Map([
    ...Object.entries(marketContext),
    ...payload.schema.map((field, index) => [field, row[index]]),
  ])

  return value.map((observation, index) => {
    const observationLabel = `${label} ${index}`

    assertExactKeys(observation, ["fields", "text"], observationLabel)

    if (
      !isArray(observation.fields)
      || observation.fields.length === 0
      || observation.fields.length > 3
      || observation.fields.some(field => !isString(field) || !field)
      || new Set(observation.fields).size !== observation.fields.length
    ) {
      invalidAnalysis(
        `${observationLabel} fields must contain one to three unique payload fields`,
      )
    }

    const unknownField = observation.fields.find(field => !evidenceByField.has(field))

    if (unknownField) {
      invalidAnalysis(`${observationLabel} references unknown field ${unknownField}`)
    }

    if (
      !isString(observation.text)
      || !observation.text.trim()
      || observation.text.length > 400
      || observation.text.includes("=")
    ) {
      invalidAnalysis(`${observationLabel} must contain short interpretation text`)
    }

    const evidence = observation.fields.map(field => (
      `${field}=${formatEvidenceValue(evidenceByField.get(field))}`
    ))

    return `${evidence.join(" и ")}: ${observation.text.trim()}`
  })
}

function getCandidateSymbols (payload) {
  if (!isArray(payload?.schema) || !isArray(payload?.candidates)) {
    invalidAnalysis("step 6 payload is incomplete")
  }

  const symbolIndex = payload.schema.indexOf("symbol")

  if (symbolIndex < 0) {
    invalidAnalysis("step 6 payload does not define symbol")
  }

  const symbols = payload.candidates.map(row => row?.[symbolIndex])

  if (
    symbols.some(symbol => !isString(symbol) || !symbol)
    || payload.candidateCount !== symbols.length
  ) {
    invalidAnalysis("step 6 payload contains invalid candidates")
  }

  return symbols
}

export function parseAgentAnalysis (content, payload) {
  if (!isString(content) || !content.trim()) {
    invalidAnalysis("response must be a non-empty string")
  }

  let analysis

  try {
    analysis = JSON.parse(content)
  } catch (error) {
    const details = isError(error) ? error.message : "unknown JSON error"

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

  if (!isArray(analysis.assessments) || analysis.assessments.length !== symbols.length) {
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

    assessment.drivers = normalizeObservations(
      assessment.drivers,
      3,
      payload,
      payload.candidates[index],
      `assessment ${assessment.symbol} drivers`,
    )
    assessment.counterSignals = normalizeObservations(
      assessment.counterSignals,
      2,
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

  if (!isArray(analysis.topCandidates) || analysis.topCandidates.length !== expectedTop.length) {
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
      !isString(candidate.explanation)
      || !candidate.explanation.trim()
      || candidate.explanation.length > 500
      || /\d/.test(candidate.explanation)
    ) {
      invalidAnalysis(`top candidate ${candidate.symbol} has an invalid explanation`)
    }

    const marketFields = isObject(payload.marketContext)
      ? Object.keys(payload.marketContext)
      : []
    const technicalField = [...payload.schema, ...marketFields].find(field => (
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
