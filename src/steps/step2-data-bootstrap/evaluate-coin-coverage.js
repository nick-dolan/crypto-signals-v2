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
    fetchHours = 100 * 24,
    historyMinRatio = 120 / 168,
    historyRequirements = {
      ohlcv: 90 * 24,
      volumeDelta: 30 * 24,
      openInterest: 30 * 24,
      fundingRate: 90 * 24,
      premium: 30 * 24,
      socialDominance: 30 * 24,
      interactions: 30 * 24,
      activeContributors: 30 * 24,
      createdPosts: 30 * 24,
    },
    maxStalenessHours = 24,
    minDenseValues = 120,
    nowTimestamp = Math.floor(Date.now() / 1000),
    probeHours = 168,
    requiredStudyKeys = [
      "volumeDelta",
      "openInterest",
      "fundingRate",
      "liquidations",
      "longShortRatioAccounts",
      "topTradersLongShortPositions",
      "premium",
      "socialDominance",
      "interactions",
      "activeContributors",
      "createdPosts",
    ],
    sparseStudyKeys = ["liquidations"],
    unavailableHistoryHours = 90 * 24,
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
