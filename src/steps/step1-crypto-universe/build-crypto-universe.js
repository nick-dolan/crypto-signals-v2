import { getRequiredString, parseInteger, toIsoTimestamp } from "../../helpers/normalization-helper.js"
import {
  CRYPTO_UNIVERSE_CANDIDATE_RANK_MAX,
  CRYPTO_UNIVERSE_TARGET_COUNT,
} from "./config.js"

function validatePositiveInteger (value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`)
  }
}

function getCandidateFieldName (index, field) {
  return `Crypto universe candidate at index ${index} ${field}`
}

function normalizeCategories (value, index) {
  if (!Array.isArray(value)) {
    throw new Error(`${getCandidateFieldName(index, "categories")} must be an array`)
  }

  return value.map((category, categoryIndex) => getRequiredString(
    category,
    getCandidateFieldName(index, `categories[${categoryIndex}]`),
  ))
}

function normalizeOptionalPositiveNumber (value, index, field) {
  if (value === null || value === undefined) {
    return null
  }

  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(
      `${getCandidateFieldName(index, field)} must be a positive number`,
    )
  }

  return value
}

function normalizeCandidate (candidate, index, candidateRankMax) {
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
    categories: normalizeCategories(candidate.categories, index),
    circulatingSupply: normalizeOptionalPositiveNumber(
      candidate.circulatingSupply,
      index,
      "circulatingSupply",
    ),
    marketCap: normalizeOptionalPositiveNumber(
      candidate.marketCap,
      index,
      "marketCap",
    ),
    fullyDilutedValuation: normalizeOptionalPositiveNumber(
      candidate.fullyDilutedValuation,
      index,
      "fullyDilutedValuation",
    ),
  }
}

function validateUniqueCandidates (candidates) {
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

function isStablecoin (candidate) {
  return candidate.categories.some(
    category => category.toLowerCase() === "stablecoins",
  )
}

function toUniverseCoin (candidate) {
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
  }
}

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
    (candidate, index) => normalizeCandidate(candidate, index, candidateRankMax),
  )

  validateUniqueCandidates(normalizedCandidates)

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
