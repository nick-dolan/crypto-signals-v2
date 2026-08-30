import {
  DATA_BOOTSTRAP_HISTORY_HOURS,
  DATA_COVERAGE_HISTORY_MIN_RATIO,
  DATA_COVERAGE_HISTORY_REQUIREMENTS,
  DATA_COVERAGE_LONG_HISTORY_HOURS,
  DATA_COVERAGE_MAX_STALENESS_HOURS,
  DATA_COVERAGE_MIN_DENSE_VALUES,
  DATA_COVERAGE_PROBE_HOURS,
  DATA_COVERAGE_REQUIRED_STUDY_KEYS,
  DATA_COVERAGE_SPARSE_STUDIES,
} from "./config.js"
import {
  createResultBuilder,
  evaluateChart,
  evaluateChartHistory,
  evaluateIdentity,
  evaluateMetadata,
  evaluateStudy,
  hasSufficientChartHistory,
  summarizeChartCoverage,
  validatePositiveInteger,
} from "./data-coverage-helpers.js"

export function evaluateCoinCoverage (
  coin,
  chartData,
  {
    fetchHours = DATA_BOOTSTRAP_HISTORY_HOURS,
    historyMinRatio = DATA_COVERAGE_HISTORY_MIN_RATIO,
    historyRequirements = DATA_COVERAGE_HISTORY_REQUIREMENTS,
    maxStalenessHours = DATA_COVERAGE_MAX_STALENESS_HOURS,
    minDenseValues = DATA_COVERAGE_MIN_DENSE_VALUES,
    nowTimestamp = Math.floor(Date.now() / 1000),
    probeHours = DATA_COVERAGE_PROBE_HOURS,
    requiredStudyKeys = DATA_COVERAGE_REQUIRED_STUDY_KEYS,
    sparseStudyKeys = DATA_COVERAGE_SPARSE_STUDIES,
    unavailableHistoryHours = DATA_COVERAGE_LONG_HISTORY_HOURS,
  } = {},
) {
  validatePositiveInteger(fetchHours, "fetchHours")
  validatePositiveInteger(probeHours, "probeHours")
  validatePositiveInteger(minDenseValues, "minDenseValues")
  validatePositiveInteger(maxStalenessHours, "maxStalenessHours")
  validatePositiveInteger(unavailableHistoryHours, "unavailableHistoryHours")

  if (
    !historyRequirements
    || typeof historyRequirements !== "object"
    || Array.isArray(historyRequirements)
  ) {
    throw new Error("historyRequirements must be an object")
  }

  for (const [key, hours] of Object.entries(historyRequirements)) {
    validatePositiveInteger(hours, `historyRequirements.${key}`)
  }

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
  const chartAvailability = summarizeChartCoverage(
    chart.periods,
    nowTimestamp,
    unavailableHistoryHours,
  )
  const chartHistoryHours = historyRequirements.ohlcv
  const chartHistory = chartHistoryHours
    ? evaluateChartHistory(
        summarizeChartCoverage(
          chart.periods,
          nowTimestamp,
          chartHistoryHours,
        ),
        result,
        {
          historyHours: chartHistoryHours,
          historyMinRatio,
          nowTimestamp,
        },
      )
    : null
  const canClassifyUnavailable = hasSufficientChartHistory(
    chartAvailability,
    {
      historyHours: unavailableHistoryHours,
      historyMinRatio,
      nowTimestamp,
    },
  )
  const fulfilledStudyCount = requiredStudyKeys.filter(
    key => studies[key]?.status === "fulfilled",
  ).length
  const canClassifyRejectedStudyUnavailable = canClassifyUnavailable
    && fulfilledStudyCount > requiredStudyKeys.length / 2
  const studyCoverage = {}
  const unavailableMetrics = []
  const normalizedSparseStudyKeys = new Set(sparseStudyKeys)

  evaluateMetadata(coin, result)
  evaluateIdentity(coin, chart.info, result)
  evaluateChart(chartCoverage, result, {
    maxStalenessHours,
    minDenseValues,
    nowTimestamp,
  })

  for (const key of requiredStudyKeys) {
    const coverage = evaluateStudy(
      key,
      studies[key],
      result,
      {
        canClassifyRejectedStudyUnavailable,
        canClassifyUnavailable,
        fetchHours,
        historyMinRatio,
        historyRequirements,
        maxStalenessHours,
        minDenseValues,
        nowTimestamp,
        probeHours,
        sparseStudyKeys: normalizedSparseStudyKeys,
      },
    )

    studyCoverage[key] = coverage

    if (coverage.unavailable) {
      unavailableMetrics.push(key)
    }
  }

  return {
    ...result.build({
      ohlcv: {
        ...chartCoverage,
        availability: {
          ...chartAvailability,
          checkedHours: unavailableHistoryHours,
        },
        ...(chartHistory ? { history: chartHistory } : {}),
      },
      studies: studyCoverage,
    }),
    unavailableMetrics,
  }
}
