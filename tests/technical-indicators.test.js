import assert from "node:assert/strict"
import test from "node:test"

import { averageTrueRange, trueRange } from "../src/scripts/atr.js"
import { bollingerBandwidth } from "../src/scripts/bollinger-bandwidth.js"
import { realizedVolatility } from "../src/scripts/realized-volatility.js"
import { logReturns, simpleReturns } from "../src/scripts/returns.js"
import { relativeToSeasonalMedian } from "../src/scripts/seasonality.js"

function assertClose (actual, expected) {
  assert.ok(
    Math.abs(actual - expected) < 1e-12,
    `Expected ${actual} to be close to ${expected}`,
  )
}

test("simple and log returns preserve warmups and null gaps", () => {
  const source = [1, 2, 4, null, 8, 0, 2]

  assert.deepEqual(
    simpleReturns(source),
    [null, 1, 1, null, null, -1, null],
  )

  const logarithmic = logReturns([1, 2, 4, null, 8, 0, 2])
  assert.equal(logarithmic[0], null)
  assertClose(logarithmic[1], Math.log(2))
  assertClose(logarithmic[2], Math.log(2))
  assert.deepEqual(logarithmic.slice(3), [null, null, null, null])
  assert.deepEqual(source, [1, 2, 4, null, 8, 0, 2])
})

test("returns support longer offsets", () => {
  assert.deepEqual(
    simpleReturns([2, 4, 8, 16], 2),
    [null, null, 3, 3],
  )
})

test("true range uses the previous close and ATR is its rolling mean", () => {
  const high = [10, 12, 13, 15]
  const low = [8, 9, 11, 12]
  const close = [9, 11, 12, 14]

  assert.deepEqual(trueRange(high, low, close), [null, 3, 2, 3])
  assert.deepEqual(
    averageTrueRange(high, low, close, 2),
    [null, null, 2.5, 2.5],
  )
  assert.deepEqual(high, [10, 12, 13, 15])
  assert.deepEqual(low, [8, 9, 11, 12])
  assert.deepEqual(close, [9, 11, 12, 14])
})

test("true range only needs the current high, low, and previous close", () => {
  assert.deepEqual(
    trueRange([10, 12, 13], [8, 9, 11], [9, null, 12]),
    [null, 3, null],
  )
})

test("Bollinger bandwidth uses population deviation and nulls zero means", () => {
  const result = bollingerBandwidth([1, 2, 3, 4], 3, 2)

  assert.deepEqual(result.slice(0, 2), [null, null])
  assertClose(result[2], 2 * Math.sqrt(2 / 3))
  assertClose(result[3], 4 * Math.sqrt(2 / 3) / 3)
  assert.deepEqual(
    bollingerBandwidth([-1, 0, 1], 3, 2),
    [null, null, null],
  )
})

test("realized volatility is rolling population deviation of log returns", () => {
  const result = realizedVolatility([1, 2, 4, 16], 2)

  assert.deepEqual(result.slice(0, 2), [null, null])
  assertClose(result[2], 0)
  assertClose(result[3], Math.log(2) / 2)
  assert.deepEqual(
    realizedVolatility([1, 2, null, 4, 8, 16], 2),
    [null, null, null, null, null, 0],
  )
})

test("seasonal relative uses only prior observations from the same bucket", () => {
  const source = [10, 20, 12, 24, 14, 30, 18]
  const result = relativeToSeasonalMedian(source, 2, 2)

  assert.deepEqual(result.slice(0, 4), [null, null, null, null])
  assertClose(result[4], 14 / 11)
  assertClose(result[5], 30 / 22)
  assertClose(result[6], 18 / 13)
  assert.deepEqual(source, [10, 20, 12, 24, 14, 30, 18])
})

test("seasonal relative requires a full finite non-zero baseline", () => {
  assert.deepEqual(
    relativeToSeasonalMedian([10, 20, null, 24, 14, 30], 2, 2),
    [null, null, null, null, null, 30 / 22],
  )
  assert.deepEqual(
    relativeToSeasonalMedian([-1, 1, 2], 1, 2),
    [null, null, null],
  )
})

test("technical indicators validate integer arguments and aligned arrays", () => {
  assert.throws(
    () => simpleReturns([1, 2], 0),
    /positive integer/,
  )
  assert.throws(
    () => trueRange([1, 2], [0], [1, 2]),
    /equal lengths/,
  )
  assert.throws(
    () => bollingerBandwidth([1, 2], 0),
    /positive integer/,
  )
  assert.throws(
    () => realizedVolatility([1, 2], 1.5),
    /positive integer/,
  )
  assert.throws(
    () => relativeToSeasonalMedian([1, 2], 0, 2),
    /positive integer/,
  )
})
