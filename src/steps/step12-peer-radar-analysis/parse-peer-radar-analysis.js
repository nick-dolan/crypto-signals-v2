import { isArray, isError, isObject, isString } from "../../helpers/utils.typed.js"

export class InvalidPeerRadarAnalysisError extends Error {
  constructor (message) {
    super(`Invalid peer radar analysis: ${message}`)
    this.name = "InvalidPeerRadarAnalysisError"
  }
}

function invalidAnalysis (message) {
  throw new InvalidPeerRadarAnalysisError(message)
}

function assertExactKeys (value, expectedKeys, label) {
  if (!isObject(value)) {
    invalidAnalysis(`${label} must be an object`)
  }

  const actual = Object.keys(value).sort()
  const expected = [...expectedKeys].sort()

  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    invalidAnalysis(`${label} has an unexpected structure`)
  }
}

export function parsePeerRadarAnalysis (content, payload) {
  if (!isString(content) || !content.trim()) {
    invalidAnalysis("response must be a non-empty string")
  }

  let analysis

  try {
    analysis = JSON.parse(content)
  } catch (error) {
    invalidAnalysis(`response is not valid JSON: ${isError(error) ? error.message : "unknown JSON error"}`)
  }

  assertExactKeys(analysis, ["schemaVersion", "asOf", "observations"], "response")

  if (analysis.schemaVersion !== 1) {
    invalidAnalysis("schemaVersion must equal 1")
  }

  if (analysis.asOf !== payload.asOf) {
    invalidAnalysis("asOf does not match the peer scan")
  }

  if (!isArray(analysis.observations) || analysis.observations.length !== payload.candidates.length) {
    invalidAnalysis("observations must contain every candidate exactly once")
  }

  const expectedIds = new Set(payload.candidates.map(candidate => candidate.coin.baseCurrencyId))
  const seenIds = new Set()

  for (const observation of analysis.observations) {
    assertExactKeys(observation, ["baseCurrencyId", "verdict", "explanation", "caveats"], "observation")

    if (!isString(observation.baseCurrencyId) || !observation.baseCurrencyId.trim()) {
      invalidAnalysis("baseCurrencyId must be a non-empty string")
    }

    if (!expectedIds.has(observation.baseCurrencyId)) {
      invalidAnalysis(`unknown candidate ID ${observation.baseCurrencyId}`)
    }

    if (seenIds.has(observation.baseCurrencyId)) {
      invalidAnalysis(`duplicate candidate ID ${observation.baseCurrencyId}`)
    }

    if (!["watch", "limited"].includes(observation.verdict)) {
      invalidAnalysis(`candidate ${observation.baseCurrencyId} has an invalid verdict`)
    }

    if (!isString(observation.explanation) || !observation.explanation.trim()) {
      invalidAnalysis(`candidate ${observation.baseCurrencyId} needs a non-empty explanation`)
    }

    if (
      !isArray(observation.caveats)
      || observation.caveats.some(caveat => !isString(caveat) || !caveat.trim())
    ) {
      invalidAnalysis(`candidate ${observation.baseCurrencyId} caveats must be an array of non-empty strings`)
    }

    seenIds.add(observation.baseCurrencyId)
  }

  return analysis
}
