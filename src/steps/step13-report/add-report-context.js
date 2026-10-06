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
  const from = getTimestamp(sources?.[key]?.from, `Step 7 ${key}.from`)
  const asOf = getTimestamp(sources?.[key]?.asOf, `Step 7 ${key}.asOf`)
  const contextFrom = getTimestamp(context?.[key]?.from, `Step 8 ${key}.from`)
  const contextAsOf = getTimestamp(context?.[key]?.asOf, `Step 8 ${key}.asOf`)

  if (from > asOf || contextFrom > contextAsOf) {
    throw new Error(`${key} source window must have from <= asOf`)
  }

  if (from !== contextFrom || asOf !== contextAsOf) {
    throw new Error(`Step 7 and step 8 ${key} source windows do not match`)
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
    asOf !== getTimestamp(sources?.asOf, "Step 7 asOf")
    || asOf !== getTimestamp(context?.asOf, "Step 8 asOf")
  ) {
    throw new Error("Report, step 7 and step 8 market snapshots do not match")
  }

  getTimestamp(context.generatedAt, "Step 8 generatedAt")
  validateSourceWindow(sources, context, "newsEnrichment")
  validateSourceWindow(sources, context, "twitterEnrichment")

  if (!isArray(report.coins)) {
    throw new Error("Report coins must be an array")
  }

  const reportCandidates = indexCandidates(report.coins, "Report")
  const sourcesBySymbol = indexCandidates(sources.candidates, "Step 7")
  const contextBySymbol = indexCandidates(context.candidates, "Step 8")

  for (const [label, bySymbol] of [["Step 7", sourcesBySymbol], ["Step 8", contextBySymbol]]) {
    if (bySymbol.size !== reportCandidates.size || [...reportCandidates.keys()].some(symbol => !bySymbol.has(symbol))) {
      throw new Error(`${label} candidate set does not match the report`)
    }
  }

  const coins = report.coins.map((coin) => {
    const sourceCandidate = sourcesBySymbol.get(coin.symbol)
    const contextCandidate = contextBySymbol.get(coin.symbol)

    validateContainer(sourceCandidate.news, "items", `${coin.symbol} news`)
    validateContainer(sourceCandidate.twitter, "tweets", `${coin.symbol} twitter`)

    const socialSignal = readSocialSignal(contextCandidate)
    const summaries = Object.fromEntries(["newsSummary", "twitterSummary", "contextCaveat"].map((key) => {
      const value = contextCandidate[key]
      if (value !== null && (!isString(value) || !value.trim())) {
        throw new Error(`${coin.symbol} ${key} must be a non-empty string or null`)
      }
      return [key, value]
    }))

    for (const key of ["news", "twitter"]) {
      if (contextCandidate[`${key}Status`] !== sourceCandidate[key].status) {
        throw new Error(`${coin.symbol} ${key} status does not match its context`)
      }
    }

    return {
      ...coin,
      ...socialSignal,
      ...summaries,
      newsStatus: contextCandidate.newsStatus,
      twitterStatus: contextCandidate.twitterStatus,
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
