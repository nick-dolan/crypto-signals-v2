import { readSocialSignal } from "../../helpers/social-signal-helper.js"
import { isError, isObject, isString } from "../../helpers/utils.typed.js"

export class InvalidContextEnrichmentError extends Error {
  constructor (message) {
    super(`Invalid context enrichment: ${message}`)
    this.name = "InvalidContextEnrichmentError"
  }
}

function invalidEnrichment (message) {
  throw new InvalidContextEnrichmentError(message)
}

function assertExactKeys (value, expectedKeys) {
  if (!isObject(value)) {
    invalidEnrichment("response must be an object")
  }

  const actual = Object.keys(value).sort()
  const expected = [...expectedKeys].sort()

  if (
    actual.length !== expected.length
    || actual.some((key, index) => key !== expected[index])
  ) {
    invalidEnrichment("response has an unexpected structure")
  }
}

function readSummary (value, field) {
  if (value === null) {
    return null
  }

  if (!isString(value) || !value.trim()) {
    invalidEnrichment(`${field} must be a non-empty string or null`)
  }

  return value.trim()
}

export function parseContextEnrichment (content, expectedSymbol) {
  if (!isString(content) || !content.trim()) {
    invalidEnrichment("response must be a non-empty string")
  }

  const json = content.trim().replace(
    /^```(?:json)?\s*([\s\S]*?)\s*```$/i,
    "$1",
  )
  let enrichment

  try {
    enrichment = JSON.parse(json)
  } catch (error) {
    const details = isError(error) ? error.message : "unknown JSON error"

    invalidEnrichment(`response is not valid JSON: ${details}`)
  }

  assertExactKeys(
    enrichment,
    [
      "schemaVersion", "symbol", "socialSignificant", "socialReason", "socialSentiment",
      "newsSummary", "twitterSummary", "contextCaveat",
    ],
  )

  if (enrichment.schemaVersion !== 4) {
    invalidEnrichment("schemaVersion must equal 4")
  }

  if (enrichment.symbol !== expectedSymbol) {
    invalidEnrichment("symbol does not match the candidate")
  }

  if (enrichment.socialSentiment !== null
    && !["bullish", "bearish", "mixed", "neutral"].includes(enrichment.socialSentiment)) {
    invalidEnrichment("socialSentiment must be bullish, bearish, mixed, neutral or null")
  }

  if (enrichment.socialSignificant === false && enrichment.socialSentiment === null) {
    invalidEnrichment("socialSentiment is required for assessed publications, including noise")
  }

  let socialSignal

  try {
    socialSignal = readSocialSignal(enrichment)
  } catch (error) {
    invalidEnrichment(isError(error) ? error.message : "invalid social signal")
  }

  return {
    ...enrichment,
    ...socialSignal,
    newsSummary: readSummary(enrichment.newsSummary, "newsSummary"),
    twitterSummary: readSummary(enrichment.twitterSummary, "twitterSummary"),
    contextCaveat: readSummary(enrichment.contextCaveat, "contextCaveat"),
  }
}
