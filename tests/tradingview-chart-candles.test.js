import assert from "node:assert/strict"
import test from "node:test"

import { fetchTradingViewChartPeriods } from "../src/api/tradingview/chart-candles.js"

function createFakeClient ({ error, periods = [] } = {}) {
  let chartInstance = null

  class FakeChart {
    constructor () {
      this.periods = []
      this.deleted = false
      chartInstance = this
    }

    onError (callback) {
      this.errorCallback = callback
    }

    onUpdate (callback) {
      this.updateCallback = callback
    }

    setMarket (symbol, options) {
      this.symbol = symbol
      this.options = options

      queueMicrotask(() => {
        if (error) {
          this.errorCallback(error)
          return
        }

        this.periods = periods
        this.updateCallback(["$prices"])
      })
    }

    delete () {
      this.deleted = true
    }
  }

  return {
    client: {
      Session: {
        Chart: FakeChart,
      },
    },
    getChart: () => chartInstance,
  }
}

test("TradingView chart fetcher returns periods and deletes the chart", async () => {
  const periods = [
    {
      time: 1_800_000_000,
      open: 1,
      max: 2,
      min: 1,
      close: 2,
      volume: 10,
    },
  ]
  const { client, getChart } = createFakeClient({ periods })

  const result = await fetchTradingViewChartPeriods(client, {
    range: 300,
    settleDelayMs: 0,
    symbol: "CRYPTOCAP:BTC",
    timeframe: "60",
    timeoutMs: 100,
  })

  assert.deepEqual(result, periods)
  assert.equal(getChart().symbol, "CRYPTOCAP:BTC")
  assert.deepEqual(getChart().options, {
    timeframe: "60",
    range: 300,
  })
  assert.equal(getChart().deleted, true)
})

test("TradingView chart fetcher reports chart errors and deletes the chart", async () => {
  const { client, getChart } = createFakeClient({
    error: new Error("Unknown symbol"),
  })

  await assert.rejects(
    fetchTradingViewChartPeriods(client, {
      range: 300,
      settleDelayMs: 0,
      symbol: "CRYPTOCAP:UNKNOWN",
      timeframe: "60",
      timeoutMs: 100,
    }),
    /CRYPTOCAP:UNKNOWN error: Unknown symbol/,
  )

  assert.equal(getChart().deleted, true)
})
