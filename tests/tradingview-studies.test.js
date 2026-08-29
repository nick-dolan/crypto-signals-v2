import assert from "node:assert/strict"
import test from "node:test"
import {
  createTradingViewStudiesFetcher,
} from "../src/api/tradingview/studies/index.js"

function createFakeClient (state) {
  return {
    Session: {
      Chart: class FakeChart {
        constructor () {
          this.id = state.created + 1
          this.errorCallbacks = []
          this.symbolLoadedCallbacks = []
          state.created += 1
        }

        onError (callback) {
          this.errorCallbacks.push(callback)
        }

        onSymbolLoaded (callback) {
          this.symbolLoadedCallbacks.push(callback)
        }

        setMarket (symbol, options) {
          state.markets.push({
            chartId: this.id,
            symbol,
            options,
          })

          queueMicrotask(() => {
            this.symbolLoadedCallbacks.forEach(callback => callback())
          })
        }

        delete () {
          state.deleted += 1
        }
      },
    },
  }
}

function createRequests (count) {
  return Array.from({ length: count }, (_, index) => ({
    key: `indicator${index + 1}`,
    id: `STD;Indicator_${index + 1}`,
  }))
}

test("batch fetcher chunks requests and returns results by key", async () => {
  const state = {
    created: 0,
    deleted: 0,
    markets: [],
    studies: [],
  }
  const client = createFakeClient(state)
  const fetchStudies = createTradingViewStudiesFetcher({
    fetchStudy: async (chart, request, options) => {
      state.studies.push({
        chartId: chart.id,
        key: request.key,
        options,
      })

      return {
        chartId: chart.id,
        key: request.key,
      }
    },
  })

  const results = await fetchStudies(
    client,
    createRequests(5),
    {
      symbol: "BINANCE:BTCUSDT",
      timeframe: "60",
      range: 100,
      to: 1_700_000_000,
      timeoutMs: 100,
      settleDelayMs: 0,
      maxStudiesPerChart: 2,
    },
  )

  assert.deepEqual(Object.keys(results), [
    "indicator1",
    "indicator2",
    "indicator3",
    "indicator4",
    "indicator5",
  ])
  assert.equal(state.created, 3)
  assert.equal(state.deleted, 3)
  assert.equal(state.markets.length, 3)
  assert.equal(state.studies.length, 5)
  assert.deepEqual(
    state.studies.map(study => study.chartId),
    [1, 1, 2, 2, 3],
  )
  assert.deepEqual(state.markets[0], {
    chartId: 1,
    symbol: "BINANCE:BTCUSDT",
    options: {
      timeframe: "60",
      range: 100,
      to: 1_700_000_000,
    },
  })
})

test("batch fetcher defaults to 25 studies per chart", async () => {
  const state = {
    created: 0,
    deleted: 0,
    markets: [],
    chartIds: [],
  }
  const client = createFakeClient(state)
  const fetchStudies = createTradingViewStudiesFetcher({
    fetchStudy: async (chart) => {
      state.chartIds.push(chart.id)
      return { chartId: chart.id }
    },
  })

  await fetchStudies(
    client,
    createRequests(26),
    {
      symbol: "BINANCE:BTCUSDT",
      timeframe: "60",
      timeoutMs: 100,
    },
  )

  assert.equal(state.created, 2)
  assert.equal(state.deleted, 2)
  assert.deepEqual(state.chartIds, [
    ...Array.from({ length: 25 }, () => 1),
    2,
  ])
})

test("batch fetcher aggregates study failures and deletes the chart", async () => {
  const state = {
    created: 0,
    deleted: 0,
    markets: [],
  }
  const client = createFakeClient(state)
  const fetchStudies = createTradingViewStudiesFetcher({
    fetchStudy: async (chart, request) => {
      if (request.key === "broken") {
        throw new Error("Unsupported indicator")
      }

      return { chartId: chart.id }
    },
  })

  await assert.rejects(
    fetchStudies(
      client,
      [
        { key: "working", id: "STD;Working" },
        { key: "broken", id: "STD;Broken" },
      ],
      {
        symbol: "BINANCE:BTCUSDT",
        timeframe: "60",
        timeoutMs: 100,
      },
    ),
    error => (
      error instanceof AggregateError
      && error.message.includes("broken: Unsupported indicator")
    ),
  )

  assert.equal(state.created, 1)
  assert.equal(state.deleted, 1)
})

test("batch fetcher rejects duplicate result keys before creating a chart", async () => {
  const state = {
    created: 0,
    deleted: 0,
    markets: [],
  }
  const client = createFakeClient(state)
  const fetchStudies = createTradingViewStudiesFetcher({
    fetchStudy: async () => ({}),
  })

  await assert.rejects(
    fetchStudies(
      client,
      [
        { key: "duplicate", id: "STD;One" },
        { key: "duplicate", id: "STD;Two" },
      ],
      {
        symbol: "BINANCE:BTCUSDT",
        timeframe: "60",
      },
    ),
    /Duplicate TradingView study key duplicate/,
  )

  assert.equal(state.created, 0)
})

test("batch fetcher snapshots nested requests and the window", async () => {
  const state = {
    created: 0,
    deleted: 0,
    markets: [],
  }
  const client = createFakeClient(state)
  let capturedRequest
  let capturedOptions
  const fetchStudies = createTradingViewStudiesFetcher({
    fetchStudy: async (chart, request, options) => {
      capturedRequest = request
      capturedOptions = options
      return { chartId: chart.id }
    },
  })
  const request = {
    key: "ema50",
    id: "STD;EMA",
    inputs: { Length: 50 },
    fields: { value: "EMA" },
  }
  const window = {
    start: 0,
    end: 180,
  }
  const resultPromise = fetchStudies(
    client,
    [request],
    {
      symbol: "BINANCE:BTCUSDT",
      timeframe: "60",
      window,
      timeframeSeconds: 60,
      timeoutMs: 100,
    },
  )

  request.inputs.Length = 200
  request.fields.value = "Changed"
  window.end = 360

  await resultPromise

  assert.deepEqual(capturedRequest.inputs, { Length: 50 })
  assert.deepEqual(capturedRequest.fields, { value: "EMA" })
  assert.deepEqual(capturedOptions.window, {
    start: 0,
    end: 180,
  })
  assert.equal(Object.isFrozen(capturedRequest.inputs), true)
  assert.equal(Object.isFrozen(capturedRequest.fields), true)
  assert.equal(Object.isFrozen(capturedOptions.window), true)
})

test("batch fetcher safely returns a study keyed as __proto__", async () => {
  const state = {
    created: 0,
    deleted: 0,
    markets: [],
  }
  const client = createFakeClient(state)
  const fetchStudies = createTradingViewStudiesFetcher({
    fetchStudy: async () => ({ value: 42 }),
  })

  const results = await fetchStudies(
    client,
    [{ key: "__proto__", id: "STD;Prototype" }],
    {
      symbol: "BINANCE:BTCUSDT",
      timeframe: "60",
      timeoutMs: 100,
    },
  )

  assert.equal(Object.getPrototypeOf(results), Object.prototype)
  assert.equal(Object.hasOwn(results, "__proto__"), true)
  assert.deepEqual(results.__proto__, { value: 42 })
})
