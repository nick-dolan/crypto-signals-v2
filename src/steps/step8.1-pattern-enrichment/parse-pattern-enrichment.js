import { isObject, isString } from "../../helpers/utils.typed.js"

export class InvalidPatternEnrichmentError extends Error {
  constructor (message) {
    super(`Invalid pattern enrichment: ${message}`)
    this.name = "InvalidPatternEnrichmentError"
  }
}

function readText (value, field, limit) {
  if (value === null) {
    return null
  }
  if (!isString(value) || !value.trim() || value.trim().length > limit) {
    throw new InvalidPatternEnrichmentError(`${field} must be non-empty text up to ${limit} characters or null`)
  }
  return value.trim()
}

export function parsePatternEnrichment (content, expectedSymbol) {
  if (!isString(content) || !content.trim()) {
    throw new InvalidPatternEnrichmentError("response must be non-empty text")
  }
  let response
  try {
    response = JSON.parse(content.trim().replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/i, "$1"))
  } catch {
    throw new InvalidPatternEnrichmentError("response must be valid JSON")
  }
  if (!isObject(response) || Object.keys(response).length !== 3
    || !["symbol", "summary", "caveat"].every(key => Object.hasOwn(response, key))) {
    throw new InvalidPatternEnrichmentError("response must contain exactly symbol, summary and caveat")
  }
  if (response.symbol !== expectedSymbol) {
    throw new InvalidPatternEnrichmentError("symbol does not match the candidate")
  }
  const summary = readText(response.summary, "summary", 600)
  const caveat = readText(response.caveat, "caveat", 300)
  if (summary === null && caveat === null) {
    throw new InvalidPatternEnrichmentError("unavailable image analysis requires a caveat")
  }
  return { summary, caveat }
}
