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
