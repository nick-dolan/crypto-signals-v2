import {
  DATA_COVERAGE_MAX_STALENESS_HOURS,
  DATA_COVERAGE_MIN_DENSE_VALUES,
  DATA_COVERAGE_PROBE_HOURS,
  DATA_COVERAGE_REQUIRED_STUDY_KEYS,
  DATA_COVERAGE_SPARSE_STUDIES,
} from "./config.js"
import {
  createResultBuilder,
  evaluateChart,
  evaluateIdentity,
  evaluateMetadata,
  evaluateStudy,
  summarizeChartCoverage,
  validatePositiveInteger,
} from "./data-coverage-helpers.js"

export function evaluateCoinCoverage (
  coin,
  chartData,
  {
    maxStalenessHours = DATA_COVERAGE_MAX_STALENESS_HOURS,
    minDenseValues = DATA_COVERAGE_MIN_DENSE_VALUES,
    nowTimestamp = Math.floor(Date.now() / 1000),
    probeHours = DATA_COVERAGE_PROBE_HOURS,
    requiredStudyKeys = DATA_COVERAGE_REQUIRED_STUDY_KEYS,
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
