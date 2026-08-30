import assert from "node:assert/strict"
import path from "node:path"
import test from "node:test"
import {
  createBootstrapDataRelativePath,
  createBootstrapHourlyData,
  createCoinDataCoverageChecker,
} from "../src/steps/step2-data-bootstrap/check-coin-data-coverage.js"
import { createCoverageStudyRequests } from "../src/steps/step2-data-bootstrap/coverage-study-definitions.js"

test("coverage checker fetches 100 days from the market attached by step 1", async () => {
  const expectedError = new Error("Stop after capturing the request")
  let capturedClient
  let capturedOptions
  let capturedRequests
  const checker = createCoinDataCoverageChecker({
    fetchChartStudies: async (client, requests, options) => {
      capturedClient = client
      capturedRequests = requests
      capturedOptions = options
      throw expectedError
    },
  })
  const client = { name: "client" }
  const coin = {
    tradingViewSymbol: "CRYPTO:BTCUSD",
    market: {
      tradingViewSymbol: "BINANCE:BTCUSDT.P",
    },
  }

  await assert.rejects(
    checker(client, coin, {
      chartSettleDelayMs: 10,
      nowTimestamp: 1_800_000_123,
      studySettleDelayMs: 20,
      timeoutMs: 30,
    }),
    error => error === expectedError,
  )

  assert.equal(capturedClient, client)
  assert.equal(capturedOptions.symbol, coin.market.tradingViewSymbol)
  assert.equal(capturedOptions.timeframe, "60")
  assert.equal(capturedOptions.range, 2_401)
  assert.equal(capturedOptions.settleDelayMs, 10)
  assert.equal(capturedOptions.studySettleDelayMs, 20)
  assert.equal(capturedOptions.timeoutMs, 30)
  assert.equal(capturedOptions.to, 1_799_999_999)
  assert.equal(capturedRequests.at(-1).inputs.in_0, coin.tradingViewSymbol)
})

test("bootstrap data path uses symbol and unique baseCurrencyId", () => {
  assert.equal(
    createBootstrapDataRelativePath({
      symbol: "BTC",
      baseCurrencyId: "XTVCBTC",
    }),
    path.join(
      "step2-data-bootstrap",
      "BTC--XTVCBTC",
      "data.json",
    ),
  )
})

function createFetchedChartData () {
  return {
    chart: {
      info: {
        fullName: "BINANCE:BTCUSDT.P",
        baseCurrencyId: "XTVCBTC",
      },
      periods: [],
    },
    studies: {
      socialDominance: {
        status: "fulfilled",
        value: {
          request: { key: "socialDominance" },
          fields: { percent: "Social_dominance_" },
          periods: [],
          coverage: { periodCount: 0 },
        },
      },
    },
  }
}

function createCoin () {
  return {
    rank: 1,
    baseCurrencyId: "XTVCBTC",
    symbol: "BTC",
    name: "Bitcoin",
    tradingViewSymbol: "CRYPTO:BTCUSD",
    categories: [],
    circulatingSupply: 20_000_000,
    marketCap: 1_500_000_000_000,
    fullyDilutedValuation: 1_575_000_000_000,
    market: {
      baseCurrencyId: "XTVCBTC",
      tradingViewSymbol: "BINANCE:BTCUSDT.P",
    },
  }
}

test("bootstrap data keeps only closed hourly candles and metrics", () => {
  const nowTimestamp = 1_800_000_000
  const chartData = createFetchedChartData()
  const closedTime = nowTimestamp - 3_600

  chartData.chart.periods = [
    { time: closedTime, open: 1, max: 2, min: 0.5, close: 1.5, volume: 10 },
    { time: nowTimestamp, open: 1.5, max: 2, min: 1, close: 1.8, volume: 5 },
  ]
  chartData.studies.socialDominance.value.periods = [
    { time: closedTime, percent: 1 },
    { time: nowTimestamp, percent: 2 },
  ]
  chartData.studies.socialDominance.value.coverage = {
    periodCount: 2,
    sourcePeriodCount: 2,
    completePeriods: 2,
    partialPeriods: 0,
    missingPeriods: 0,
  }

  const hourlyData = createBootstrapHourlyData(
    chartData,
    createCoin(),
    { fetchHours: 1, nowTimestamp },
  )

  assert.deepEqual(
    hourlyData.chart.periods.map(period => period.time),
    [closedTime],
  )
  assert.deepEqual(
    hourlyData.studies.socialDominance.periods.map(period => period.time),
    [closedTime],
  )
  assert.deepEqual(hourlyData.studies.socialDominance.coverage, {
    periodCount: 1,
    sourcePeriodCount: 1,
    completePeriods: 1,
    partialPeriods: 0,
    missingPeriods: 0,
    duplicatePeriodCount: 0,
    invalidTimestampCount: 0,
  })
})

test("bootstrap data keeps 2400-hour sources aligned with the shorter Volume Delta window", () => {
  const nowTimestamp = 1_800_000_000
  const chartData = createFetchedChartData()
  const closedTimes = Array.from(
    { length: 5 },
    (_, index) => nowTimestamp - (5 - index) * 3_600,
  )

  chartData.chart.periods = closedTimes.map(time => ({
    time,
    open: 1,
    max: 2,
    min: 0.5,
    close: 1.5,
    volume: 10,
  }))
  chartData.studies.socialDominance.value.periods = closedTimes.map(time => ({
    time,
    percent: 1,
  }))
  chartData.studies.volumeDelta = {
    status: "fulfilled",
    value: {
      request: { key: "volumeDelta" },
      fields: { close: "plotcandle_0_ohlc_close" },
      periods: closedTimes.map(time => ({ time, close: 0 })),
      coverage: { sourcePeriodCount: closedTimes.length },
    },
  }

  const hourlyData = createBootstrapHourlyData(
    chartData,
    createCoin(),
    {
      fetchHours: 4,
      nowTimestamp,
      volumeDeltaHours: 3,
    },
  )

  assert.deepEqual(
    hourlyData.chart.periods.map(period => period.time),
    closedTimes.slice(-4),
  )
  assert.deepEqual(
    hourlyData.studies.socialDominance.periods.map(period => period.time),
    closedTimes.slice(-4),
  )
  assert.deepEqual(
    hourlyData.studies.volumeDelta.periods.map(period => period.time),
    closedTimes.slice(-3),
  )
})

test("coverage checker validates and saves one anchored 2400/1666-hour snapshot", async () => {
  const nowTimestamp = 1_800_000_123
  const currentHour = Math.floor(nowTimestamp / 3_600) * 3_600
  const latestClosedTime = currentHour - 3_600
  const createPeriods = (hours, fields) => Array.from(
    { length: hours },
    (_, index) => ({
      time: latestClosedTime - (hours - index - 1) * 3_600,
      ...Object.fromEntries(fields.map(field => [field, 0])),
    }),
  )
  const requests = createCoverageStudyRequests("CRYPTO:BTCUSD")
  const chartData = {
    chart: {
      info: {
        fullName: "BINANCE:BTCUSDT.P",
        baseCurrencyId: "XTVCBTC",
      },
      periods: [
        ...createPeriods(2_400, ["open", "max", "min", "close", "volume"]),
        {
          time: currentHour,
          open: null,
          max: null,
          min: null,
          close: null,
          volume: null,
        },
      ],
    },
    studies: Object.fromEntries(requests.map((request) => {
      const fields = Object.keys(request.fields)
      const periods = request.key === "liquidations"
        ? [
            {
              time: latestClosedTime - 2_399 * 3_600,
              ...Object.fromEntries(fields.map(field => [field, 1])),
            },
            {
              time: latestClosedTime,
              ...Object.fromEntries(fields.map(field => [field, 2])),
            },
          ]
        : createPeriods(
            request.key === "volumeDelta" ? 1_666 : 2_400,
            fields,
          )

      if (request.key !== "volumeDelta" && request.key !== "liquidations") {
        periods.push({
          time: currentHour,
          ...Object.fromEntries(fields.map(field => [field, null])),
        })
      }

      return [request.key, {
        status: "fulfilled",
        value: {
          request,
          fields: request.fields,
          periods,
          coverage: { sourcePeriodCount: periods.length },
        },
      }]
    })),
  }
  let capturedOptions
  let savedHourlyData
  const checker = createCoinDataCoverageChecker({
    fetchChartStudies: async (_client, _requests, options) => {
      capturedOptions = options
      return chartData
    },
    saveHourlyData: async (_coin, hourlyData) => {
      savedHourlyData = hourlyData
      return "tmp/step2-data-bootstrap/BTC--XTVCBTC/data.json"
    },
  })

  const result = await checker({}, createCoin(), { nowTimestamp })

  assert.equal(result.complete, true)
  assert.equal(capturedOptions.range, 2_401)
  assert.equal(capturedOptions.to, currentHour - 1)
  assert.equal(savedHourlyData.chart.periods.length, 2_400)
  assert.equal(savedHourlyData.studies.volumeDelta.periods.length, 1_666)
  assert.equal(savedHourlyData.studies.openInterest.periods.length, 2_400)
  assert.equal(savedHourlyData.studies.liquidations.periods.length, 2_400)
  assert.ok(
    Object.keys(savedHourlyData.studies.liquidations.fields).every(
      field => savedHourlyData.studies.liquidations.periods[1][field] === 0,
    ),
  )
  assert.equal(savedHourlyData.chart.periods.at(-1).time, latestClosedTime)
  assert.equal(
    savedHourlyData.studies.openInterest.periods.at(-1).time,
    latestClosedTime,
  )
})

test("coverage checker saves one file only after accepting a coin", async () => {
  const events = []
  const nowTimestamp = 1_800_000_000
  let saved
  const checker = createCoinDataCoverageChecker({
    fetchChartStudies: async () => {
      events.push("fetched")
      return createFetchedChartData()
    },
    evaluateCoverage: () => {
      events.push("evaluated")
      return {
        complete: true,
        retryable: false,
        reasonCodes: [],
        reasons: [],
        unavailableMetrics: [],
        coverage: {},
      }
    },
    saveHourlyData: async (coin, hourlyData) => {
      events.push("saved")
      saved = { coin, hourlyData }
      return "tmp/step2-data-bootstrap/BTC--XTVCBTC/data.json"
    },
  })
  const coin = createCoin()
  const result = await checker({}, coin, {
    fetchHours: 24,
    nowTimestamp,
  })

  assert.deepEqual(events, ["fetched", "evaluated", "saved"])
  assert.equal(result.dataFile, "tmp/step2-data-bootstrap/BTC--XTVCBTC/data.json")
  assert.equal(saved.coin, coin)
  assert.equal(
    saved.hourlyData.collectedAt,
    new Date(nowTimestamp * 1_000).toISOString(),
  )
  assert.equal(saved.hourlyData.coin.marketSymbol, "BINANCE:BTCUSDT.P")
})

test("coverage checker discards data for a rejected coin", async () => {
  let saveCount = 0
  const checker = createCoinDataCoverageChecker({
    fetchChartStudies: async () => createFetchedChartData(),
    evaluateCoverage: () => ({
      complete: false,
      retryable: false,
      reasonCodes: ["ohlcv:missing_hours"],
      reasons: ["Missing hourly data"],
      unavailableMetrics: [],
      coverage: {},
    }),
    saveHourlyData: async () => {
      saveCount += 1
    },
  })

  const result = await checker({}, createCoin())

  assert.equal(result.complete, false)
  assert.equal(saveCount, 0)
  assert.equal("dataFile" in result, false)
})
