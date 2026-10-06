import { isArray, isError, isFinite, isObject, isString } from "../../helpers/utils.typed.js"
import { decodeAgentPayload } from "../step6-agent-payload/agent-payload-format.js"
import { formatCoinSummary, readCoinSummary } from "./coin-summary.js"

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
  return isArray(value) || isObject(value) || (isString(value) && /[:"\n\\]/.test(value))
    ? JSON.stringify(value)
    : String(value)
}

function normalizeObservations (value, maxLength, payload, candidate, label) {
  if (!isArray(value) || value.length > maxLength) {
    invalidAnalysis(`${label} must contain at most ${maxLength} items`)
  }

  const marketContext = isObject(payload.marketContext) ? payload.marketContext : {}
  const evidenceByField = new Map([
    ...Object.entries(marketContext),
    ...Object.entries(candidate),
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

function assertReadableExplanation (explanation, fields, label, allowEventNumbers = false) {
  if (
    !isString(explanation)
    || !explanation.trim()
    || explanation.length > 500
    || (!allowEventNumbers && /\d/.test(explanation))
  ) {
    invalidAnalysis(`${label} has an invalid explanation`)
  }

  const technicalField = fields.find(field => explanation.includes(field))

  if (technicalField) {
    invalidAnalysis(`${label} explanation contains ${technicalField}`)
  }
}

function normalizeSummary (candidate, fields, label, allowEventNumbers) {
  try {
    candidate.technicalSummary = readCoinSummary(candidate.technicalSummary, label)
  } catch (error) {
    invalidAnalysis(error.message)
  }

  candidate.explanation = formatCoinSummary(candidate.technicalSummary)
  assertReadableExplanation(candidate.explanation, fields, label, allowEventNumbers)
}

function readAgentPayload (payload) {
  let decoded

  try {
    decoded = decodeAgentPayload(payload)
  } catch (error) {
    invalidAnalysis(isError(error) ? error.message : "step 6 payload is incomplete")
  }

  if (payload.candidateCount !== decoded.candidates.length) {
    invalidAnalysis("step 6 payload contains invalid candidates")
  }

  return decoded
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

  if (![1, 2, 3, 4].includes(analysis.schemaVersion)) {
    invalidAnalysis("schemaVersion must equal 1, 2, 3 or 4")
  }

  if (payload.schemaVersion >= 14 && analysis.schemaVersion !== 4) {
    invalidAnalysis("growth analysis requires schemaVersion 4 with summaries for every candidate")
  }

  if (analysis.asOf !== payload.asOf) {
    invalidAnalysis("asOf does not match the agent payload")
  }

  const { fields, candidates } = readAgentPayload(payload)
  const symbols = candidates.map(candidate => candidate.symbol)
  const marketFields = isObject(payload.marketContext) ? Object.keys(payload.marketContext) : []
  const explanationFields = [...fields, ...marketFields]

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
        "drivers",
        "counterSignals",
        ...(analysis.schemaVersion === 4 ? ["technicalSummary"] : []),
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

    assessment.drivers = normalizeObservations(
      assessment.drivers,
      3,
      payload,
      candidates[index],
      `assessment ${assessment.symbol} drivers`,
    )
    assessment.counterSignals = normalizeObservations(
      assessment.counterSignals,
      2,
      payload,
      candidates[index],
      `assessment ${assessment.symbol} counterSignals`,
    )

    if (assessment.drivers.length + assessment.counterSignals.length === 0) {
      invalidAnalysis(`assessment ${assessment.symbol} must explain its estimate`)
    }

    if (analysis.schemaVersion === 4) {
      normalizeSummary(assessment, explanationFields, `assessment ${assessment.symbol} technicalSummary`, true)
    }
  })

  if (!isArray(analysis.topCandidates) || analysis.topCandidates.length > Math.min(5, symbols.length)) {
    invalidAnalysis("topCandidates has an unexpected length")
  }

  const selectedSymbols = new Set(analysis.topCandidates.map(candidate => candidate?.symbol))
  const expectedTop = analysis.assessments
    .map((assessment, index) => ({ assessment, index }))
    .filter(({ assessment }) => selectedSymbols.has(assessment.symbol))
    .sort((first, second) => (
      second.assessment.movementProbability - first.assessment.movementProbability
      || first.index - second.index
    ))

  if (analysis.topCandidates.length !== expectedTop.length) {
    invalidAnalysis("topCandidates must contain unique assessed symbols")
  }

  analysis.topCandidates.forEach((candidate, index) => {
    assertExactKeys(
      candidate,
      analysis.schemaVersion === 4
        ? ["symbol", "movementProbability"]
        : analysis.schemaVersion >= 2
          ? ["symbol", "movementProbability", "technicalSummary"]
          : ["symbol", "movementProbability", "explanation"],
      `top candidate ${index}`,
    )

    const expected = expectedTop[index].assessment

    if (
      candidate.symbol !== expected.symbol
      || candidate.movementProbability !== expected.movementProbability
    ) {
      invalidAnalysis(`top candidate ${index} does not match assessments`)
    }

    if (analysis.schemaVersion === 4) {
      candidate.technicalSummary = expected.technicalSummary
      candidate.explanation = expected.explanation
    } else if (analysis.schemaVersion >= 2) {
      normalizeSummary(candidate, explanationFields, `top candidate ${candidate.symbol} technicalSummary`, analysis.schemaVersion === 3)
    } else {
      assertReadableExplanation(candidate.explanation, explanationFields, `top candidate ${candidate.symbol}`)
    }
  })

  return analysis
}
