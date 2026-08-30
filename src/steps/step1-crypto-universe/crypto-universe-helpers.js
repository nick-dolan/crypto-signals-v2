import { getRequiredString, parseInteger } from "../../helpers/normalization-helper.js"

export function validatePositiveInteger (value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`)
  }
}

function normalizeOptionalPositiveNumber (value, fieldName) {
  if (value === null || value === undefined) {
    return null
  }

  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${fieldName} must be a positive number`)
  }

  return value
}

function getCandidateFieldName (index, field) {
  return `Crypto universe candidate at index ${index} ${field}`
}

function normalizeCandidateCategories (value, index) {
  if (!Array.isArray(value)) {
    throw new Error(`${getCandidateFieldName(index, "categories")} must be an array`)
  }

  return value.map((category, categoryIndex) => getRequiredString(
    category,
    getCandidateFieldName(index, `categories[${categoryIndex}]`),
  ))
}

export function normalizeUniverseCandidate (candidate, index, candidateRankMax) {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    throw new Error(`Crypto universe candidate at index ${index} must be an object`)
  }

  const rank = parseInteger(
    candidate.rank,
    getCandidateFieldName(index, "rank"),
  )

  if (rank < 1 || rank > candidateRankMax) {
    throw new Error(
      `${getCandidateFieldName(index, "rank")} must be between 1 and ${candidateRankMax}`,
    )
  }

  return {
    rank,
    baseCurrencyId: getRequiredString(
      candidate.baseCurrencyId,
      getCandidateFieldName(index, "baseCurrencyId"),
    ),
    symbol: getRequiredString(
      candidate.symbol,
      getCandidateFieldName(index, "symbol"),
    ),
    name: getRequiredString(
      candidate.name,
      getCandidateFieldName(index, "name"),
    ),
    tradingViewSymbol: getRequiredString(
      candidate.tradingViewSymbol,
      getCandidateFieldName(index, "tradingViewSymbol"),
    ),
    categories: normalizeCandidateCategories(candidate.categories, index),
    circulatingSupply: normalizeOptionalPositiveNumber(
      candidate.circulatingSupply,
      getCandidateFieldName(index, "circulatingSupply"),
    ),
    marketCap: normalizeOptionalPositiveNumber(
      candidate.marketCap,
      getCandidateFieldName(index, "marketCap"),
    ),
    fullyDilutedValuation: normalizeOptionalPositiveNumber(
      candidate.fullyDilutedValuation,
      getCandidateFieldName(index, "fullyDilutedValuation"),
    ),
  }
}

export function validateUniqueUniverseCandidates (candidates) {
  const ranks = new Set()
  const baseCurrencyIds = new Set()

  for (const candidate of candidates) {
    if (ranks.has(candidate.rank)) {
      throw new Error(`Crypto universe contains duplicate rank: ${candidate.rank}`)
    }

    if (baseCurrencyIds.has(candidate.baseCurrencyId)) {
      throw new Error(
        `Crypto universe contains duplicate baseCurrencyId: ${candidate.baseCurrencyId}`,
      )
    }

    ranks.add(candidate.rank)
    baseCurrencyIds.add(candidate.baseCurrencyId)
  }
}

export function isStablecoin (candidate) {
  return candidate.categories.some(
    category => category.toLowerCase() === "stablecoins",
  )
}

function isRequiredMarket (market) {
  return market?.exchange === "BINANCE"
    && market?.quoteSymbol === "USDT"
    && market?.instrumentType === "swap"
    && Array.isArray(market?.typeSpecifications)
    && market.typeSpecifications.some(specification => (
      typeof specification === "string"
      && specification.toLowerCase() === "perpetual"
    ))
    && Number.isFinite(market?.volume24hUsd)
    && market.volume24hUsd > 0
}

export function selectUniverseMarketsByBaseCurrencyId (markets) {
  if (!Array.isArray(markets)) {
    throw new Error("Crypto universe markets must be an array")
  }

  const selectedMarkets = new Map()

  for (const market of markets) {
    if (
      !isRequiredMarket(market)
      || typeof market.baseCurrencyId !== "string"
      || !market.baseCurrencyId.trim()
    ) {
      continue
    }

    const selected = selectedMarkets.get(market.baseCurrencyId)

    if (!selected || market.volume24hUsd > selected.volume24hUsd) {
      selectedMarkets.set(market.baseCurrencyId, market)
    }
  }

  return selectedMarkets
}

function toUniverseMarket (market) {
  return {
    tradingViewSymbol: market.tradingViewSymbol,
    symbol: market.symbol,
    baseSymbol: market.baseSymbol,
    baseCurrencyId: market.baseCurrencyId,
    quoteSymbol: market.quoteSymbol,
    exchange: market.exchange,
    price: market.price,
    volume24hUsd: market.volume24hUsd,
    instrumentType: market.instrumentType,
    typeSpecifications: [...market.typeSpecifications],
  }
}

export function toUniverseCoin (candidate, market) {
  return {
    rank: candidate.rank,
    baseCurrencyId: candidate.baseCurrencyId,
    symbol: candidate.symbol,
    name: candidate.name,
    tradingViewSymbol: candidate.tradingViewSymbol,
    categories: [...candidate.categories],
    circulatingSupply: candidate.circulatingSupply,
    marketCap: candidate.marketCap,
    fullyDilutedValuation: candidate.fullyDilutedValuation,
    market: toUniverseMarket(market),
  }
}
