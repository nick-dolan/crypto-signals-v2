import path from "node:path"

import { fetchTradingViewChartStudies } from "../../api/tradingview/chart-studies.js"
import { writeTmpJson } from "../../helpers/fs-helper.js"
import { createCoverageStudyRequests } from "./coverage-study-definitions.js"
import { getClosedHourlyPeriods } from "./data-coverage-helpers.js"
import { evaluateCoinCoverage } from "./evaluate-coin-coverage.js"

function summarizeBootstrapStudyCoverage (periods, fields, sourceCoverage) {
  const coverage = {
    completePeriods: 0,
    partialPeriods: 0,
    missingPeriods: 0,
    duplicatePeriodCount: 0,
    invalidTimestampCount: 0,
  }
  const seenTimes = new Set()

  for (const period of periods) {
    if (!Number.isFinite(period?.time)) {
      coverage.invalidTimestampCount += 1
    } else if (seenTimes.has(period.time)) {
      coverage.duplicatePeriodCount += 1
    } else {
      seenTimes.add(period.time)
    }

    const availableValueCount = fields.filter(field => Number.isFinite(period[field])).length

    if (availableValueCount === fields.length) {
      coverage.completePeriods += 1
    } else if (availableValueCount === 0) {
      coverage.missingPeriods += 1
    } else {
      coverage.partialPeriods += 1
    }
  }

  return {
    ...sourceCoverage,
    periodCount: periods.length,
    sourcePeriodCount: periods.length,
    ...coverage,
  }
}

function densifyLiquidations (chartData, nowTimestamp, fetchHours) {
  const settledStudy = chartData?.studies?.liquidations

  if (settledStudy?.status !== "fulfilled") {
    return chartData
  }

  const study = settledStudy.value
  const fields = study?.fields && typeof study.fields === "object"
    ? Object.keys(study.fields)
    : []
  const periods = Array.isArray(study?.periods) ? study.periods : []
  const latestTime = Math.floor(nowTimestamp / 3_600) * 3_600 - 3_600
  const earliestTime = latestTime - (fetchHours - 1) * 3_600
  const windowPeriods = periods.filter(period => (
    Number.isFinite(period?.time)
    && period.time >= earliestTime
    && period.time <= latestTime
  ))
  const periodsByTime = new Map()
  let invalidGrid = periods.some(period => !Number.isFinite(period?.time))
    || (study?.coverage?.invalidTimestampCount ?? 0) > 0

  for (const period of windowPeriods) {
    if ((period.time - earliestTime) % 3_600 !== 0 || periodsByTime.has(period.time)) {
      invalidGrid = true

      break
    }

    periodsByTime.set(period.time, period)
  }

  const hasNumericValues = fields.length > 0 && fields.every(field => (
    windowPeriods.some(period => Number.isFinite(period[field]))
  ))

  if (invalidGrid || !hasNumericValues) {
    return chartData
  }

  const normalizedPeriods = Array.from(
    { length: fetchHours },
    (_, index) => {
      const time = earliestTime + index * 3_600
      const source = periodsByTime.get(time)

      return {
        time, ...Object.fromEntries(fields.map(field => [
          field, Number.isFinite(source?.[field]) ? source[field] : 0,
        ])),
      }
    },
  )

  return {
    ...chartData,
    studies: {
      ...chartData.studies,
      liquidations: {
        ...settledStudy,
        value: {
          ...study,
          periods: normalizedPeriods,
        },
      },
    },
  }
}

function toBootstrapStudyData (key, settledStudy, nowTimestamp, fetchHours, volumeDeltaHours) {
  if (settledStudy?.status !== "fulfilled") {
    throw new Error("Accepted coin contains an incomplete study")
  }

  const study = settledStudy.value
  const periods = getClosedHourlyPeriods(
    study.periods,
    nowTimestamp,
    key === "volumeDelta" ? volumeDeltaHours : fetchHours,
  )

  return {
    request: study.request,
    fields: study.fields,
    periods,
    coverage: summarizeBootstrapStudyCoverage(
      periods,
      Object.keys(study.fields),
      study.coverage,
    ),
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
    "step2-data-bootstrap",
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
    volumeDeltaHours = Math.min(1_666, fetchHours),
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
    timeframe: "1h",
    requestedHours: fetchHours,
    chart: {
      ...chartData.chart,
      periods: getClosedHourlyPeriods(
        chartData.chart.periods,
        nowTimestamp,
        fetchHours,
      ),
    },
    studies: Object.fromEntries(Object.entries(chartData.studies)
      .map(([key, study]) => [
        key,
        toBootstrapStudyData(
          key,
          study,
          nowTimestamp,
          fetchHours,
          volumeDeltaHours,
        ),
      ])),
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
      chartSettleDelayMs = 500,
      fetchHours = 100 * 24,
      nowTimestamp = Math.floor(Date.now() / 1000),
      studySettleDelayMs = 250,
      volumeDeltaHours = Math.min(1_666, fetchHours),
      timeoutMs = 45_000,
    } = {},
  ) {
    const requests = createCoverageStudyRequests(coin?.tradingViewSymbol)
    const fetchedChartData = await fetchChartStudies(
      client,
      requests,
      {
        symbol: coin?.market?.tradingViewSymbol,
        timeframe: "60",
        range: fetchHours + 1,
        timeoutMs,
        settleDelayMs: chartSettleDelayMs,
        studySettleDelayMs,
        to: Math.floor(nowTimestamp / 3_600) * 3_600 - 1,
      },
    )

    const chartData = densifyLiquidations(
      fetchedChartData,
      nowTimestamp,
      fetchHours,
    )
    const coverage = evaluateCoverage(
      coin,
      chartData,
      {
        fetchHours,
        nowTimestamp,
        volumeDeltaHours,
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
        volumeDeltaHours,
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
