import assert from "node:assert/strict"
import test from "node:test"

import { calculateMovementLifecycleMetrics } from "../src/steps/step4-feature-metrics/metrics/movement-lifecycle.js"

function createInput (close, squeezeAge = close.map(() => 0)) {
  return {
    high: close.map(value => value + 0.5),
    low: close.map(value => value - 0.5),
    close,
    atr24hPct: close.map(value => 1 / value),
    squeezeAge,
  }
}

function assertClose (actual, expected) {
  assert.ok(
    Math.abs(actual - expected) < 1e-12,
    `Expected ${actual} to be close to ${expected}`,
  )
}

test("previous boundary distances stay signed inside, at and beyond the range", () => {
  for (const [price, highDistance, lowDistance] of [
    [100, 5, 5],
    [110, 0, 10],
    [114, -2, 12],
    [90, 10, 0],
    [86, 12, -2],
  ]) {
    const input = createInput([...Array(24).fill(100), price])
    input.high.fill(110, 0, 24)
    input.low.fill(90, 0, 24)
    input.atr24hPct.fill(0.02, 0, 24)

    const metrics = calculateMovementLifecycleMetrics(input)

    assert.equal(metrics.distance_to_previous_high_atr[24], highDistance)
    assert.equal(metrics.distance_to_previous_low_atr[24], lowDistance)
  }
})

test("previous boundaries use exactly 24 bars, excluding current and expired bars", () => {
  const input = createInput(Array(27).fill(100))
  input.high[0] = 500
  input.low[0] = 10
  input.high[1] = 120
  input.low[1] = 80
  input.high[24] = 110
  input.low[24] = 90
  input.high[25] = 1_000
  input.low[25] = 1

  const metrics = calculateMovementLifecycleMetrics(input)

  assert.deepEqual(
    metrics.distance_to_previous_high_atr,
    [...Array(24).fill(null), 400, 20, 900],
  )
  assert.deepEqual(
    metrics.distance_to_previous_low_atr,
    [...Array(24).fill(null), 90, 20, 99],
  )
})

test("previous boundary distances use ATR and its close from the previous candle", () => {
  const input = createInput(Array(26).fill(100))
  input.high.fill(110)
  input.low.fill(90)
  input.close[24] = 105
  input.atr24hPct[23] = 0.02
  input.atr24hPct[24] = 0.2

  const metrics = calculateMovementLifecycleMetrics(input)

  assert.equal(metrics.distance_to_previous_high_atr[24], 2.5)
  assert.equal(metrics.distance_to_previous_low_atr[24], 7.5)
  assertClose(metrics.distance_to_previous_high_atr[25], 10 / 21)
  assertClose(metrics.distance_to_previous_low_atr[25], 10 / 21)
})

test("previous high and low distances are symmetric under price reflection", () => {
  const close = Array.from({ length: 60 }, (_, index) => 100 + index)
  const upward = calculateMovementLifecycleMetrics(createInput(close))
  const downward = calculateMovementLifecycleMetrics(
    createInput(close.map(value => 200 - value)),
  )

  for (let index = 24; index < close.length; index += 1) {
    assertClose(
      upward.distance_to_previous_high_atr[index],
      downward.distance_to_previous_low_atr[index],
    )
    assertClose(
      upward.distance_to_previous_low_atr[index],
      downward.distance_to_previous_high_atr[index],
    )
  }
})

test("previous boundary distances support empty inputs and remain null during warmup", () => {
  for (const length of [0, 1, 24]) {
    const metrics = calculateMovementLifecycleMetrics(
      createInput(Array(length).fill(100)),
    )

    assert.deepEqual(metrics.distance_to_previous_high_atr, Array(length).fill(null))
    assert.deepEqual(metrics.distance_to_previous_low_atr, Array(length).fill(null))
  }
})

test("a missing boundary invalidates only its own next 24 windows", () => {
  for (const [source, affected, unaffected] of [
    ["high", "distance_to_previous_high_atr", "distance_to_previous_low_atr"],
    ["low", "distance_to_previous_low_atr", "distance_to_previous_high_atr"],
  ]) {
    const input = createInput(Array(50).fill(100))
    input[source][24] = null

    const metrics = calculateMovementLifecycleMetrics(input)

    assert.equal(metrics[affected][24], 0.5)
    assert.deepEqual(metrics[affected].slice(25, 49), Array(24).fill(null))
    assert.equal(metrics[affected][49], 0.5)
    assert.deepEqual(metrics[unaffected].slice(24), Array(26).fill(0.5))
  }
})

test("previous boundary distances are null for missing close or unusable previous ATR", () => {
  for (const [source, index, value] of [
    ["close", 24, null],
    ["close", 23, null],
    ["atr24hPct", 23, null],
    ["atr24hPct", 23, 0],
    ["atr24hPct", 23, -0.01],
  ]) {
    const input = createInput(Array(27).fill(100))
    input[source][index] = value

    const metrics = calculateMovementLifecycleMetrics(input)

    assert.equal(metrics.distance_to_previous_high_atr[24], null)
    assert.equal(metrics.distance_to_previous_low_atr[24], null)
    assert.equal(metrics.distance_to_previous_high_atr[26], 0.5)
    assert.equal(metrics.distance_to_previous_low_atr[26], 0.5)
  }
})

test("previous boundary distances have no lookahead and do not mutate inputs", () => {
  const input = createInput(
    Array.from({ length: 60 }, (_, index) => 100 + (index % 10) * 3),
  )
  input.high[10] = null
  input.low[20] = null
  input.atr24hPct[30] = null
  const snapshot = structuredClone(input)
  Object.values(input).forEach(Object.freeze)
  Object.freeze(input)

  const full = calculateMovementLifecycleMetrics(input)

  for (let length = 0; length <= input.close.length; length += 1) {
    const prefix = calculateMovementLifecycleMetrics(Object.fromEntries(
      Object.entries(input).map(([name, series]) => [name, series.slice(0, length)]),
    ))

    for (const name of ["distance_to_previous_high_atr", "distance_to_previous_low_atr"]) {
      assert.deepEqual(prefix[name], full[name].slice(0, length), `${name}: ${length}`)
    }
  }

  assert.deepEqual(input, snapshot)
})

test("historical runups exclude the latest four hours", () => {
  const baselineClose = Array.from({ length: 220 }, (_, index) => 100 + index)
  const pumpedClose = baselineClose.map((value, index) => (
    index < 216 ? value : value + 1_000
  ))
  const baseline = calculateMovementLifecycleMetrics(createInput(baselineClose))
  const pumped = calculateMovementLifecycleMetrics(createInput(pumpedClose))

  assert.equal(pumped.prior_runup_atr_72h.at(-1), 72)
  assertClose(pumped.max_24h_runup_last_7d_atr.at(-1), 24)
  assert.equal(
    pumped.prior_runup_atr_72h.at(-1),
    baseline.prior_runup_atr_72h.at(-1),
  )
  assert.equal(
    pumped.max_24h_runup_last_7d_atr.at(-1),
    baseline.max_24h_runup_last_7d_atr.at(-1),
  )
  assert.equal(pumped.late_pump.at(-1), true)
})

test("a mature quiet base produces one fresh breakout lifecycle", () => {
  const close = Array.from({ length: 240 }, (_, index) => (
    index < 210 ? 100 + index : 309
  ))
  const squeezeAge = close.map(() => 0)

  for (let index = 220; index <= 231; index += 1) {
    squeezeAge[index] = index - 219
  }

  close[232] = 310
  close[233] = 310.4
  close[234] = 311.2

  const metrics = calculateMovementLifecycleMetrics(
    createInput(close, squeezeAge),
  )

  assert.equal(metrics.pre_breakout_squeeze_age[231], null)
  assert.equal(metrics.pre_breakout_squeeze_age[232], 12)
  assert.equal(metrics.squeeze_ended_hours_ago[233], 1)
  assert.equal(metrics.breakout_age_hours[232], 0)
  assert.equal(metrics.breakout_age_hours[233], 1)
  assertClose(metrics.post_breakout_extension_atr[233], 0.9)
  assertClose(metrics.extension_from_base_atr[233], 1.4)
  assert.equal(metrics.fresh_quiet_breakout[233], true)
  assert.equal(metrics.fresh_quiet_breakout[234], false)
  assert.equal(metrics.late_pump[233], false)
})

test("a move after the four-hour breakout window keeps only base distance", () => {
  const close = Array(210).fill(100)
  const squeezeAge = close.map(() => 0)

  for (let index = 180; index <= 191; index += 1) {
    squeezeAge[index] = index - 179
  }

  close[197] = 102

  const metrics = calculateMovementLifecycleMetrics(
    createInput(close, squeezeAge),
  )

  assert.equal(metrics.squeeze_ended_hours_ago[197], 5)
  assert.equal(metrics.pre_breakout_squeeze_age[197], null)
  assert.equal(metrics.breakout_age_hours[197], null)
  assert.equal(metrics.post_breakout_extension_atr[197], null)
  assert.equal(metrics.extension_from_base_atr[197], 2)
  assert.equal(metrics.fresh_quiet_breakout[197], false)
})

test("every metric at an hour is unchanged by later candles", () => {
  const close = Array.from({ length: 230 }, (_, index) => (
    100 + index / 10
  ))
  const fullInput = createInput(close)
  const prefixInput = Object.fromEntries(
    Object.entries(fullInput).map(([name, series]) => [name, series.slice(0, 211)]),
  )
  const full = calculateMovementLifecycleMetrics(fullInput)
  const prefix = calculateMovementLifecycleMetrics(prefixInput)

  for (const name of Object.keys(full)) {
    assert.equal(full[name][210], prefix[name].at(-1), name)
  }
})
