import {
  DATA_COVERAGE_REQUIRED_METADATA,
  DATA_COVERAGE_REQUIRED_SELECTION_FIELDS,
} from "./config.js"
import { getRequiredString } from "../../helpers/normalization-helper.js"

export function validatePositiveInteger (value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`)
  }
}

function validatePositiveNumber (value, fieldName) {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${fieldName} must be a positive number`)
  }
}

function normalizeSelection (selection) {
  if (!selection || typeof selection !== "object" || Array.isArray(selection)) {
    throw new Error("Crypto universe selection is required")
  }

  return Object.fromEntries(DATA_COVERAGE_REQUIRED_SELECTION_FIELDS.map(field => [
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

export function normalizeSourceUniverse (sourceUniverse) {
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
    unavailableMetrics: [],
    coverage: null,
  }
}

export async function checkWithRetry (
  checkCoverage,
  coin,
  maxAttempts,
  onProgress,
) {
  let result
  let previousUnavailableMetrics = new Set()

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      result = await checkCoverage(coin, attempt)
    } catch (error) {
      result = createFailedCheckResult(error)
    }

    const unavailableMetrics = new Set(
      Array.isArray(result?.unavailableMetrics)
        ? result.unavailableMetrics
        : [],
    )
    const confirmedUnavailableMetrics = [...unavailableMetrics]
      .filter(metric => previousUnavailableMetrics.has(metric))

    result = {
      ...result,
      confirmedUnavailableMetrics,
    }

    if (result?.complete || !result?.retryable || attempt === maxAttempts) {
      return {
        attempts: attempt,
        result,
      }
    }

    previousUnavailableMetrics = unavailableMetrics

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

export function toPublicMarket (market) {
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

export function createCoverageRejection (coin, attempts, result) {
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
    unavailableMetrics: Array.isArray(result?.unavailableMetrics)
      ? [...result.unavailableMetrics]
      : [],
    confirmedUnavailableMetrics: Array.isArray(result?.confirmedUnavailableMetrics)
      ? [...result.confirmedUnavailableMetrics]
      : [],
    coverage: result?.coverage ?? null,
  }
}

export function summarizeRejections (rejected) {
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

function hoursToSeconds (hours) {
  return hours * 60 * 60
}

function getLatestTime (periods) {
  const times = periods
    .map(period => period?.time)
    .filter(Number.isFinite)

  return times.length === 0 ? null : Math.max(...times)
}

function getEarliestTime (periods) {
  const times = periods
    .map(period => period?.time)
    .filter(Number.isFinite)

  return times.length === 0 ? null : Math.min(...times)
}

function getRecentPeriods (periods, referenceTime, probeHours) {
  if (!Number.isFinite(referenceTime)) {
    return []
  }

  const cutoff = referenceTime - hoursToSeconds(probeHours - 1)

  return periods.filter(period => (
    Number.isFinite(period?.time)
    && period.time >= cutoff
    && period.time <= referenceTime
  ))
}

function isFiniteChartPeriod (period) {
  return Number.isFinite(period?.time)
    && Number.isFinite(period?.open)
    && Number.isFinite(period?.max)
    && Number.isFinite(period?.min)
    && Number.isFinite(period?.close)
    && Number.isFinite(period?.volume)
}

export function summarizeChartCoverage (periods, referenceTime, probeHours) {
  const latestTime = getLatestTime(periods)
  const recentPeriods = getRecentPeriods(periods, referenceTime, probeHours)
  const completePeriods = recentPeriods.filter(isFiniteChartPeriod)

  return {
    latestTime,
    earliestCompleteTime: getEarliestTime(completePeriods),
    latestCompleteTime: getLatestTime(completePeriods),
    recentPeriodCount: recentPeriods.length,
    completePeriodCount: completePeriods.length,
  }
}

function summarizeStudyCoverage (study, referenceTime, probeHours) {
  const fields = study?.fields && typeof study.fields === "object"
    ? Object.keys(study.fields)
    : []
  const periods = Array.isArray(study?.periods) ? study.periods : []
  const recentPeriods = getRecentPeriods(periods, referenceTime, probeHours)
  const periodsByField = Object.fromEntries(fields.map(field => [
    field,
    recentPeriods.filter(period => Number.isFinite(period[field])),
  ]))
  const fieldValueCounts = Object.fromEntries(fields.map(field => [
    field,
    periodsByField[field].length,
  ]))
  const fieldEarliestValueTimes = Object.fromEntries(fields.map(field => [
    field,
    getEarliestTime(periodsByField[field]),
  ]))
  const fieldLatestValueTimes = Object.fromEntries(fields.map(field => [
    field,
    getLatestTime(periodsByField[field]),
  ]))
  const availablePeriods = recentPeriods.filter(period => (
    fields.some(field => Number.isFinite(period[field]))
  ))

  return {
    fields,
    recentPeriodCount: recentPeriods.length,
    availablePeriodCount: availablePeriods.length,
    fieldValueCounts,
    fieldEarliestValueTimes,
    fieldLatestValueTimes,
    latestValueTime: getLatestTime(availablePeriods),
    sourcePeriodCount: Number.isSafeInteger(study?.coverage?.sourcePeriodCount)
      ? study.coverage.sourcePeriodCount
      : periods.length,
  }
}

function validateHistoryRatio (value) {
  if (!Number.isFinite(value) || value <= 0 || value > 1) {
    throw new Error("historyMinRatio must be greater than 0 and at most 1")
  }
}

export function getMinimumHistoryValues (historyHours, historyMinRatio) {
  validatePositiveInteger(historyHours, "historyHours")
  validateHistoryRatio(historyMinRatio)

  return Math.ceil(historyHours * historyMinRatio)
}

function isHistoryStartAvailable (earliestTime, nowTimestamp, historyHours) {
  const oldestRequiredTime = nowTimestamp - hoursToSeconds(historyHours - 1)

  return Number.isFinite(earliestTime)
    && earliestTime <= oldestRequiredTime + hoursToSeconds(1)
}

export function hasSufficientChartHistory (
  coverage,
  {
    historyHours,
    historyMinRatio,
    nowTimestamp,
  },
) {
  const minimumValues = getMinimumHistoryValues(historyHours, historyMinRatio)

  return coverage.completePeriodCount >= minimumValues
    && isHistoryStartAvailable(
      coverage.earliestCompleteTime,
      nowTimestamp,
      historyHours,
    )
}

export function evaluateChartHistory (
  coverage,
  result,
  options,
) {
  const minimumValues = getMinimumHistoryValues(
    options.historyHours,
    options.historyMinRatio,
  )
  const complete = hasSufficientChartHistory(coverage, options)

  if (!complete) {
    result.add(
      "ohlcv:insufficient_history",
      `OHLCV history has ${coverage.completePeriodCount}/${minimumValues} required values and starts at ${coverage.earliestCompleteTime ?? "missing"}`,
    )
  }

  return {
    ...coverage,
    requiredHours: options.historyHours,
    minimumValues,
    complete,
  }
}

function evaluateStudyHistory (key, summary, result, options) {
  const minimumValues = getMinimumHistoryValues(
    options.historyHours,
    options.historyMinRatio,
  )
  const insufficientFields = summary.fields.filter(field => (
    summary.fieldValueCounts[field] < minimumValues
    || !isHistoryStartAvailable(
      summary.fieldEarliestValueTimes[field],
      options.nowTimestamp,
      options.historyHours,
    )
  ))

  if (insufficientFields.length > 0) {
    const details = insufficientFields.map(field => (
      `${field}=${summary.fieldValueCounts[field]}, oldest=${summary.fieldEarliestValueTimes[field] ?? "missing"}`
    ))

    result.add(
      `${key}:insufficient_history`,
      `${key} has insufficient history: ${details.join(", ")}`,
    )
  }

  return {
    ...summary,
    requiredHours: options.historyHours,
    minimumValues,
    complete: insufficientFields.length === 0,
  }
}

export function createResultBuilder () {
  const reasonCodes = []
  const reasons = []
  let retryable = false

  return {
    add (code, message, { canRetry = false } = {}) {
      reasonCodes.push(code)
      reasons.push(message)
      retryable ||= canRetry
    },
    build (coverage) {
      return {
        complete: reasonCodes.length === 0,
        retryable,
        reasonCodes,
        reasons,
        coverage,
      }
    },
  }
}

export function evaluateMetadata (coin, result) {
  for (const { field, label } of DATA_COVERAGE_REQUIRED_METADATA) {
    if (!Number.isFinite(coin[field]) || coin[field] <= 0) {
      result.add(
        `metadata:${field}_missing`,
        `Coin ${label} is missing`,
      )
    }
  }
}

export function evaluateIdentity (coin, chartInfo, result) {
  const market = coin.market

  if (market.baseCurrencyId !== coin.baseCurrencyId) {
    result.add(
      "market:identity_mismatch",
      `Market baseCurrencyId ${market.baseCurrencyId} does not match ${coin.baseCurrencyId}`,
    )
  }

  if (
    chartInfo?.baseCurrencyId
    && chartInfo.baseCurrencyId !== coin.baseCurrencyId
  ) {
    result.add(
      "chart:identity_mismatch",
      `Chart baseCurrencyId ${chartInfo.baseCurrencyId} does not match ${coin.baseCurrencyId}`,
    )
  }

  if (!chartInfo?.fullName) {
    result.add(
      "chart:symbol_missing",
      "Chart symbol is missing",
    )
  } else if (chartInfo.fullName !== market.tradingViewSymbol) {
    result.add(
      "chart:symbol_mismatch",
      `Chart symbol ${chartInfo.fullName} does not match ${market.tradingViewSymbol}`,
    )
  }
}

export function evaluateChart (
  chartCoverage,
  result,
  {
    maxStalenessHours,
    minDenseValues,
    nowTimestamp,
  },
) {
  if (chartCoverage.completePeriodCount < minDenseValues) {
    result.add(
      "ohlcv:insufficient_values",
      `OHLCV has ${chartCoverage.completePeriodCount}/${minDenseValues} required recent values`,
    )
  }

  if (
    !Number.isFinite(chartCoverage.latestCompleteTime)
    || nowTimestamp - chartCoverage.latestCompleteTime > hoursToSeconds(maxStalenessHours)
  ) {
    result.add(
      "ohlcv:stale",
      `OHLCV latest complete timestamp is ${chartCoverage.latestCompleteTime ?? "missing"}`,
    )
  }
}

export function evaluateStudy (
  key,
  settledStudy,
  result,
  options,
) {
  if (!settledStudy) {
    result.add(
      `${key}:missing_result`,
      `${key} did not return a result`,
      { canRetry: true },
    )

    return {
      status: "missing",
    }
  }

  if (settledStudy.status === "rejected") {
    const error = getErrorMessage(settledStudy.reason)

    result.add(
      `${key}:request_failed`,
      `${key} request failed: ${error}`,
      { canRetry: true },
    )

    return {
      status: "rejected",
      error,
      unavailable: options.canClassifyRejectedStudyUnavailable,
    }
  }

  if (settledStudy.status !== "fulfilled") {
    result.add(
      `${key}:invalid_result`,
      `${key} returned an invalid status`,
      { canRetry: true },
    )

    return {
      status: "invalid",
    }
  }

  const summary = summarizeStudyCoverage(
    settledStudy.value,
    options.nowTimestamp,
    options.probeHours,
  )
  const availability = summarizeStudyCoverage(
    settledStudy.value,
    options.nowTimestamp,
    options.fetchHours,
  )
  const isSparse = options.sparseStudyKeys.has(key)
  const isUnavailable = !isSparse
    && options.canClassifyUnavailable
    && availability.fields.length > 0
    && Object.values(availability.fieldValueCounts).every(count => count === 0)
  const requiredHistoryHours = options.historyRequirements[key]
  let history

  if (summary.fields.length === 0) {
    result.add(
      `${key}:missing_fields`,
      `${key} exposes no fields`,
    )
  } else if (isSparse) {
    const missingFields = Object.entries(summary.fieldValueCounts)
      .filter(([, count]) => count === 0)
      .map(([field]) => field)

    if (missingFields.length > 0) {
      result.add(
        `${key}:no_values`,
        `${key} has no numeric values for fields: ${missingFields.join(", ")}`,
      )
    }
  } else {
    const insufficientFields = Object.entries(summary.fieldValueCounts)
      .filter(([, count]) => count < options.minDenseValues)
      .map(([field, count]) => `${field}=${count}`)

    if (insufficientFields.length > 0) {
      result.add(
        `${key}:insufficient_values`,
        `${key} has insufficient recent values: ${insufficientFields.join(", ")}`,
      )
    }

    const staleFields = Object.entries(summary.fieldLatestValueTimes)
      .filter(([, latestValueTime]) => (
        !Number.isFinite(latestValueTime)
        || options.nowTimestamp - latestValueTime > hoursToSeconds(options.maxStalenessHours)
      ))
      .map(([field, latestValueTime]) => (
        `${field}=${latestValueTime ?? "missing"}`
      ))

    if (staleFields.length > 0) {
      result.add(
        `${key}:stale`,
        `${key} has stale fields: ${staleFields.join(", ")}`,
      )
    }

    if (requiredHistoryHours) {
      history = evaluateStudyHistory(
        key,
        summarizeStudyCoverage(
          settledStudy.value,
          options.nowTimestamp,
          requiredHistoryHours,
        ),
        result,
        {
          historyHours: requiredHistoryHours,
          historyMinRatio: options.historyMinRatio,
          nowTimestamp: options.nowTimestamp,
        },
      )
    }

    if (isUnavailable) {
      result.add(
        `${key}:unavailable`,
        `${key} has no numeric values in ${options.fetchHours} requested hours`,
        { canRetry: true },
      )
    }
  }

  return {
    status: "fulfilled",
    ...summary,
    availability: {
      ...availability,
      checkedHours: options.fetchHours,
    },
    ...(history ? { history } : {}),
    unavailable: isUnavailable,
  }
}
