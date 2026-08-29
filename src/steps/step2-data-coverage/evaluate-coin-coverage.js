import {
  DATA_COVERAGE_MAX_STALENESS_HOURS,
  DATA_COVERAGE_MIN_DENSE_VALUES,
  DATA_COVERAGE_PROBE_HOURS,
  DATA_COVERAGE_REQUIRED_METADATA,
  DATA_COVERAGE_SPARSE_STUDIES,
} from "./config.js"
import { REQUIRED_STUDY_KEYS } from "./coverage-study-definitions.js"

function getErrorMessage (error) {
  return error instanceof Error ? error.message : String(error)
}

function hoursToSeconds (hours) {
  return hours * 60 * 60
}

function validatePositiveInteger (value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`)
  }
}

function getLatestTime (periods) {
  const times = periods
    .map(period => period?.time)
    .filter(Number.isFinite)

  return times.length === 0 ? null : Math.max(...times)
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

function summarizeChartCoverage (periods, referenceTime, probeHours) {
  const latestTime = getLatestTime(periods)
  const recentPeriods = getRecentPeriods(periods, referenceTime, probeHours)
  const completePeriods = recentPeriods.filter(isFiniteChartPeriod)

  return {
    latestTime,
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
    fieldLatestValueTimes,
    latestValueTime: getLatestTime(availablePeriods),
    sourcePeriodCount: Number.isSafeInteger(study?.coverage?.sourcePeriodCount)
      ? study.coverage.sourcePeriodCount
      : periods.length,
  }
}

function createResultBuilder () {
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

function evaluateMetadata (coin, result) {
  for (const { field, label } of DATA_COVERAGE_REQUIRED_METADATA) {
    if (!Number.isFinite(coin[field]) || coin[field] <= 0) {
      result.add(
        `metadata:${field}_missing`,
        `Coin ${label} is missing`,
      )
    }
  }
}

function evaluateIdentity (coin, chartInfo, result) {
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

function evaluateChart (
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

function evaluateStudy (
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
  const isSparse = options.sparseStudyKeys.has(key)

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
  }

  return {
    status: "fulfilled",
    ...summary,
  }
}

export function evaluateCoinCoverage (
  coin,
  chartData,
  {
    maxStalenessHours = DATA_COVERAGE_MAX_STALENESS_HOURS,
    minDenseValues = DATA_COVERAGE_MIN_DENSE_VALUES,
    nowTimestamp = Math.floor(Date.now() / 1000),
    probeHours = DATA_COVERAGE_PROBE_HOURS,
    requiredStudyKeys = REQUIRED_STUDY_KEYS,
    sparseStudyKeys = DATA_COVERAGE_SPARSE_STUDIES,
  } = {},
) {
  validatePositiveInteger(probeHours, "probeHours")
  validatePositiveInteger(minDenseValues, "minDenseValues")
  validatePositiveInteger(maxStalenessHours, "maxStalenessHours")

  if (!Number.isFinite(nowTimestamp)) {
    throw new Error("nowTimestamp must be finite")
  }

  if (
    !coin
    || typeof coin !== "object"
    || Array.isArray(coin)
    || !coin.market
    || typeof coin.market !== "object"
    || Array.isArray(coin.market)
  ) {
    throw new Error("Coin with market is required")
  }

  const chart = chartData?.chart
  const studies = chartData?.studies

  if (!chart || !Array.isArray(chart.periods) || !studies) {
    throw new Error("TradingView chart coverage data is incomplete")
  }

  const result = createResultBuilder()
  const chartCoverage = summarizeChartCoverage(
    chart.periods,
    nowTimestamp,
    probeHours,
  )
  const studyCoverage = {}
  const normalizedSparseStudyKeys = new Set(sparseStudyKeys)

  evaluateMetadata(coin, result)
  evaluateIdentity(coin, chart.info, result)
  evaluateChart(chartCoverage, result, {
    maxStalenessHours,
    minDenseValues,
    nowTimestamp,
  })

  for (const key of requiredStudyKeys) {
    studyCoverage[key] = evaluateStudy(
      key,
      studies[key],
      result,
      {
        maxStalenessHours,
        minDenseValues,
        nowTimestamp,
        probeHours,
        sparseStudyKeys: normalizedSparseStudyKeys,
      },
    )
  }

  return result.build({
    ohlcv: chartCoverage,
    studies: studyCoverage,
  })
}
