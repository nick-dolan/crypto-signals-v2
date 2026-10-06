import { isArray, isBoolean, isFinite, isObject, isString } from "../../helpers/utils.typed.js"

function readWindow (value, label) {
  if (
    !isObject(value)
    || ![value.from, value.asOf].every(timestamp => isString(timestamp) && isFinite(Date.parse(timestamp)))
    || Date.parse(value.from) > Date.parse(value.asOf)
  ) {
    throw new Error(`Step 8 ${label} must contain a valid publication window`)
  }

  return { from: value.from, asOf: value.asOf }
}

function validateCandidate (candidate) {
  if (!isString(candidate?.symbol) || !candidate.symbol.trim()) {
    throw new Error("Step 8 candidate must have a symbol")
  }

  for (const source of ["news", "twitter"]) {
    if (!["available", "empty", "failed"].includes(candidate[`${source}Status`])) {
      throw new Error(`Step 8 ${candidate.symbol} ${source}Status is invalid`)
    }
  }

  for (const field of ["newsSummary", "twitterSummary", "socialReason", "contextCaveat"]) {
    if (candidate[field] !== null && (!isString(candidate[field]) || !candidate[field].trim())) {
      throw new Error(`Step 8 ${candidate.symbol} ${field} must be a non-empty string or null`)
    }
  }

  if (candidate.socialSignificant !== null && !isBoolean(candidate.socialSignificant)) {
    throw new Error(`Step 8 ${candidate.symbol} socialSignificant must be true, false or null`)
  }

  if (candidate.socialSignificant !== null
    ? !["bullish", "bearish", "mixed", "neutral"].includes(candidate.socialSentiment)
    : candidate.socialSentiment !== null) {
    throw new Error(`Step 8 ${candidate.symbol} socialSentiment does not match its significance`)
  }
}

export function readInformationContext (shortlist, context) {
  if (context === undefined) {
    return { windows: { news: null, twitter: null }, bySymbol: new Map() }
  }

  if (!isObject(context) || !isArray(context.candidates)) {
    throw new Error("Step 8 information context candidates are required")
  }

  if (!isString(context.asOf) || !isFinite(Date.parse(context.asOf)) || context.asOf !== shortlist.asOf) {
    throw new Error("Steps 5 and 8 market snapshots must match")
  }

  const windows = {
    news: readWindow(context.newsEnrichment, "newsEnrichment"),
    twitter: readWindow(context.twitterEnrichment, "twitterEnrichment"),
  }
  const bySymbol = new Map()

  for (const candidate of context.candidates) {
    validateCandidate(candidate)

    if (bySymbol.has(candidate.symbol)) {
      throw new Error(`Step 8 candidates contain duplicate symbol ${candidate.symbol}`)
    }

    bySymbol.set(candidate.symbol, candidate)
  }

  if (
    bySymbol.size !== shortlist.candidates.length
    || new Set(shortlist.candidates.map(candidate => candidate.coin.symbol)).size !== bySymbol.size
    || shortlist.candidates.some(candidate => !bySymbol.has(candidate.coin.symbol))
  ) {
    throw new Error("Steps 5 and 8 candidate sets must match")
  }

  return { windows, bySymbol }
}
