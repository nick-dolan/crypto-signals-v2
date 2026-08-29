import { fetchTradingViewChartStudies } from "../../api/tradingview/chart-studies.js"
import {
  DATA_COVERAGE_CHART_SETTLE_DELAY_MS,
  DATA_COVERAGE_MAX_STALENESS_HOURS,
  DATA_COVERAGE_MIN_DENSE_VALUES,
  DATA_COVERAGE_PROBE_HOURS,
  DATA_COVERAGE_STUDY_SETTLE_DELAY_MS,
  DATA_COVERAGE_TIMEFRAME,
  DATA_COVERAGE_TIMEOUT_MS,
} from "./config.js"
import { createCoverageStudyRequests } from "./coverage-study-definitions.js"
import { evaluateCoinCoverage } from "./evaluate-coin-coverage.js"

export function createCoinDataCoverageChecker ({
  fetchChartStudies = fetchTradingViewChartStudies,
} = {}) {
  if (typeof fetchChartStudies !== "function") {
    throw new Error("fetchChartStudies must be a function")
  }

  return async function checkCoinDataCoverage (
    client,
    coin,
    {
      chartSettleDelayMs = DATA_COVERAGE_CHART_SETTLE_DELAY_MS,
      maxStalenessHours = DATA_COVERAGE_MAX_STALENESS_HOURS,
      minDenseValues = DATA_COVERAGE_MIN_DENSE_VALUES,
      nowTimestamp = Math.floor(Date.now() / 1000),
      probeHours = DATA_COVERAGE_PROBE_HOURS,
      studySettleDelayMs = DATA_COVERAGE_STUDY_SETTLE_DELAY_MS,
      timeoutMs = DATA_COVERAGE_TIMEOUT_MS,
    } = {},
  ) {
    const requests = createCoverageStudyRequests(coin?.tradingViewSymbol)
    const chartData = await fetchChartStudies(
      client,
      requests,
      {
        symbol: coin?.market?.tradingViewSymbol,
        timeframe: DATA_COVERAGE_TIMEFRAME,
        range: probeHours,
        timeoutMs,
        settleDelayMs: chartSettleDelayMs,
        studySettleDelayMs,
      },
    )

    return evaluateCoinCoverage(
      coin,
      chartData,
      {
        maxStalenessHours,
        minDenseValues,
        nowTimestamp,
        probeHours,
      },
    )
  }
}

export const checkCoinDataCoverage = createCoinDataCoverageChecker()
