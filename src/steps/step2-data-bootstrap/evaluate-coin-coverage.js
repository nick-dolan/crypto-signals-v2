import { isArray, isFinite, isObject } from "../../helpers/utils.typed.js"
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
    fetchHours = 100 * 24,
    nowTimestamp = Math.floor(Date.now() / 1000),
    requiredStudyKeys = [
      "volumeDelta",
      "openInterest",
      "fundingRate",
      "liquidations",
      "longShortRatioAccounts",
      "topTradersLongShortPositions",
      "premium",
    ],
    optionalSocialStudyKeys = [
      "socialDominance",
      "interactions",
      "activeContributors",
      "createdPosts",
    ],
    volumeDeltaHours = 1_666,
  } = {},
) {
  validatePositiveInteger(fetchHours, "fetchHours")
  validatePositiveInteger(volumeDeltaHours, "volumeDeltaHours")

  if (volumeDeltaHours > fetchHours) {
    throw new Error("volumeDeltaHours must not exceed fetchHours")
  }

  if (!isFinite(nowTimestamp)) {
    throw new Error("nowTimestamp must be finite")
  }

  if (!isObject(coin) || !isObject(coin.market)) {
    throw new Error("Coin with market is required")
  }

  const chart = chartData?.chart
  const studies = chartData?.studies

  if (!chart || !isArray(chart.periods) || !studies) {
    throw new Error("TradingView chart coverage data is incomplete")
  }

  const result = createResultBuilder()
  const socialResult = createResultBuilder()
  const chartCoverage = summarizeChartCoverage(
    chart.periods,
    nowTimestamp,
    fetchHours,
  )
  const fulfilledStudyCount = requiredStudyKeys.filter(
    key => studies[key]?.status === "fulfilled",
  ).length
  const canClassifyRejectedStudyUnavailable = chartCoverage.complete
    && fulfilledStudyCount > requiredStudyKeys.length / 2
  const studyCoverage = {}
  const unavailableMetrics = []

  evaluateMetadata(coin, result)
  evaluateIdentity(coin, chart.info, result)
  evaluateChart(chartCoverage, result)

  for (const key of requiredStudyKeys) {
    const coverage = evaluateStudy(
      key,
      studies[key],
      result,
      {
        canClassifyRejectedStudyUnavailable,
        canClassifyUnavailable: chartCoverage.complete,
        nowTimestamp,
        requiredHours: key === "volumeDelta" ? volumeDeltaHours : fetchHours,
      },
    )

    studyCoverage[key] = coverage

    if (coverage.unavailable) {
      unavailableMetrics.push(key)
    }
  }

  for (const key of optionalSocialStudyKeys) {
    studyCoverage[key] = evaluateStudy(
      key,
      studies[key],
      socialResult,
      {
        canClassifyRejectedStudyUnavailable: chartCoverage.complete,
        canClassifyUnavailable: chartCoverage.complete,
        nowTimestamp,
        requiredHours: fetchHours,
      },
    )
  }

  const socialEvaluation = socialResult.build()
  const incompleteSocialMetrics = optionalSocialStudyKeys.filter(
    key => studyCoverage[key]?.complete !== true,
  )

  return {
    ...result.build({
      ohlcv: chartCoverage,
      studies: studyCoverage,
      social: {
        status: socialEvaluation.complete ? "available" : "unavailable",
        unavailableMetrics: incompleteSocialMetrics,
        reasonCodes: socialEvaluation.reasonCodes,
        reasons: socialEvaluation.reasons,
      },
    }),
    unavailableMetrics,
  }
}
