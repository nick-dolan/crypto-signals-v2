import { toIsoTimestamp } from "../../helpers/normalization-helper.js"
import {
  CRYPTO_UNIVERSE_CANDIDATE_RANK_MAX,
  CRYPTO_UNIVERSE_EXCHANGE,
  CRYPTO_UNIVERSE_INSTRUMENT_TYPE,
  CRYPTO_UNIVERSE_QUOTE_SYMBOL,
  CRYPTO_UNIVERSE_TARGET_COUNT,
  CRYPTO_UNIVERSE_TYPE_SPECIFICATION,
} from "./config.js"
import {
  isStablecoin,
  normalizeUniverseCandidate,
  selectUniverseMarketsByBaseCurrencyId,
  toUniverseCoin,
  validatePositiveInteger,
  validateUniqueUniverseCandidates,
} from "./crypto-universe-helpers.js"

function normalizeCoverageExcludedBaseCurrencyIds (value) {
  if (!Array.isArray(value) && !(value instanceof Set)) {
    throw new Error("coverageExcludedBaseCurrencyIds must be an array or Set")
  }

  const normalized = new Set()

  for (const baseCurrencyId of value) {
    if (typeof baseCurrencyId !== "string" || !baseCurrencyId.trim()) {
      throw new Error("coverageExcludedBaseCurrencyIds must contain strings")
    }

    normalized.add(baseCurrencyId.trim())
  }

  return normalized
}

export function buildCryptoUniverse (
  candidates,
  markets,
  {
    candidateRankMax = CRYPTO_UNIVERSE_CANDIDATE_RANK_MAX,
    coverageExcludedBaseCurrencyIds = [],
    generatedAt = new Date().toISOString(),
    targetCount = CRYPTO_UNIVERSE_TARGET_COUNT,
  } = {},
) {
  if (!Array.isArray(candidates)) {
    throw new Error("Crypto universe candidates must be an array")
  }

  validatePositiveInteger(candidateRankMax, "candidateRankMax")
  validatePositiveInteger(targetCount, "targetCount")

  if (targetCount > candidateRankMax) {
    throw new Error("targetCount must not exceed candidateRankMax")
  }

  const normalizedCandidates = candidates.map(
    (candidate, index) => normalizeUniverseCandidate(candidate, index, candidateRankMax),
  )

  validateUniqueUniverseCandidates(normalizedCandidates)

  const excludedBaseCurrencyIds = normalizeCoverageExcludedBaseCurrencyIds(
    coverageExcludedBaseCurrencyIds,
  )
  const orderedCandidates = normalizedCandidates.sort(
    (first, second) => first.rank - second.rank,
  )
  const selectedMarkets = selectUniverseMarketsByBaseCurrencyId(markets)
  const eligibleCandidates = []
  let excludedStablecoinCount = 0
  let excludedCoverageCount = 0
  let excludedMissingMarketCount = 0

  for (const candidate of orderedCandidates) {
    if (isStablecoin(candidate)) {
      excludedStablecoinCount += 1
      continue
    }

    if (excludedBaseCurrencyIds.has(candidate.baseCurrencyId)) {
      excludedCoverageCount += 1
      continue
    }

    const market = selectedMarkets.get(candidate.baseCurrencyId)

    if (!market) {
      excludedMissingMarketCount += 1
      continue
    }

    eligibleCandidates.push({ candidate, market })
  }

  if (eligibleCandidates.length < targetCount) {
    throw new Error(
      `Crypto universe: expected ${targetCount} eligible Binance USDT perpetual coins, found ${eligibleCandidates.length}`,
    )
  }

  const coins = eligibleCandidates
    .slice(0, targetCount)
    .map(({ candidate, market }) => toUniverseCoin(candidate, market))

  return {
    generatedAt: toIsoTimestamp(generatedAt, "generatedAt"),
    source: "tradingview",
    selection: {
      exchange: CRYPTO_UNIVERSE_EXCHANGE,
      quoteSymbol: CRYPTO_UNIVERSE_QUOTE_SYMBOL,
      instrumentType: CRYPTO_UNIVERSE_INSTRUMENT_TYPE,
      typeSpecification: CRYPTO_UNIVERSE_TYPE_SPECIFICATION,
    },
    candidateCount: orderedCandidates.length,
    marketMatchedCandidateCount: eligibleCandidates.length,
    coinCount: coins.length,
    excludedStablecoinCount,
    excludedCoverageCount,
    excludedMissingMarketCount,
    unselectedEligibleCount: eligibleCandidates.length - coins.length,
    coins,
  }
}
