import {
  DATA_BOOTSTRAP_HISTORY_HOURS,
  DATA_COVERAGE_CHART_SETTLE_DELAY_MS,
  DATA_COVERAGE_MAX_STALENESS_HOURS,
  DATA_COVERAGE_MIN_DENSE_VALUES,
  DATA_COVERAGE_PROBE_HOURS,
  DATA_COVERAGE_STUDY_SETTLE_DELAY_MS,
  DATA_COVERAGE_TIMEFRAME,
  DATA_COVERAGE_TIMEFRAME_LABEL,
  DATA_COVERAGE_TIMEOUT_MS,
} from "./config.js"
import { fetchTradingViewChartStudies } from "../../api/tradingview/chart-studies.js"
import { createCoverageStudyRequests } from "./coverage-study-definitions.js"
import { evaluateCoinCoverage } from "./evaluate-coin-coverage.js"

function toBootstrapStudyData (settledStudy) {
  if (settledStudy?.status !== "fulfilled") {
    return null
  }

  const study = settledStudy.value

  return {
    request: study.request,
    fields: study.fields,
    periods: study.periods,
    coverage: study.coverage,
  }
}

export function createBootstrapHourlyData (
  chartData,
  {
    fetchHours,
    nowTimestamp,
  },
) {
  return {
    collectedAt: new Date(nowTimestamp * 1_000).toISOString(),
    timeframe: DATA_COVERAGE_TIMEFRAME_LABEL,
    requestedHours: fetchHours,
    chart: chartData.chart,
    studies: Object.fromEntries(Object.entries(chartData.studies)
      .map(([key, study]) => [key, toBootstrapStudyData(study)])
      .filter(([, study]) => study !== null)),
  }
}

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
      fetchHours = DATA_BOOTSTRAP_HISTORY_HOURS,
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
        range: fetchHours,
        timeoutMs,
        settleDelayMs: chartSettleDelayMs,
        studySettleDelayMs,
      },
    )

    const coverage = evaluateCoinCoverage(
      coin,
      chartData,
      {
        fetchHours,
        maxStalenessHours,
        minDenseValues,
        nowTimestamp,
        probeHours,
      },
    )

    return {
      ...coverage,
      hourlyData: createBootstrapHourlyData(chartData, {
        fetchHours,
        nowTimestamp,
      }),
    }
  }
}

export const checkCoinDataCoverage = createCoinDataCoverageChecker()
