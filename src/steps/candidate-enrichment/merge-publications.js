import { getRequiredString } from "../../helpers/normalization-helper.js"
import { isArray, isFinite, isObject, isString } from "../../helpers/utils.typed.js"

function indexCandidates (input, label) {
  if (!isObject(input) || !isArray(input.candidates)) {
    throw new Error(`${label} candidates are required`)
  }

  const bySymbol = new Map()
  for (const candidate of input.candidates) {
    const symbol = getRequiredString(candidate?.symbol, `${label} candidate symbol`).toUpperCase()
    if (bySymbol.has(symbol)) {
      throw new Error(`${label} candidates contain duplicate symbol ${symbol}`)
    }
    bySymbol.set(symbol, candidate)
  }
  return bySymbol
}

export function createTwitterInput (shortlist) {
  if (!isArray(shortlist?.candidates)) {
    throw new Error("Step 5 candidates are required")
  }
  if (!isString(shortlist.asOf) || !isFinite(Date.parse(shortlist.asOf))) {
    throw new Error("Step 5 asOf must be a valid timestamp")
  }

  const input = {
    asOf: shortlist.asOf,
    candidates: shortlist.candidates.map(({ coin }) => ({
      symbol: getRequiredString(coin?.symbol, "Step 5 candidate symbol"),
      ...(isString(coin?.name) && coin.name.trim() ? { name: coin.name.trim() } : {}),
    })),
  }
  indexCandidates(input, "Step 5")
  return input
}

export function validatePublicationOutput (shortlist, output, source, referenceTimestamp) {
  const expected = indexCandidates(createTwitterInput(shortlist), "Step 5")
  const actual = indexCandidates(output, source)
  if (expected.size !== actual.size || [...expected.keys()].some(symbol => !actual.has(symbol))) {
    throw new Error(`Step 5 and ${source} candidate sets must match`)
  }
  if (output.asOf !== shortlist.asOf) {
    throw new Error(`Step 5 and ${source} market snapshots must match`)
  }

  const window = output[`${source}Enrichment`]
  if (!isObject(window)
    || window.asOf !== new Date(referenceTimestamp * 1_000).toISOString()
    || window.from !== new Date((referenceTimestamp - 24 * 60 * 60) * 1_000).toISOString()
    || window.lookbackHours !== 24) {
    throw new Error(`${source} publication window must match the combined referenceTimestamp`)
  }

  for (const [symbol, candidate] of actual) {
    const publications = candidate[source]
    if (!isObject(publications)
      || !["available", "empty", "failed"].includes(publications.status)
      || !isArray(publications[source === "news" ? "items" : "tweets"])) {
      throw new Error(`${source} candidate ${symbol} publications are required`)
    }
  }
  return actual
}

export function mergePublicationEnrichment (shortlist, news, twitter, referenceTimestamp) {
  validatePublicationOutput(shortlist, news, "news", referenceTimestamp)
  const twitterBySymbol = validatePublicationOutput(shortlist, twitter, "twitter", referenceTimestamp)
  return {
    ...news,
    schemaVersion: 6,
    generatedAt: twitter.generatedAt,
    twitterEnrichment: twitter.twitterEnrichment,
    candidates: news.candidates.map(candidate => ({
      ...candidate,
      twitter: twitterBySymbol.get(candidate.symbol.toUpperCase()).twitter,
    })),
  }
}
