import path from "node:path"

import {
  DATA_BOOTSTRAP_HISTORY_HOURS,
  DATA_BOOTSTRAP_TMP_DIRECTORY,
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
import { writeTmpJson } from "../../helpers/fs-helper.js"
import { createCoverageStudyRequests } from "./coverage-study-definitions.js"
import { evaluateCoinCoverage } from "./evaluate-coin-coverage.js"

function toBootstrapStudyData (settledStudy) {
  if (settledStudy?.status !== "fulfilled") {
    throw new Error("Accepted coin contains an incomplete study")
  }

  const study = settledStudy.value

  return {
    request: study.request,
    fields: study.fields,
    periods: study.periods,
    coverage: study.coverage,
  }
}

function toSafePathSegment (value, name) {
  const normalized = typeof value === "string" ? value.trim() : ""
  const safe = [...normalized].map(character => (
    character.charCodeAt(0) < 32 || "<>:\"/\\|?*".includes(character)
      ? "-"
      : character
  )).join("")

  if (!safe || safe === "." || safe === "..") {
    throw new Error(`${name} cannot be used in a data directory name`)
  }

  return safe
}

export function createBootstrapDataRelativePath (coin) {
  const symbol = toSafePathSegment(coin?.symbol, "Coin symbol")
  const baseCurrencyId = toSafePathSegment(
    coin?.baseCurrencyId,
    "Coin baseCurrencyId",
  )
  const directoryName = `${symbol}--${baseCurrencyId}`

  return path.join(
    DATA_BOOTSTRAP_TMP_DIRECTORY,
    directoryName,
    "data.json",
  )
}

export function createBootstrapHourlyData (
  chartData,
  coin,
  {
    fetchHours,
    nowTimestamp,
  },
) {
  return {
    collectedAt: new Date(nowTimestamp * 1_000).toISOString(),
    coin: {
      baseCurrencyId: coin.baseCurrencyId,
      symbol: coin.symbol,
      name: coin.name,
      tradingViewSymbol: coin.tradingViewSymbol,
      marketSymbol: coin.market.tradingViewSymbol,
    },
    timeframe: DATA_COVERAGE_TIMEFRAME_LABEL,
    requestedHours: fetchHours,
    chart: chartData.chart,
    studies: Object.fromEntries(Object.entries(chartData.studies)
      .map(([key, study]) => [key, toBootstrapStudyData(study)])),
  }
}

export async function saveBootstrapHourlyData (coin, hourlyData) {
  const relativePath = createBootstrapDataRelativePath(coin)
  const filePath = await writeTmpJson(relativePath, hourlyData)

  return path.relative(process.cwd(), filePath)
}

export function createCoinDataCoverageChecker ({
  evaluateCoverage = evaluateCoinCoverage,
  fetchChartStudies = fetchTradingViewChartStudies,
  saveHourlyData = saveBootstrapHourlyData,
} = {}) {
  if (typeof evaluateCoverage !== "function") {
    throw new Error("evaluateCoverage must be a function")
  }

  if (typeof fetchChartStudies !== "function") {
    throw new Error("fetchChartStudies must be a function")
  }

  if (typeof saveHourlyData !== "function") {
    throw new Error("saveHourlyData must be a function")
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

    const coverage = evaluateCoverage(
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

    if (!coverage.complete) {
      return coverage
    }

    const hourlyData = createBootstrapHourlyData(
      chartData,
      coin,
      {
        fetchHours,
        nowTimestamp,
      },
    )
    const dataFile = await saveHourlyData(coin, hourlyData)

    return {
      ...coverage,
      dataFile,
    }
  }
}

export const checkCoinDataCoverage = createCoinDataCoverageChecker()
