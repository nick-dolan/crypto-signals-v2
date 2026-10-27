import assert from "node:assert/strict"
import test from "node:test"
import { ChartSession } from "@mathieuc/tradingview"

import { fetchTradingViewChartPeriods } from "../src/api/tradingview/chart-candles.js"
import { createTradingViewChartStudiesFetcher } from "../src/api/tradingview/chart-studies.js"
import { summarizeChartCoverage } from "../src/steps/step2-data-bootstrap/data-coverage-helpers.js"

function createChartFixture (rows = [
  { i: 1, v: [7_200, 14, 20, 9, 16, 2.675] },
  { i: 2, v: [10_800, 16, 25, 11, 20, 1_234.56789] },
  { i: 0, v: [3_600, 10, 15, 8, 12, 0.004] },
]) {
  const sessions = new Map()
  const charts = []
  const messages = []
  const client = {
    isClosed: false,
    log () {},
    registerSession (id, handler) {
      sessions.set(id, handler)
    },
    unregisterSession (id) {
      sessions.delete(id)
    },
    createChart () {
      const chart = new ChartSession(this)
      charts.push(chart)
      return chart
    },
    send (method, params) {
      messages.push({ method, params })

      if (method === "resolve_symbol") {
        queueMicrotask(() => sessions.get(params[0])?.onPacket({
          m: "symbol_resolved",
          p: [params[0], params[1], {
            full_name: "BINANCE:TESTUSDT.P",
            exchange: "BINANCE",
            base_currency_id: "XTVCTEST",
            currency_code: "USDT",
            type: "crypto",
            typespecs: ["perpetual"],
          }],
        }))
      }

      if (method === "create_series") {
        queueMicrotask(() => sessions.get(params[0])?.onPacket({
          m: "timescale_update",
          p: [params[0], {
            $prices: {
              s: rows,
            },
          }],
        }))
      }
    },
  }

  return { client, charts, messages }
}

test("native charts retain app high/low fields, v3 volume rounding and each fetcher's candle order", async () => {
  const expected = [
    { time: 3_600, open: 10, max: 15, min: 8, close: 12, volume: 0 },
    { time: 7_200, open: 14, max: 20, min: 9, close: 16, volume: 2.68 },
    { time: 10_800, open: 16, max: 25, min: 11, close: 20, volume: 1_234.57 },
  ]
  const candlesFixture = createChartFixture()
  const periods = await fetchTradingViewChartPeriods(candlesFixture.client, {
    symbol: "BINANCE:TESTUSDT.P", timeframe: "60", range: 3, to: 10_800,
    settleDelayMs: 0, timeoutMs: 1_000,
  })

  assert.deepEqual(periods, [...expected].reverse())

  const studiesFixture = createChartFixture()
  const fetchChartStudies = createTradingViewChartStudiesFetcher({
    fetchStudy: async () => ({ periods: [] }),
  })
  const result = await fetchChartStudies(studiesFixture.client, [{ key: "test" }], {
    symbol: "BINANCE:TESTUSDT.P", timeframe: "60", range: 3, to: 10_800,
    settleDelayMs: 0, timeoutMs: 1_000,
  })

  assert.deepEqual(result.chart.periods, expected)
  assert.deepEqual(result.chart.info, {
    fullName: "BINANCE:TESTUSDT.P",
    exchange: "BINANCE",
    baseCurrencyId: "XTVCTEST",
    quoteCurrency: "USDT",
    instrumentType: "crypto",
    typeSpecifications: ["perpetual"],
  })

  for (const fixture of [candlesFixture, studiesFixture]) {
    assert.deepEqual(
      fixture.messages.find(message => message.method === "create_series").params.slice(1),
      ["$prices", "s1", "ser_1", "60", ["bar_count", 10_800, 3]],
    )
    assert.equal(fixture.charts[0].isDeleted, true)
  }
})

test("missing candle volume stays invalid while genuine zero volume is preserved", async () => {
  const { client } = createChartFixture([
    { i: 0, v: [3_600, 10, 15, 8, 12, 0] },
    { i: 1, v: [7_200, 14, 20, 9, 16] },
  ])
  const fetchChartStudies = createTradingViewChartStudiesFetcher({
    fetchStudy: async () => ({ periods: [] }),
  })
  const result = await fetchChartStudies(client, [{ key: "test" }], {
    symbol: "BINANCE:TESTUSDT.P", timeframe: "60", range: 2,
    settleDelayMs: 0, timeoutMs: 1_000,
  })

  assert.equal(result.chart.periods[0].volume, 0)
  assert.equal(result.chart.periods[1].volume, NaN)
  const coverage = summarizeChartCoverage(result.chart.periods, 10_800, 2)
  assert.equal(coverage.complete, false)
  assert.equal(coverage.fieldMissingValueCounts.volume, 1)
})
