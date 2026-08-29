import { toIsoTimestamp } from "../../helpers/normalization-helper.js"
import {
  DATA_COVERAGE_MAX_ATTEMPTS,
  DATA_COVERAGE_TARGET_COUNT,
} from "./config.js"

const REQUIRED_EXCHANGE = "BINANCE"
const REQUIRED_QUOTE_SYMBOL = "USDT"
const REQUIRED_INSTRUMENT_TYPE = "swap"

function validatePositiveInteger (value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`)
  }
}

function validateCandidates (candidates) {
  if (!Array.isArray(candidates)) {
    throw new Error("Crypto universe candidates must be an array")
  }

  const ranks = new Set()
  const baseCurrencyIds = new Set()

  for (const [index, candidate] of candidates.entries()) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      throw new Error(`Crypto universe candidate at index ${index} must be an object`)
    }

    if (!Number.isSafeInteger(candidate.rank) || candidate.rank <= 0) {
      throw new Error(`Crypto universe candidate at index ${index} rank is invalid`)
    }

    if (typeof candidate.baseCurrencyId !== "string" || !candidate.baseCurrencyId.trim()) {
      throw new Error(
        `Crypto universe candidate at index ${index} baseCurrencyId is required`,
      )
    }

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

function isRequiredMarket (market) {
  return market?.exchange === REQUIRED_EXCHANGE
    && market?.quoteSymbol === REQUIRED_QUOTE_SYMBOL
    && market?.instrumentType === REQUIRED_INSTRUMENT_TYPE
    && Number.isFinite(market?.volume24hUsd)
    && market.volume24hUsd > 0
}

export function selectMarketsByBaseCurrencyId (markets) {
  if (!Array.isArray(markets)) {
    throw new Error("Crypto markets must be an array")
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
  }
}

function createMissingMarketRejection (coin) {
  return {
    ...coin,
    market: null,
    attempts: 0,
    reasonCodes: ["market:not_found"],
    reasons: [
      `No identity-matched ${REQUIRED_EXCHANGE} ${REQUIRED_QUOTE_SYMBOL} perpetual`,
    ],
    coverage: null,
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
  markets,
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
  const selectedMarkets = selectMarketsByBaseCurrencyId(markets)
  const coins = []
  const rejected = []
  let liveCheckedCount = 0

  for (const coin of orderedCandidates) {
    if (coins.length === targetCount) {
      break
    }

    const market = selectedMarkets.get(coin.baseCurrencyId)

    if (!market) {
      const rejection = createMissingMarketRejection(coin)
      rejected.push(rejection)
      onProgress({
        status: "rejected",
        coin,
        market: null,
        rejection,
      })
      continue
    }

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
  const marketMatchedCandidateCount = orderedCandidates.filter(candidate => (
    selectedMarkets.has(candidate.baseCurrencyId)
  )).length

  return {
    generatedAt: toIsoTimestamp(generatedAt, "generatedAt"),
    source: "tradingview",
    selection: {
      exchange: REQUIRED_EXCHANGE,
      quoteSymbol: REQUIRED_QUOTE_SYMBOL,
      instrumentType: REQUIRED_INSTRUMENT_TYPE,
    },
    candidateCount: orderedCandidates.length,
    marketMatchedCandidateCount,
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
