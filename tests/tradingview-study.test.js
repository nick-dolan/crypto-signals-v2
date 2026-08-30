import assert from "node:assert/strict"
import test from "node:test"
import {
  createTradingViewStudyFetcher,
} from "../src/api/tradingview/studies/index.js"

function createFakeChart (sourcePeriods, state) {
  return {
    Study: class FakeStudy {
      constructor (indicator) {
        this.indicator = indicator
        this.periods = sourcePeriods
        this.errorCallbacks = []
        this.readyCallbacks = []
        this.updateCallbacks = []

        queueMicrotask(() => {
          if (state.errorMessages) {
            this.errorCallbacks.forEach(callback => callback(...state.errorMessages))
            return
          }

          this.readyCallbacks.forEach(callback => callback())
          this.updateCallbacks.forEach(callback => callback(["plots"]))
        })
      }

      onError (callback) {
        this.errorCallbacks.push(callback)
      }

      onReady (callback) {
        this.readyCallbacks.push(callback)
      }

      onUpdate (callback) {
        this.updateCallbacks.push(callback)
      }

      remove () {
        state.removed += 1
      }
    },
  }
}

function createIndicatorFactory (plots) {
  return async request => ({
    indicator: { id: request.id },
    metadata: Object.freeze({
      requestedId: request.id,
      requestedVersion: request.version,
      id: request.id,
      version: "7.0",
      name: request.name || request.key,
      shortName: request.key,
      type: "Script@tv-scripting-101!",
      inputs: Object.freeze({}),
      plots: Object.freeze({ ...plots }),
    }),
  })
}

test("study fetcher discovers raw plots and normalizes periods", async () => {
  const state = { removed: 0 }
  const chart = createFakeChart([
    { $time: 120, EMA: 3 },
    { $time: 60, EMA: 2 },
    { $time: 0, EMA: 1e100 },
  ], state)
  const fetchStudy = createTradingViewStudyFetcher({
    createIndicator: createIndicatorFactory({ plot_0: "EMA" }),
  })

  const result = await fetchStudy(
    chart,
    {
      key: "ema50",
      id: "STD;EMA",
      inputs: { Length: 50 },
    },
    {
      timeoutMs: 100,
      settleDelayMs: 0,
    },
  )

  assert.deepEqual(result.fields, { EMA: "EMA" })
  assert.deepEqual(result.periods, [
    { time: 0, EMA: null },
    { time: 60, EMA: 2 },
    { time: 120, EMA: 3 },
  ])
  assert.deepEqual(result.coverage, {
    periodCount: 3,
    sourcePeriodCount: 3,
    completePeriods: 2,
    partialPeriods: 0,
    missingPeriods: 1,
  })
  assert.equal(result.request.version, "last")
  assert.equal(state.removed, 1)
})

test("study fetcher preserves structured TradingView error details", async () => {
  const state = {
    removed: 0,
    errorMessages: [{ code: "study_not_supported" }, undefined],
  }
  const fetchStudy = createTradingViewStudyFetcher({
    createIndicator: createIndicatorFactory({ plot_0: "Value" }),
  })

  await assert.rejects(
    fetchStudy(
      createFakeChart([], state),
      {
        key: "missingMetric",
        id: "STD;Missing_Metric",
      },
      {
        timeoutMs: 100,
        settleDelayMs: 0,
      },
    ),
    /\{"code":"study_not_supported"\}/,
  )

  assert.equal(state.removed, 1)
})

test("study fetcher applies a field contract to a fixed time window", async () => {
  const state = { removed: 0 }
  const chart = createFakeChart([
    { $time: 180, MACD: 4, Signal: 3 },
    { $time: 120, MACD: 3, Signal: 2 },
    { $time: 60, MACD: 2, Signal: 1 },
    { $time: 0, MACD: 1, Signal: 0 },
  ], state)
  const fetchStudy = createTradingViewStudyFetcher({
    createIndicator: createIndicatorFactory({
      plot_0: "MACD",
      plot_1: "Signal",
    }),
  })

  const result = await fetchStudy(
    chart,
    {
      key: "macd",
      id: "STD;MACD",
      fields: {
        value: "MACD",
        signal: "Signal",
      },
    },
    {
      window: {
        start: 0,
        end: 180,
      },
      timeframeSeconds: 60,
      timeoutMs: 100,
      settleDelayMs: 0,
    },
  )

  assert.deepEqual(result.periods, [
    { time: 0, value: 1, signal: 0 },
    { time: 60, value: 2, signal: 1 },
    { time: 120, value: 3, signal: 2 },
  ])
  assert.deepEqual(result.coverage, {
    periodCount: 3,
    sourcePeriodCount: 3,
    completePeriods: 3,
    partialPeriods: 0,
    missingPeriods: 0,
  })
  assert.equal(state.removed, 1)
})

test("study fetcher rejects unknown contract plots and removes the study", async () => {
  const state = { removed: 0 }
  const chart = createFakeChart([
    { $time: 0, EMA: 1 },
  ], state)
  const fetchStudy = createTradingViewStudyFetcher({
    createIndicator: createIndicatorFactory({ plot_0: "EMA" }),
  })

  await assert.rejects(
    fetchStudy(
      chart,
      {
        key: "ema",
        id: "STD;EMA",
        fields: { value: "Missing" },
      },
      {
        timeoutMs: 100,
        settleDelayMs: 0,
      },
    ),
    /unknown plots Missing/,
  )

  assert.equal(state.removed, 1)
})

test("study fetcher reserves time for the normalized period timestamp", async () => {
  const state = { removed: 0 }
  const chart = createFakeChart([
    { $time: 0, EMA: 1 },
  ], state)
  const fetchStudy = createTradingViewStudyFetcher({
    createIndicator: createIndicatorFactory({ plot_0: "EMA" }),
  })

  await assert.rejects(
    fetchStudy(
      chart,
      {
        key: "ema",
        id: "STD;EMA",
        fields: { time: "EMA" },
      },
      {
        timeoutMs: 100,
        settleDelayMs: 0,
      },
    ),
    /field time is reserved/,
  )

  assert.equal(state.removed, 0)
})

test("study fetcher requires an alias for a TradingView plot named time", async () => {
  const rawState = { removed: 0 }
  const fetchStudy = createTradingViewStudyFetcher({
    createIndicator: createIndicatorFactory({ plot_0: "time" }),
  })

  await assert.rejects(
    fetchStudy(
      createFakeChart([{ $time: 0, time: 42 }], rawState),
      {
        key: "timePlot",
        id: "STD;Time_Plot",
      },
      {
        timeoutMs: 100,
        settleDelayMs: 0,
      },
    ),
    /plot time conflicts with the period timestamp/,
  )

  const aliasedState = { removed: 0 }
  const result = await fetchStudy(
    createFakeChart([{ $time: 0, time: 42 }], aliasedState),
    {
      key: "timePlot",
      id: "STD;Time_Plot",
      fields: { value: "time" },
    },
    {
      timeoutMs: 100,
      settleDelayMs: 0,
    },
  )

  assert.deepEqual(result.periods, [{ time: 0, value: 42 }])
  assert.equal(rawState.removed, 1)
  assert.equal(aliasedState.removed, 1)
})
