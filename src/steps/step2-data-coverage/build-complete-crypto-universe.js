import { toIsoTimestamp } from "../../helpers/normalization-helper.js"
import {
  DATA_COVERAGE_MAX_ATTEMPTS,
  DATA_COVERAGE_TARGET_COUNT,
} from "./config.js"

const REQUIRED_EXCHANGE = "BINANCE"
const REQUIRED_QUOTE_SYMBOL = "USDT"
const REQUIRED_INSTRUMENT_TYPE = "swap"
const REQUIRED_TYPE_SPECIFICATION = "perpetual"

function validatePositiveInteger (value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`)
  }
}

function validateRequiredString (value, fieldName) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${fieldName} is required`)
  }
}

function validateCandidateMarket (candidate, index) {
  const market = candidate.market
  const fieldName = `Crypto universe candidate at index ${index} market`

  if (!market || typeof market !== "object" || Array.isArray(market)) {
    throw new Error(`${fieldName} is required`)
  }

  validateRequiredString(market.tradingViewSymbol, `${fieldName} tradingViewSymbol`)
  validateRequiredString(market.symbol, `${fieldName} symbol`)
  validateRequiredString(market.baseSymbol, `${fieldName} baseSymbol`)
  validateRequiredString(market.baseCurrencyId, `${fieldName} baseCurrencyId`)

  if (market.baseCurrencyId !== candidate.baseCurrencyId) {
    throw new Error(`${fieldName} baseCurrencyId does not match its coin`)
  }

  if (
    market.exchange !== REQUIRED_EXCHANGE
    || market.quoteSymbol !== REQUIRED_QUOTE_SYMBOL
    || market.instrumentType !== REQUIRED_INSTRUMENT_TYPE
    || !Array.isArray(market.typeSpecifications)
    || !market.typeSpecifications.includes(REQUIRED_TYPE_SPECIFICATION)
    || !Number.isFinite(market.volume24hUsd)
    || market.volume24hUsd <= 0
  ) {
    throw new Error(`${fieldName} must be a Binance USDT perpetual`)
  }
}

function validateCandidates (candidates) {
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

    validateRequiredString(
      candidate.baseCurrencyId,
      `Crypto universe candidate at index ${index} baseCurrencyId`,
    )
    validateCandidateMarket(candidate, index)

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
  market,
  maxAttempts,
  onProgress,
) {
  let result

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      result = await checkCoverage(coin, market, attempt)
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
      market,
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

function createCoverageRejection (coin, market, attempts, result) {
  return {
    ...coin,
    market: toPublicMarket(market),
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
  candidates,
  checkCoverage,
  {
    generatedAt = new Date().toISOString(),
    maxAttempts = DATA_COVERAGE_MAX_ATTEMPTS,
    onProgress = () => {},
    targetCount = DATA_COVERAGE_TARGET_COUNT,
  } = {},
) {
  validateCandidates(candidates)
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

    const market = coin.market
    liveCheckedCount += 1

    const { attempts, result } = await checkWithRetry(
      checkCoverage,
      coin,
      market,
      maxAttempts,
      onProgress,
    )

    if (result?.complete) {
      const accepted = {
        ...coin,
        market: toPublicMarket(market),
        attempts,
        coverage: result.coverage,
      }
      coins.push(accepted)
      onProgress({
        status: "accepted",
        coin,
        market,
        accepted,
      })
      continue
    }

    const rejection = createCoverageRejection(
      coin,
      market,
      attempts,
      result,
    )
    rejected.push(rejection)
    onProgress({
      status: "rejected",
      coin,
      market,
      rejection,
    })
  }

  const checkedCandidateCount = coins.length + rejected.length

  return {
    generatedAt: toIsoTimestamp(generatedAt, "generatedAt"),
    source: "tradingview",
    selection: {
      exchange: REQUIRED_EXCHANGE,
      quoteSymbol: REQUIRED_QUOTE_SYMBOL,
      instrumentType: REQUIRED_INSTRUMENT_TYPE,
      typeSpecification: REQUIRED_TYPE_SPECIFICATION,
    },
    candidateCount: orderedCandidates.length,
    marketMatchedCandidateCount: orderedCandidates.length,
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
