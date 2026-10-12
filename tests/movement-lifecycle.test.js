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
  assert.notEqual(actual, null)
  assert.ok(
    Math.abs(actual - expected) < 1e-12,
    `Expected ${actual} to be close to ${expected}`,
  )
}

test("previous range excludes current and expired candles and uses the previous candle ATR", () => {
  const input = createInput(Array(26).fill(100))
  input.high.fill(110)
  input.low.fill(90)
  input.high[0] = 500
  input.low[0] = 10
  input.high[1] = 120
  input.low[1] = 80
  input.close[24] = 105
  input.close[25] = 124
  input.high[25] = 1_000
  input.low[25] = 1
  input.atr24hPct[23] = 0.02
  input.atr24hPct[24] = 0.2

  const metrics = calculateMovementLifecycleMetrics(input)

  assert.deepEqual(metrics.distance_to_previous_high_atr.slice(0, 25), [...Array(24).fill(null), 197.5])
  assert.deepEqual(metrics.distance_to_previous_low_atr.slice(0, 25), [...Array(24).fill(null), 47.5])
  assertClose(metrics.distance_to_previous_high_atr[25], -4 / 21)
  assertClose(metrics.distance_to_previous_low_atr[25], 44 / 21)
})

test("historical moves exclude the latest four hours and distinguish late pump from late dump", () => {
  const close = Array.from({ length: 220 }, (_, index) => (
    100 + index + (index >= 216 ? 100 : 0)
  ))
  const rising = calculateMovementLifecycleMetrics(createInput(close))
  const falling = calculateMovementLifecycleMetrics(createInput(close.map(value => 500 - value)))

  assertClose(rising.prior_runup_atr_72h.at(-1), 72)
  assertClose(rising.max_24h_runup_last_7d_atr.at(-1), 24)
  assertClose(falling.prior_drawdown_atr_72h.at(-1), 72)
  assertClose(falling.max_24h_drawdown_last_7d_atr.at(-1), 24)
  assert.deepEqual(
    [rising.fresh_quiet_breakout.at(-1), rising.late_pump.at(-1), rising.late_dump.at(-1)],
    [false, true, false],
  )
  assert.deepEqual(
    [falling.fresh_quiet_breakout.at(-1), falling.late_pump.at(-1), falling.late_dump.at(-1)],
    [false, false, true],
  )
})

test("fresh quiet breakouts in either direction are not late moves and expire after extension", () => {
  const close = Array.from({ length: 235 }, (_, index) => index < 210 ? 100 + index : 309)
  const squeezeAge = close.map((_, index) => index >= 220 && index <= 231 ? index - 219 : 0)
  close[232] = 310
  close[233] = 310.4
  close[234] = 311.2

  const rising = calculateMovementLifecycleMetrics(createInput(close, squeezeAge))
  const falling = calculateMovementLifecycleMetrics(createInput(close.map(value => 500 - value), squeezeAge))

  assert.equal(rising.pre_breakout_squeeze_age[232], 12)
  assert.equal(rising.breakout_age_hours[233], 1)
  assertClose(rising.post_breakout_extension_atr[233], 0.9)
  assertClose(falling.post_breakout_extension_atr[233], 0.9)
  assertClose(rising.extension_from_base_atr[233], 1.4)
  assert.deepEqual(rising.fresh_quiet_breakout.slice(232), [true, true, false])
  assert.deepEqual(falling.fresh_quiet_breakout.slice(232), [true, true, false])
  assert.deepEqual([rising.late_pump[233], falling.late_dump[233]], [false, false])
})

test("a future price shock and a new base do not change past lifecycle metrics", () => {
  const close = Array.from({ length: 240 }, (_, index) => 300 - index / 10)
  const squeezeAge = close.map((_, index) => (
    index >= 180 && index <= 191
      ? index - 179
      : index >= 220 && index <= 231 ? index - 219 : 0
  ))
  const input = createInput(close, squeezeAge)
  const prefixInput = Object.fromEntries(
    Object.entries(input).map(([name, series]) => [name, series.slice(0, 211)]),
  )
  input.close.fill(1_000, 211)
  input.high.fill(1_000.5, 211)
  input.low.fill(999.5, 211)
  input.atr24hPct.fill(1 / 1_000, 211)

  const full = calculateMovementLifecycleMetrics(input)
  const prefix = calculateMovementLifecycleMetrics(prefixInput)

  assert.equal(prefix.squeeze_ended_hours_ago.at(-1), 18)
  assertClose(prefix.prior_drawdown_atr_72h.at(-1), 7.2)
  for (const name of Object.keys(full)) {
    assert.equal(full[name][210], prefix[name].at(-1), name)
  }
})

test("missing boundaries and closes or zero previous ATR produce nulls and then recover", () => {
  const input = createInput(Array(53).fill(100))
  input.high[24] = null
  input.atr24hPct[25] = 0
  input.close[50] = null

  const metrics = calculateMovementLifecycleMetrics(input)

  assert.equal(metrics.distance_to_previous_high_atr[24], 0.5)
  assert.deepEqual(metrics.distance_to_previous_high_atr.slice(25, 49), Array(24).fill(null))
  assert.equal(metrics.distance_to_previous_low_atr[25], 0.5)
  assert.equal(metrics.distance_to_previous_low_atr[26], null)
  assert.equal(metrics.distance_to_previous_low_atr[27], 0.5)
  assert.equal(metrics.distance_to_previous_high_atr[49], 0.5)
  assert.deepEqual(metrics.distance_to_previous_high_atr.slice(50), [null, null, 0.5])
  assert.deepEqual(metrics.distance_to_previous_low_atr.slice(50), [null, null, 0.5])
})
