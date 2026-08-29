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

export function buildCryptoUniverse (
  candidates,
  markets,
  {
    candidateRankMax = CRYPTO_UNIVERSE_CANDIDATE_RANK_MAX,
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

  const orderedCandidates = normalizedCandidates.sort(
    (first, second) => first.rank - second.rank,
  )
  const selectedMarkets = selectUniverseMarketsByBaseCurrencyId(markets)
  const eligibleCandidates = []
  let excludedStablecoinCount = 0
  let excludedMissingMarketCount = 0

  for (const candidate of orderedCandidates) {
    if (isStablecoin(candidate)) {
      excludedStablecoinCount += 1
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
    excludedMissingMarketCount,
    unselectedEligibleCount: eligibleCandidates.length - coins.length,
    coins,
  }
}
