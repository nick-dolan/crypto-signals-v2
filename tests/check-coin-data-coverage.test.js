import assert from "node:assert/strict"
import path from "node:path"
import test from "node:test"
import {
  createBootstrapDataRelativePath,
  createBootstrapHourlyData,
  createCoinDataCoverageChecker,
} from "../src/steps/step2-data-bootstrap/check-coin-data-coverage.js"

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
      probeHours: 24,
      studySettleDelayMs: 20,
      timeoutMs: 30,
    }),
    error => error === expectedError,
  )

  assert.equal(capturedClient, client)
  assert.equal(capturedOptions.symbol, coin.market.tradingViewSymbol)
  assert.equal(capturedOptions.timeframe, "60")
  assert.equal(capturedOptions.range, 2_400)
  assert.equal(capturedOptions.settleDelayMs, 10)
  assert.equal(capturedOptions.studySettleDelayMs, 20)
  assert.equal(capturedOptions.timeoutMs, 30)
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
    baseCurrencyId: "XTVCBTC",
    symbol: "BTC",
    name: "Bitcoin",
    tradingViewSymbol: "CRYPTO:BTCUSD",
    market: {
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
    { fetchHours: 24, nowTimestamp },
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
  })
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
      reasonCodes: ["ohlcv:insufficient_history"],
      reasons: ["Insufficient history"],
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
