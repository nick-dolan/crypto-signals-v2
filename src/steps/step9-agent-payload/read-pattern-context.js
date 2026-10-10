import { isArray, isFinite, isObject, isSafeInteger, isString } from "../../helpers/utils.typed.js"

function isText (value) {
  return isString(value) && value.trim().length > 0
}

function isTimestamp (value) {
  return isString(value) && isFinite(Date.parse(value))
}

function readSource (value, asOf) {
  if (
    !isObject(value)
    || value.source !== "github-copilot-sdk"
    || !isText(value.model)
    || (value.reasoningEffort !== null && !isText(value.reasoningEffort))
    || value.lookbackHours !== 168
    || !isSafeInteger(value.candidateCallCount)
    || value.candidateCallCount < 0
  ) {
    throw new Error("Step 8.1 patternEnrichment source, model, reasoningEffort, lookbackHours or candidateCallCount is invalid")
  }

  if (
    ![value.from, value.to].every(isTimestamp)
    || Date.parse(value.from) !== Date.parse(asOf) - 167 * 3_600_000
    || Date.parse(value.to) !== Date.parse(asOf) + 3_600_000
  ) {
    throw new Error("Step 8.1 patternEnrichment must cover the last 168 closed 1h candles: from = asOf - 167h, to = asOf + 1h")
  }

  return {
    source: value.source,
    model: value.model,
    reasoningEffort: value.reasoningEffort,
    lookbackHours: value.lookbackHours,
    from: value.from,
    to: value.to,
  }
}

function validateCandidate (candidate) {
  if (!isObject(candidate) || !isText(candidate.symbol)) {
    throw new Error("Step 8.1 candidate must have a symbol")
  }

  if (!["available", "unavailable"].includes(candidate.status)) {
    throw new Error(`Step 8.1 ${candidate.symbol} status is invalid`)
  }

  if (candidate.status === "available" ? !isText(candidate.summary) : candidate.summary !== null) {
    throw new Error(`Step 8.1 ${candidate.symbol} summary must be non-empty when available and null when unavailable`)
  }

  if (candidate.caveat !== null && !isText(candidate.caveat)) {
    throw new Error(`Step 8.1 ${candidate.symbol} caveat must be a non-empty string or null`)
  }

  if (candidate.status === "unavailable" && candidate.caveat === null) {
    throw new Error(`Step 8.1 ${candidate.symbol} unavailable context requires a caveat`)
  }
}

export function readPatternContext (shortlist, patterns = null) {
  if (patterns === null) {
    return { source: null, bySymbol: new Map() }
  }

  if (!isObject(patterns) || patterns.schemaVersion !== 1 || !isArray(patterns.candidates)) {
    throw new Error("Step 8.1 pattern context must be a schemaVersion 1 report with candidates")
  }

  if (
    !isTimestamp(patterns.asOf)
    || patterns.asOf !== shortlist.asOf
    || patterns.timeframe !== "1h"
    || patterns.timeframe !== shortlist.timeframe
  ) {
    throw new Error("Steps 5 and 8.1 market snapshots and timeframes must match (1h)")
  }

  if (!isTimestamp(patterns.generatedAt)) {
    throw new Error("Step 8.1 generatedAt must be a valid timestamp")
  }

  if (
    patterns.candidateCount !== shortlist.candidateCount
    || patterns.candidateCount !== patterns.candidates.length
  ) {
    throw new Error("Steps 5 and 8.1 candidate counts must match the report length")
  }

  const source = readSource(patterns.patternEnrichment, patterns.asOf)
  const bySymbol = new Map()

  for (const candidate of patterns.candidates) {
    validateCandidate(candidate)

    if (bySymbol.has(candidate.symbol)) {
      throw new Error(`Step 8.1 candidates contain duplicate symbol ${candidate.symbol}`)
    }

    bySymbol.set(candidate.symbol, candidate)
  }

  if (
    bySymbol.size !== shortlist.candidates.length
    || new Set(shortlist.candidates.map(candidate => candidate.coin.symbol)).size !== bySymbol.size
    || shortlist.candidates.some(candidate => !bySymbol.has(candidate.coin.symbol))
  ) {
    throw new Error("Steps 5 and 8.1 candidate sets must match")
  }

  return { source, bySymbol }
}
