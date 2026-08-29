import assert from "node:assert/strict"
import test from "node:test"

import { pivotHigh, pivotLow } from "../src/scripts/pivots.js"

test("pivotHigh returns pivots on their Pine confirmation bars", () => {
  assert.deepEqual(
    pivotHigh([1, 2, 4, 3, 2, 5, 4, 3], 2, 2),
    [null, null, null, null, 4, null, null, 5],
  )
})

test("pivotLow returns pivots on their Pine confirmation bars", () => {
  assert.deepEqual(
    pivotLow([5, 4, 2, 3, 4, 1, 2, 3], 2, 2),
    [null, null, null, null, 2, null, null, 1],
  )
})

test("pivots support different left and right lengths", () => {
  assert.deepEqual(
    pivotHigh([1, 4, 3, 2], 1, 2),
    [null, null, null, 4],
  )
  assert.deepEqual(
    pivotLow([4, 1, 2, 3], 1, 2),
    [null, null, null, 1],
  )
})

test("pivots select the latest occurrence of equal extrema", () => {
  assert.deepEqual(
    pivotHigh([1, 3, 3, 2], 1, 1),
    [null, null, null, 3],
  )
  assert.deepEqual(
    pivotLow([3, 1, 1, 2], 1, 1),
    [null, null, null, 1],
  )
})

test("pivots remain null without enough surrounding bars", () => {
  assert.deepEqual(
    pivotHigh([1, 2, 3], 2, 2),
    [null, null, null],
  )
  assert.deepEqual(
    pivotLow([3, 2, 1], 2, 2),
    [null, null, null],
  )
})

test("pivots validate source values and lengths", () => {
  assert.throws(
    () => pivotHigh("1,2,3", 1, 1),
    /source must be an array/,
  )
  assert.throws(
    () => pivotLow([1, null, 3], 1, 1),
    /source at index 1 must be a finite number/,
  )
  assert.throws(
    () => pivotHigh([1, 2, 3], 0, 1),
    /leftLength must be a positive integer/,
  )
  assert.throws(
    () => pivotLow([1, 2, 3], 1, 1.5),
    /rightLength must be a positive integer/,
  )
})
