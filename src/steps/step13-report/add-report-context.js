import { readSocialSignal } from "../../helpers/social-signal-helper.js"
import { isArray, isFinite, isObject, isString } from "../../helpers/utils.typed.js"

function getTimestamp (value, label) {
  if (!isString(value) || !isFinite(Date.parse(value))) {
    throw new Error(`${label} must be a valid timestamp`)
  }

  return Date.parse(value)
}

function indexCandidates (candidates, label) {
  if (!isArray(candidates)) {
    throw new Error(`${label} candidates must be an array`)
  }

  const bySymbol = new Map()

  for (const candidate of candidates) {
    const symbol = candidate?.symbol

    if (!isString(symbol) || !symbol.trim()) {
      throw new Error(`${label} candidate has an invalid symbol`)
    }

    if (bySymbol.has(symbol)) {
      throw new Error(`${label} candidates contain duplicate symbol ${symbol}`)
    }

    bySymbol.set(symbol, candidate)
  }

  return bySymbol
}

function validateSourceWindow (sources, context, key) {
  const from = getTimestamp(sources?.[key]?.from, `Step 9 ${key}.from`)
  const asOf = getTimestamp(sources?.[key]?.asOf, `Step 9 ${key}.asOf`)
  const contextFrom = getTimestamp(context?.[key]?.from, `Step 10 ${key}.from`)
  const contextAsOf = getTimestamp(context?.[key]?.asOf, `Step 10 ${key}.asOf`)

  if (from > asOf || contextFrom > contextAsOf) {
    throw new Error(`${key} source window must have from <= asOf`)
  }

  if (from !== contextFrom || asOf !== contextAsOf) {
    throw new Error(`Step 9 and step 10 ${key} source windows do not match`)
  }
}

function validateContainer (container, itemsKey, label) {
  if (
    !isObject(container)
    || !["available", "empty", "failed"].includes(container.status)
    || !isArray(container[itemsKey])
  ) {
    throw new Error(`${label} must have an available, empty or failed status and a ${itemsKey} array`)
  }
}

export function addReportContext (report, sources, context) {
  const asOf = getTimestamp(report?.asOf, "Report asOf")

  if (
    asOf !== getTimestamp(sources?.asOf, "Step 9 asOf")
    || asOf !== getTimestamp(context?.asOf, "Step 10 asOf")
  ) {
    throw new Error("Report, step 9 and step 10 market snapshots do not match")
  }

  getTimestamp(context.generatedAt, "Step 10 generatedAt")
  validateSourceWindow(sources, context, "newsEnrichment")
  validateSourceWindow(sources, context, "twitterEnrichment")

  if (!isArray(report.coins)) {
    throw new Error("Report coins must be an array")
  }

  const reportCandidates = indexCandidates(
    report.coins.filter(coin => coin.topRank != null || coin.features?.coingeckoTrending === true), "Report",
  )
  const sourcesBySymbol = indexCandidates(sources.candidates, "Step 9")
  const contextBySymbol = indexCandidates(context.candidates, "Step 10")

  for (const [label, bySymbol] of [["Step 9", sourcesBySymbol], ["Step 10", contextBySymbol]]) {
    if (bySymbol.size !== reportCandidates.size || [...reportCandidates.keys()].some(symbol => !bySymbol.has(symbol))) {
      throw new Error(`${label} candidate set does not match the report`)
    }
  }

  const coins = report.coins.map((coin) => {
    if (!reportCandidates.has(coin.symbol)) {
      return coin
    }

    const sourceCandidate = sourcesBySymbol.get(coin.symbol)
    const contextCandidate = contextBySymbol.get(coin.symbol)

    if (sourceCandidate.explanation !== coin.explanation || contextCandidate.explanation !== coin.explanation) {
      throw new Error(`${coin.symbol} base explanation does not match the report`)
    }

    if (!isString(contextCandidate.enrichedExplanation) || !contextCandidate.enrichedExplanation.trim()) {
      throw new Error(`${coin.symbol} enrichedExplanation must be a non-empty string`)
    }

    validateContainer(sourceCandidate.news, "items", `${coin.symbol} news`)
    validateContainer(sourceCandidate.twitter, "tweets", `${coin.symbol} twitter`)

    return {
      ...coin,
      ...readSocialSignal(contextCandidate),
      explanation: contextCandidate.enrichedExplanation,
      information: { news: sourceCandidate.news, twitter: sourceCandidate.twitter },
    }
  })

  return {
    ...report,
    informationSources: {
      news: sources.newsEnrichment,
      twitter: sources.twitterEnrichment,
      contextGeneratedAt: context.generatedAt,
    },
    coins,
  }
}
