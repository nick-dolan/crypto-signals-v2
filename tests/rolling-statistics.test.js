import assert from "node:assert/strict"
import test from "node:test"

import {
  rollingBeta,
  rollingCorrelation,
  rollingMaximum,
  rollingMean,
  rollingMedian,
  rollingMinimum,
  rollingPercentileRank,
  rollingStandardDeviation,
  rollingSum,
  rollingZScore,
} from "../src/scripts/rolling-statistics.js"

function assertClose (actual, expected) {
  assert.ok(
    Math.abs(actual - expected) < 1e-12,
    `Expected ${actual} to be close to ${expected}`,
  )
}

test("rolling aggregations preserve warmup and require complete windows", () => {
  const source = [1, 2, 3, 4, null, 6, 7, 8]

  assert.deepEqual(
    rollingSum(source, 3),
    [null, null, 6, 9, null, null, null, 21],
  )
  assert.deepEqual(
    rollingMean(source, 3),
    [null, null, 2, 3, null, null, null, 7],
  )
  assert.deepEqual(
    rollingMedian(source, 3),
    [null, null, 2, 3, null, null, null, 7],
  )
  assert.deepEqual(
    rollingMinimum(source, 3),
    [null, null, 1, 2, null, null, null, 6],
  )
  assert.deepEqual(
    rollingMaximum(source, 3),
    [null, null, 3, 4, null, null, null, 8],
  )
  assert.deepEqual(source, [1, 2, 3, 4, null, 6, 7, 8])
})

test("rolling standard deviation is population-based", () => {
  const result = rollingStandardDeviation([1, 2, 3], 3)

  assert.deepEqual(result.slice(0, 2), [null, null])
  assertClose(result[2], Math.sqrt(2 / 3))
})

test("rolling z-score uses the current value and handles zero variance", () => {
  const result = rollingZScore([1, 2, 3], 3)

  assert.deepEqual(result.slice(0, 2), [null, null])
  assertClose(result[2], Math.sqrt(3 / 2))
  assert.deepEqual(rollingZScore([5, 5, 5], 3), [null, null, 0])
})

test("rolling percentile rank includes current values and splits ties", () => {
  assert.deepEqual(
    rollingPercentileRank([1, 3, 2, 2], 4),
    [null, null, null, 0.5],
  )
  assert.deepEqual(
    rollingPercentileRank([1, 2, 3, 4], 4),
    [null, null, null, 0.875],
  )
})

test("rolling correlation and beta use aligned complete windows", () => {
  const independent = [1, 2, 3, 4, null, 6, 7, 8]
  const dependent = [2, 4, 6, 8, null, 12, 14, 16]
  const correlation = rollingCorrelation(dependent, independent, 3)
  const beta = rollingBeta(dependent, independent, 3)

  for (const index of [0, 1, 4, 5, 6]) {
    assert.equal(correlation[index], null)
    assert.equal(beta[index], null)
  }

  for (const index of [2, 3, 7]) {
    assertClose(correlation[index], 1)
    assertClose(beta[index], 2)
  }
})

test("rolling correlation and beta return null on denominator variance", () => {
  assert.deepEqual(
    rollingCorrelation([1, 2, 3], [4, 4, 4], 3),
    [null, null, null],
  )
  assert.deepEqual(
    rollingBeta([1, 2, 3], [4, 4, 4], 3),
    [null, null, null],
  )
})

test("rolling statistics reject malformed sources, windows, and pairs", () => {
  assert.throws(
    () => rollingMean("1,2,3", 2),
    /must be an array/,
  )
  assert.throws(
    () => rollingMean([1, undefined], 2),
    /finite number or null/,
  )
  assert.throws(
    () => rollingMean([1, 2, 3], 0),
    /positive integer/,
  )
  assert.throws(
    () => rollingCorrelation([1, 2], [1], 1),
    /equal lengths/,
  )
})
