import assert from "node:assert/strict"
import test from "node:test"

import {
  combineSeries,
  consecutiveCount,
  cumulativeSum,
  difference,
  lag,
  mapSeries,
  ratioSeries,
} from "../src/scripts/series.js"

test("mapSeries preserves alignment and skips null values", () => {
  const source = [1, null, 3]
  const calls = []

  assert.deepEqual(
    mapSeries(source, (value, index) => {
      calls.push([value, index])
      return value * 2 + index
    }),
    [2, null, 8],
  )
  assert.deepEqual(calls, [[1, 0], [3, 2]])
  assert.deepEqual(source, [1, null, 3])
})

test("combineSeries maps complete rows and nulls incomplete rows", () => {
  const sources = [
    [1, 2, null, 4],
    [10, null, 30, 40],
  ]
  const calls = []

  assert.deepEqual(
    combineSeries(sources, (values, index) => {
      calls.push([values, index])
      return values[0] + values[1] + index
    }),
    [11, null, null, 47],
  )
  assert.deepEqual(calls, [
    [[1, 10], 0],
    [[4, 40], 3],
  ])
  assert.deepEqual(sources, [
    [1, 2, null, 4],
    [10, null, 30, 40],
  ])
})

test("lag and difference preserve length and respect offsets", () => {
  const source = [1, null, 3, 4]

  assert.deepEqual(lag(source, 2), [null, null, 1, null])
  assert.deepEqual(difference(source, 2), [null, null, 2, null])
  assert.deepEqual(difference([1, 4, 9]), [null, 3, 5])
  assert.equal(lag(source, 2).length, source.length)
})

test("ratioSeries returns null for gaps and zero denominators", () => {
  assert.deepEqual(
    ratioSeries(
      [2, 4, null, 8, 10],
      [1, 0, 3, null, 2],
    ),
    [2, null, null, null, 5],
  )
})

test("cumulativeSum leaves gaps null and resumes the prior total", () => {
  assert.deepEqual(
    cumulativeSum([1, 2, null, -1, 4]),
    [1, 3, null, 2, 6],
  )
})

test("consecutiveCount resets on false values and null gaps", () => {
  const calls = []

  assert.deepEqual(
    consecutiveCount(
      [true, true, false, null, 2, 3, 1],
      (value, index) => {
        calls.push([value, index])
        return value === true || value >= 2
      },
    ),
    [1, 2, 0, null, 1, 2, 0],
  )
  assert.deepEqual(calls, [
    [true, 0],
    [true, 1],
    [false, 2],
    [2, 4],
    [3, 5],
    [1, 6],
  ])
})

test("series helpers reject malformed sources and offsets", () => {
  assert.throws(
    () => mapSeries("1,2", value => value),
    /must be an array/,
  )
  assert.throws(
    () => mapSeries([1, Number.NaN], value => value),
    /finite number or null/,
  )
  assert.throws(
    () => combineSeries([[1], [1, 2]], values => values[0]),
    /equal lengths/,
  )
  assert.throws(
    () => lag([1, 2], 0),
    /positive integer/,
  )
  assert.throws(
    () => difference([1, 2], 1.5),
    /positive integer/,
  )
  assert.throws(
    () => consecutiveCount([true, "yes"], Boolean),
    /finite number, boolean, or null/,
  )
})
