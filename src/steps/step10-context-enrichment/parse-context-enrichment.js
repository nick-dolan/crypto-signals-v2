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
    ["schemaVersion", "symbol", "informationBackground", "socialSignificant", "socialReason", "socialSentiment"],
  )

  if (enrichment.schemaVersion !== 2) {
    invalidEnrichment("schemaVersion must equal 2")
  }

  if (enrichment.symbol !== expectedSymbol) {
    invalidEnrichment("symbol does not match the candidate")
  }

  if (
    !isString(enrichment.informationBackground)
    || !enrichment.informationBackground.trim()
    || enrichment.informationBackground.length > 700
  ) {
    invalidEnrichment("informationBackground must be a short non-empty string")
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
    informationBackground: enrichment.informationBackground.trim(),
  }
}
