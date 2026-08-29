import assert from "node:assert/strict"
import test from "node:test"

import { calculateMarketBias } from "../src/steps/step1-market-bias/calculate-market-bias.js"

const START_TIME = 1_800_000_000
const PERIOD_COUNT = 35
const PIVOT_INDEX = 20
const CONFIRMATION_INDEX = 30
const LATEST_INDEX = PERIOD_COUNT - 1

function createPeriods (latestPivotType) {
  const periods = Array.from({ length: PERIOD_COUNT }, (_, index) => ({
    time: START_TIME + index * 3_600,
    open: 600,
    max: 700 + index,
    min: 400 + index,
    close: 600,
    volume: 0,
  }))

  if (latestPivotType === "low") {
    periods[12].max = 1_000
    periods[PIVOT_INDEX].min = 100
    periods[LATEST_INDEX].close = 600
  } else {
    periods[12].min = 100
    periods[PIVOT_INDEX].max = 1_000
    periods[LATEST_INDEX].close = 700
  }

  return periods.toReversed()
}

function createRawSnapshot (latestPivotType = "low") {
  const periods = createPeriods(latestPivotType)
  const latestTime = START_TIME + LATEST_INDEX * 3_600
  const generatedAt = new Date((latestTime + 34 * 60) * 1_000).toISOString()
  const marketCaps = Object.fromEntries([
    ["BTC_CAP", "CRYPTOCAP:BTC"],
    ["ALT_CAP", "CRYPTOCAP:TOTAL2ES"],
    ["STABLE_CAP", "CRYPTOCAP:TOTAL-CRYPTOCAP:TOTALES"],
  ].map(([key, symbol]) => [
    key,
    {
      symbol,
      timeframe: "60",
      candleCount: periods.length,
      periods,
    },
  ]))

  return {
    generatedAt,
    fearAndGreedIndex: {
      value: 74,
      classification: "Greed",
      asOf: "2026-08-25T00:00:00.000Z",
    },
    marketCaps,
  }
}

test("market bias uses the latest confirmed high or low pivot", () => {
  const rawSnapshot = createRawSnapshot("low")
  const result = calculateMarketBias(rawSnapshot)
  const latestTime = START_TIME + LATEST_INDEX * 3_600
  const pivotTime = START_TIME + PIVOT_INDEX * 3_600
  const confirmationTime = START_TIME + CONFIRMATION_INDEX * 3_600

  assert.deepEqual(result.marketCaps.BTC_CAP, {
    symbol: "CRYPTOCAP:BTC",
    timeframe: "60",
    latestClose: {
      value: 600,
      candleTime: latestTime,
      candleDatetime: new Date(latestTime * 1_000).toISOString(),
      capturedAt: rawSnapshot.generatedAt,
    },
    latestPivot: {
      type: "low",
      value: 100,
      time: pivotTime,
      datetime: new Date(pivotTime * 1_000).toISOString(),
      confirmedAt: new Date(confirmationTime * 1_000).toISOString(),
      relativeTime: "15 hours ago",
      changeToLatestClose: {
        value: 500,
        percent: 500,
        direction: "up",
      },
    },
  })
  assert.deepEqual(Object.keys(result.marketCaps), [
    "BTC_CAP",
    "ALT_CAP",
    "STABLE_CAP",
  ])
  assert.equal(Object.hasOwn(result.marketCaps.BTC_CAP, "periods"), false)
  assert.deepEqual(result.fearAndGreedIndex, rawSnapshot.fearAndGreedIndex)
})

test("market bias reports a decline from the latest pivot high", () => {
  const result = calculateMarketBias(createRawSnapshot("high"))
  const latestPivot = result.marketCaps.BTC_CAP.latestPivot

  assert.equal(latestPivot.type, "high")
  assert.equal(latestPivot.value, 1_000)
  assert.deepEqual(latestPivot.changeToLatestClose, {
    value: -300,
    percent: -30,
    direction: "down",
  })
})

test("market bias rejects a series without a confirmed pivot", () => {
  const rawSnapshot = createRawSnapshot()
  const periods = rawSnapshot.marketCaps.BTC_CAP.periods.slice(0, 20)

  rawSnapshot.marketCaps.BTC_CAP = {
    ...rawSnapshot.marketCaps.BTC_CAP,
    candleCount: periods.length,
    periods,
  }

  assert.throws(
    () => calculateMarketBias(rawSnapshot),
    /BTC_CAP does not contain a confirmed pivot/,
  )
})
