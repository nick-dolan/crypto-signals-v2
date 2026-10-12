import assert from "node:assert/strict"
import test from "node:test"

import { averageTrueRange, trueRange } from "../src/scripts/atr.js"
import { bollingerBandwidth } from "../src/scripts/bollinger-bandwidth.js"
import { realizedVolatility } from "../src/scripts/realized-volatility.js"
import { logReturns, simpleReturns } from "../src/scripts/returns.js"
import {
  rollingBeta,
  rollingCorrelation,
  rollingMean,
  rollingPercentileRank,
  rollingStandardDeviation,
  rollingZScore,
} from "../src/scripts/rolling-statistics.js"
import { relativeToSeasonalMedian } from "../src/scripts/seasonality.js"
import { difference, lag, ratioSeries } from "../src/scripts/series.js"

function assertClose (actual, expected) {
  assert.notEqual(actual, null)
  assert.ok(
    Math.abs(actual - expected) < 1e-12,
    `Expected ${actual} to be close to ${expected}`,
  )
}

test("returns and normalized differences preserve signs, offsets, gaps and zero denominators", () => {
  const source = [2, 4, 1, 0, 2, 4, null, 8]

  assert.deepEqual(simpleReturns(source), [null, 1, -0.75, -1, null, 1, null, null])
  assert.deepEqual(
    logReturns(source),
    [null, Math.log(2), Math.log(1 / 4), null, null, Math.log(2), null, null],
  )
  assert.deepEqual(simpleReturns(source, 2), [null, null, -0.5, -1, 1, null, null, 1])
  assert.deepEqual(
    ratioSeries(difference(source, 2), lag(source, 2)),
    [null, null, -0.5, -1, 1, null, null, 1],
  )
})

test("true range includes price gaps and ATR is its rolling mean", () => {
  const high = [10, 14, 9, 11]
  const low = [8, 12, 7, 9]
  const close = [9, 13, 8, 10]

  assert.deepEqual(trueRange(high, low, close), [null, 5, 6, 3])
  assert.deepEqual(averageTrueRange(high, low, close, 2), [null, null, 5.5, 4.5])
})

test("Bollinger bandwidth uses population deviation and rejects a zero mean", () => {
  const result = bollingerBandwidth([1, 2, 3, 4], 3, 2)

  assert.deepEqual(result.slice(0, 2), [null, null])
  assertClose(result[2], 2 * Math.sqrt(2 / 3))
  assertClose(result[3], 4 * Math.sqrt(2 / 3) / 3)
  assert.deepEqual(bollingerBandwidth([-1, 0, 1], 3, 2), [null, null, null])
})

test("realized volatility uses log returns and recovers only after a full window", () => {
  const result = realizedVolatility([1, 2, 4, 16], 2)

  assert.deepEqual(result.slice(0, 2), [null, null])
  assert.equal(result[2], 0)
  assertClose(result[3], Math.log(2) / 2)
  assert.deepEqual(
    realizedVolatility([1, 2, null, 4, 8, 16], 2),
    [null, null, null, null, null, 0],
  )
})

test("rolling mean preserves warmup, invalidates incomplete windows and recovers", () => {
  assert.deepEqual(
    rollingMean([1, 2, 3, 4, null, 6, 7, 8], 3),
    [null, null, 2, 3, null, null, null, 7],
  )
})

test("rolling statistics use population variance, current z-score and midrank ties", () => {
  assertClose(rollingStandardDeviation([1, 2, 3], 3)[2], Math.sqrt(2 / 3))
  assertClose(rollingZScore([1, 2, 3], 3)[2], Math.sqrt(3 / 2))
  assert.deepEqual(rollingZScore([5, 5, 5], 3), [null, null, 0])
  assert.deepEqual(rollingPercentileRank([1, 2, 2, 2], 4), [null, null, null, 0.625])
})

test("correlation and beta preserve direction, aligned gaps and zero-variance semantics", () => {
  const independent = [1, 2, 3, null, 5, 6, 7]
  const dependent = [-2, -4, -6, -8, -10, -12, -14]

  assert.deepEqual(
    rollingCorrelation(dependent, independent, 2),
    [null, -1, -1, null, null, -1, -1],
  )
  assert.deepEqual(
    rollingBeta(dependent, independent, 2),
    [null, -2, -2, null, null, -2, -2],
  )
  assert.equal(rollingCorrelation([1, 2, 3], [4, 4, 4], 3).at(-1), null)
  assert.equal(rollingBeta([1, 2, 3], [4, 4, 4], 3).at(-1), null)
  assert.equal(rollingCorrelation([4, 4, 4], [1, 2, 3], 3).at(-1), null)
  assert.equal(rollingBeta([4, 4, 4], [1, 2, 3], 3).at(-1), 0)
})

test("seasonal baseline uses only prior bucket observations and requires a valid median", () => {
  const result = relativeToSeasonalMedian([10, 20, 12, 24, 14, 30, 18], 2, 2)

  assert.deepEqual(result.slice(0, 4), [null, null, null, null])
  assertClose(result[4], 14 / 11)
  assertClose(result[5], 30 / 22)
  assertClose(result[6], 18 / 13)
  assert.deepEqual(
    relativeToSeasonalMedian([10, 20, null, 24, 14, 30], 2, 2),
    [null, null, null, null, null, 30 / 22],
  )
  assert.deepEqual(relativeToSeasonalMedian([-1, 1, 2], 1, 2), [null, null, null])
})
