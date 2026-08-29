import { toIsoTimestamp } from "../../helpers/normalization-helper.js"
import {
  DATA_COVERAGE_MAX_ATTEMPTS,
  DATA_COVERAGE_TARGET_COUNT,
} from "./config.js"

const SELECTION_FIELDS = Object.freeze([
  "exchange",
  "quoteSymbol",
  "instrumentType",
  "typeSpecification",
])

function validatePositiveInteger (value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`)
  }
}

function validatePositiveNumber (value, fieldName) {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${fieldName} must be a positive number`)
  }
}

function getRequiredString (value, fieldName) {
  const normalizedValue = typeof value === "string" ? value.trim() : ""

  if (!normalizedValue) {
    throw new Error(`${fieldName} is required`)
  }

  return normalizedValue
}

function normalizeSelection (selection) {
  if (!selection || typeof selection !== "object" || Array.isArray(selection)) {
    throw new Error("Crypto universe selection is required")
  }

  return Object.fromEntries(SELECTION_FIELDS.map(field => [
    field,
    getRequiredString(selection[field], `Crypto universe selection ${field}`),
  ]))
}

function validateCandidateMarket (candidate, index, selection) {
  const market = candidate.market
  const fieldName = `Crypto universe candidate at index ${index} market`

  if (!market || typeof market !== "object" || Array.isArray(market)) {
    throw new Error(`${fieldName} is required`)
  }

  getRequiredString(market.tradingViewSymbol, `${fieldName} tradingViewSymbol`)
  getRequiredString(market.symbol, `${fieldName} symbol`)
  getRequiredString(market.baseSymbol, `${fieldName} baseSymbol`)
  getRequiredString(market.baseCurrencyId, `${fieldName} baseCurrencyId`)
  getRequiredString(market.quoteSymbol, `${fieldName} quoteSymbol`)
  getRequiredString(market.exchange, `${fieldName} exchange`)
  getRequiredString(market.instrumentType, `${fieldName} instrumentType`)
  validatePositiveNumber(market.price, `${fieldName} price`)
  validatePositiveNumber(market.volume24hUsd, `${fieldName} volume24hUsd`)

  if (
    !Array.isArray(market.typeSpecifications)
    || market.typeSpecifications.some(specification => (
      typeof specification !== "string" || !specification.trim()
    ))
  ) {
    throw new Error(`${fieldName} typeSpecifications must be an array of strings`)
  }

  if (market.baseCurrencyId !== candidate.baseCurrencyId) {
    throw new Error(`${fieldName} baseCurrencyId does not match its coin`)
  }

  if (
    market.exchange !== selection.exchange
    || market.quoteSymbol !== selection.quoteSymbol
    || market.instrumentType !== selection.instrumentType
    || !market.typeSpecifications.includes(selection.typeSpecification)
  ) {
    throw new Error(`${fieldName} does not match crypto universe selection`)
  }
}

function validateCandidates (candidates, selection) {
  if (!Array.isArray(candidates)) {
    throw new Error("Crypto universe candidates must be an array")
  }

  const ranks = new Set()
  const baseCurrencyIds = new Set()
  const marketSymbols = new Set()

  for (const [index, candidate] of candidates.entries()) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      throw new Error(`Crypto universe candidate at index ${index} must be an object`)
    }

    if (!Number.isSafeInteger(candidate.rank) || candidate.rank <= 0) {
      throw new Error(`Crypto universe candidate at index ${index} rank is invalid`)
    }

    getRequiredString(
      candidate.baseCurrencyId,
      `Crypto universe candidate at index ${index} baseCurrencyId`,
    )
    validateCandidateMarket(candidate, index, selection)

    if (ranks.has(candidate.rank)) {
      throw new Error(`Crypto universe contains duplicate rank: ${candidate.rank}`)
    }

    if (baseCurrencyIds.has(candidate.baseCurrencyId)) {
      throw new Error(
        `Crypto universe contains duplicate baseCurrencyId: ${candidate.baseCurrencyId}`,
      )
    }

    if (marketSymbols.has(candidate.market.tradingViewSymbol)) {
      throw new Error(
        `Crypto universe contains duplicate market: ${candidate.market.tradingViewSymbol}`,
      )
    }

    ranks.add(candidate.rank)
    baseCurrencyIds.add(candidate.baseCurrencyId)
    marketSymbols.add(candidate.market.tradingViewSymbol)
  }
}

function normalizeSourceUniverse (sourceUniverse) {
  if (!sourceUniverse || typeof sourceUniverse !== "object" || Array.isArray(sourceUniverse)) {
    throw new Error("Source crypto universe must be an object")
  }

  const source = getRequiredString(sourceUniverse.source, "Crypto universe source")
  const selection = normalizeSelection(sourceUniverse.selection)

  validateCandidates(sourceUniverse.coins, selection)

  return {
    source,
    selection,
    candidates: sourceUniverse.coins,
  }
}

function getErrorMessage (error) {
  return error instanceof Error ? error.message : String(error)
}

function createFailedCheckResult (error) {
  const message = getErrorMessage(error)

  return {
    complete: false,
    retryable: true,
    reasonCodes: ["coverage:request_failed"],
    reasons: [`Coverage request failed: ${message}`],
    coverage: null,
  }
}

async function checkWithRetry (
  checkCoverage,
  coin,
  maxAttempts,
  onProgress,
) {
  let result

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      result = await checkCoverage(coin, attempt)
    } catch (error) {
      result = createFailedCheckResult(error)
    }

    if (result?.complete || !result?.retryable || attempt === maxAttempts) {
      return {
        attempts: attempt,
        result,
      }
    }

    onProgress({
      status: "retrying",
      coin,
      market: coin.market,
      attempt,
      result,
    })
  }

  throw new Error("Coverage retry loop ended unexpectedly")
}

function toPublicMarket (market) {
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

function createCoverageRejection (coin, attempts, result) {
  return {
    ...coin,
    market: toPublicMarket(coin.market),
    attempts,
    reasonCodes: Array.isArray(result?.reasonCodes)
      ? [...result.reasonCodes]
      : ["coverage:invalid_result"],
    reasons: Array.isArray(result?.reasons)
      ? [...result.reasons]
      : ["Coverage check returned an invalid result"],
    coverage: result?.coverage ?? null,
  }
}

function summarizeRejections (rejected) {
  const summary = {}

  for (const rejection of rejected) {
    for (const reasonCode of rejection.reasonCodes) {
      summary[reasonCode] = (summary[reasonCode] ?? 0) + 1
    }
  }

  return Object.fromEntries(
    Object.entries(summary).sort((first, second) => (
      second[1] - first[1] || first[0].localeCompare(second[0])
    )),
  )
}

export async function buildCompleteCryptoUniverse (
  sourceUniverse,
  checkCoverage,
  {
    generatedAt = new Date().toISOString(),
    maxAttempts = DATA_COVERAGE_MAX_ATTEMPTS,
    onProgress = () => {},
    targetCount = DATA_COVERAGE_TARGET_COUNT,
  } = {},
) {
  const { source, selection, candidates } = normalizeSourceUniverse(sourceUniverse)

  validatePositiveInteger(targetCount, "targetCount")
  validatePositiveInteger(maxAttempts, "maxAttempts")

  if (typeof checkCoverage !== "function") {
    throw new Error("checkCoverage must be a function")
  }

  if (typeof onProgress !== "function") {
    throw new Error("onProgress must be a function")
  }

  const orderedCandidates = [...candidates].sort(
    (first, second) => first.rank - second.rank,
  )
  const coins = []
  const rejected = []
  let liveCheckedCount = 0

  for (const coin of orderedCandidates) {
    if (coins.length === targetCount) {
      break
    }

    liveCheckedCount += 1

    const { attempts, result } = await checkWithRetry(
      checkCoverage,
      coin,
      maxAttempts,
      onProgress,
    )

    if (result?.complete) {
      const accepted = {
        ...coin,
        market: toPublicMarket(coin.market),
        attempts,
        coverage: result.coverage,
      }
      coins.push(accepted)
      onProgress({
        status: "accepted",
        coin,
        market: coin.market,
        accepted,
      })
      continue
    }

    const rejection = createCoverageRejection(coin, attempts, result)
    rejected.push(rejection)
    onProgress({
      status: "rejected",
      coin,
      market: coin.market,
      rejection,
    })
  }

  const checkedCandidateCount = coins.length + rejected.length

  return {
    generatedAt: toIsoTimestamp(generatedAt, "generatedAt"),
    source,
    selection,
    candidateCount: orderedCandidates.length,
    checkedCandidateCount,
    liveCheckedCount,
    uncheckedCandidateCount: orderedCandidates.length - checkedCandidateCount,
    targetCoinCount: targetCount,
    coinCount: coins.length,
    targetReached: coins.length === targetCount,
    rejectionSummary: summarizeRejections(rejected),
    coins,
    rejected,
  }
}
