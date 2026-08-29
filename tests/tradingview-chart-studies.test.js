import assert from "node:assert/strict"
import test from "node:test"
import { createTradingViewChartStudiesFetcher } from "../src/api/tradingview/chart-studies.js"

function createFakeClient ({ chartError } = {}) {
  const state = {
    chart: null,
    deleted: 0,
  }

  class FakeChart {
    constructor () {
      this.periods = [
        {
          time: 120,
          open: 2,
          max: 3,
          min: 1,
          close: 2.5,
          volume: 20,
        },
        {
          time: 60,
          open: 1,
          max: 2,
          min: 0.5,
          close: 2,
          volume: 10,
        },
      ]
      this.infos = {
        full_name: "BINANCE:BTCUSDT.P",
        exchange: "BINANCE",
        base_currency_id: "XTVCBTC",
        currency_code: "USDT",
        type: "futures",
        typespecs: ["crypto", "perpetual"],
      }
      state.chart = this
    }

    onError (callback) {
      this.errorCallback = callback
    }

    onSymbolLoaded (callback) {
      this.symbolLoadedCallback = callback
    }

    onUpdate (callback) {
      this.updateCallback = callback
    }

    setMarket (symbol, options) {
      this.symbol = symbol
      this.options = options

      queueMicrotask(() => {
        if (chartError) {
          this.errorCallback(chartError)
          return
        }

        this.symbolLoadedCallback()
        this.updateCallback(["$prices"])
      })
    }

    delete () {
      state.deleted += 1
    }
  }

  return {
    client: {
      Session: {
        Chart: FakeChart,
      },
    },
    state,
  }
}

test("chart studies fetcher returns candles and individual study statuses", async () => {
  const { client, state } = createFakeClient()
  const calls = []
  const fetchChartStudies = createTradingViewChartStudiesFetcher({
    fetchStudy: async (chart, request, options) => {
      calls.push({ chart, request, options })

      if (request.key === "missing") {
        throw new Error("No data")
      }

      return {
        periods: [{ time: 60, value: 1 }],
      }
    },
  })

  const result = await fetchChartStudies(
    client,
    [
      { key: "working", id: "STD;Working" },
      { key: "missing", id: "STD;Missing" },
    ],
    {
      symbol: "BINANCE:BTCUSDT.P",
      timeframe: "60",
      range: 168,
      timeoutMs: 100,
      settleDelayMs: 0,
      studySettleDelayMs: 0,
    },
  )

  assert.equal(state.chart.symbol, "BINANCE:BTCUSDT.P")
  assert.deepEqual(state.chart.options, {
    timeframe: "60",
    range: 168,
  })
  assert.deepEqual(result.chart.info, {
    fullName: "BINANCE:BTCUSDT.P",
    exchange: "BINANCE",
    baseCurrencyId: "XTVCBTC",
    quoteCurrency: "USDT",
    instrumentType: "futures",
    typeSpecifications: ["crypto", "perpetual"],
  })
  assert.deepEqual(
    result.chart.periods.map(period => period.time),
    [60, 120],
  )
  assert.equal(result.studies.working.status, "fulfilled")
  assert.equal(result.studies.missing.status, "rejected")
  assert.match(result.studies.missing.reason.message, /No data/)
  assert.equal(calls.length, 2)
  assert.deepEqual(calls[0].options, {
    timeoutMs: 100,
    settleDelayMs: 0,
  })
  assert.equal(state.deleted, 1)
})

test("chart studies fetcher deletes a chart after a chart error", async () => {
  const { client, state } = createFakeClient({
    chartError: new Error("Unknown symbol"),
  })
  const fetchChartStudies = createTradingViewChartStudiesFetcher({
    fetchStudy: async () => ({}),
  })

  await assert.rejects(
    fetchChartStudies(
      client,
      [{ key: "working", id: "STD;Working" }],
      {
        symbol: "BINANCE:UNKNOWN.P",
        timeframe: "60",
        range: 168,
        timeoutMs: 100,
        settleDelayMs: 0,
      },
    ),
    /BINANCE:UNKNOWN.P error: Unknown symbol/,
  )

  assert.equal(state.deleted, 1)
})
