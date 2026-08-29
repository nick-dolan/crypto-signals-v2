import { toIsoTimestamp } from "../../helpers/normalization-helper.js"
import {
  CRYPTO_UNIVERSE_CANDIDATE_RANK_MAX,
  CRYPTO_UNIVERSE_TARGET_COUNT,
} from "./config.js"
import {
  isStablecoin,
  normalizeUniverseCandidate,
  toUniverseCoin,
  validatePositiveInteger,
  validateUniqueUniverseCandidates,
} from "./crypto-universe-helpers.js"

export function buildCryptoUniverse (
  candidates,
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
  const coins = []
  let excludedStablecoinCount = 0

  for (const candidate of orderedCandidates) {
    if (coins.length === targetCount) {
      break
    }

    if (isStablecoin(candidate)) {
      excludedStablecoinCount += 1
      continue
    }

    coins.push(toUniverseCoin(candidate))
  }

  if (coins.length !== targetCount) {
    throw new Error(
      `Crypto universe: expected ${targetCount} eligible coins, found ${coins.length}`,
    )
  }

  return {
    generatedAt: toIsoTimestamp(generatedAt, "generatedAt"),
    source: "tradingview",
    coinCount: coins.length,
    excludedStablecoinCount,
    coins,
  }
}
