import assert from "node:assert/strict"
import test from "node:test"

import { isFinite } from "../src/helpers/utils.typed.js"
import { buildSustainedStrength } from "../src/steps/step4-feature-metrics/metrics/sustained-strength.js"

function assertClose (actual, expected) {
  assert.ok(isFinite(actual) && Math.abs(actual - expected) < 1e-10, `${actual} != ${expected}`)
}

function prices (returns, initial = 100) {
  const close = [initial]
  for (const value of returns) {
    close.push(close.at(-1) * Math.exp(value))
  }
  return close
}

function createUniverse ({ hours = 2_399, target = value => value + 0.0003, market } = {}) {
  const returns = Array.from({ length: hours }, (_, index) => (
    market ? market(index) : Math.floor(index / 24) % 2 === 0 ? -0.002 : 0.002
  ))
  const baseCoins = [
    ["TARGET", returns.map(target)],
    ["BTC", returns.map(value => value - 0.0002)],
    ["PEER2", returns],
    ["PEER3", returns.map(value => value + 0.0002)],
  ].map(([id, values]) => ({ coin: { baseCurrencyId: id }, close: prices(values) }))
  return { baseCoins, total3esClose: prices(returns, 1_000) }
}

function targetMetrics (universe) {
  return buildSustainedStrength(universe.baseCoins, universe.total3esClose).get("TARGET")
}

test("persistent strength uses full disjoint history and exact current return horizons", () => {
  const universe = createUniverse()
  const metrics = targetMetrics(universe)

  assert.equal(metrics.status, "persistent")
  assert.equal(metrics.history_hours, 2_399)
  assert.equal(metrics.down_windows + metrics.up_windows, 599)
  assert.equal(metrics.daily_windows, 99)
  assert.equal(metrics.weekly_windows, 14)
  assert.equal(metrics.history_score, 100)
  assert.equal(metrics.current_score, 100)
  assert.equal(metrics.down_win_rate, 1)
  assert.equal(metrics.down_positive_rate, 0)
  assert.equal(metrics.up_participation_rate, 1)
  assert.equal(metrics.daily_win_rate, 1)
  assert.equal(metrics.weekly_win_rate, 1)
  for (const [field, hours] of [["excess_4h", 4], ["excess_12h", 12], ["excess_24h", 24], ["excess_7d", 168]]) {
    const coin = universe.baseCoins[0].close
    const market = universe.total3esClose
    assertClose(metrics[field], coin.at(-1) / coin.at(-1 - hours) - market.at(-1) / market.at(-1 - hours))
  }
})

test("recent strength overrides history while an old pump or a motionless coin stays neutral", () => {
  const fading = targetMetrics(createUniverse({ target: (value, index) => value + (index >= 2_375 ? -0.003 : 0.0003) }))
  const emerging = targetMetrics(createUniverse({ target: (value, index) => value + (index >= 2_375 ? 0.003 : -0.001) }))
  const pump = targetMetrics(createUniverse({ target: (value, index) => value + (index === 240 ? Math.log(5) : 0) }))
  const flat = targetMetrics(createUniverse({ target: () => 0 }))

  assert.equal(fading.status, "fading")
  assert.ok(fading.history_score > 90)
  assertClose(fading.current_score, 100 / 12)
  assert.ok(fading.excess_4h < 0 && fading.excess_24h < 0)
  assert.equal(emerging.status, "emerging")
  assert.equal(emerging.current_score, 75)
  assert.ok(emerging.excess_24h > 0 && emerging.excess_7d < 0)
  assert.equal(pump.status, "neutral")
  assert.equal(pump.current_score, 50)
  assertClose(pump.daily_win_rate, 1 / 99)
  assertClose(pump.weekly_win_rate, 1 / 14)
  assert.equal(flat.status, "neutral")
  assert.equal(flat.down_win_rate, 1)
  assert.equal(flat.up_participation_rate, 0)
})

test("peer medians exclude the coin and tied cross-sectional ranks do not depend on input order", () => {
  for (const [returns, median] of [
    [[0.3, 0.01, 0.02, 0.04], 0.02],
    [[0.3, 0, 0.02, 0.04, 0.08], 0.03],
  ]) {
    const coins = returns.map((value, index) => ({
      coin: { baseCurrencyId: String(index) },
      close: [...Array(168).fill(100), 100 * (1 + value)],
    }))
    const metrics = buildSustainedStrength(coins, Array(169).fill(1_000)).get("0")
    assertClose(metrics.excess_4h, 0.3 - median)
    assert.equal(metrics.current_score, 100)
  }
  const coins = [-0.03, 0.02, 0.02, 0.06, 0.1].map((value, index) => ({
    coin: { baseCurrencyId: String(index) },
    close: [...Array(168).fill(100), 100 * (1 + value)],
  }))
  for (const input of [coins, coins.toReversed()]) {
    const metrics = buildSustainedStrength(input, Array(169).fill(1_000))
    assert.equal(metrics.get("0").current_score, 0)
    assert.equal(metrics.get("1").current_score, 37.5)
    assert.equal(metrics.get("2").current_score, 37.5)
    assert.equal(metrics.get("4").current_score, 100)
  }
})

test("strength needs enough peers, full history and repeated regimes confirmed by breadth and TOTAL3ES", () => {
  const short = targetMetrics(createUniverse({ hours: 671 }))
  assert.equal(short.status, "insufficient_data")
  assert.equal(short.history_score, null)
  assert.equal(short.current_score, 100)
  assert.equal(targetMetrics(createUniverse({ hours: 672 })).status, "persistent")

  const small = createUniverse()
  small.baseCoins.pop()
  const tooFewPeers = targetMetrics(small)
  assert.equal(tooFewPeers.history_score, null)
  assert.equal(tooFewPeers.current_score, null)
  assert.equal(tooFewPeers.excess_4h, null)

  const oneSided = targetMetrics(createUniverse({ market: () => 0.002 }))
  assert.equal(oneSided.status, "insufficient_data")
  assert.equal(oneSided.down_windows, 0)
  assert.equal(oneSided.down_win_rate, null)
  assert.equal(oneSided.history_score, null)
  assert.equal(oneSided.current_score, 100)

  const fewDown = targetMetrics(createUniverse({ market: index => index < 24 ? -0.002 : 0.002 }))
  // The 2399-hour snapshot leaves the oldest three hours outside full 4h windows.
  assert.equal(fewDown.down_windows, 5)
  assert.equal(fewDown.history_score, null)

  const conflicting = createUniverse()
  conflicting.total3esClose = conflicting.total3esClose.map(value => 1_000_000 / value)
  const noAgreement = targetMetrics(conflicting)
  assert.equal(noAgreement.down_windows, 0)
  assert.equal(noAgreement.up_windows, 0)
  assert.equal(noAgreement.history_score, null)
})

test("missing or zero interior prices invalidate the whole horizon instead of silently bridging it", () => {
  const short = targetMetrics(createUniverse({ hours: 24 }))
  assert.ok(short.excess_24h > 0)
  assert.equal(short.excess_7d, null)
  assert.equal(short.current_score, null)

  for (const value of [null, 0]) {
    const universe = createUniverse()
    universe.baseCoins[1].close[2_300] = value
    const metrics = targetMetrics(universe)
    assert.equal(metrics.status, "insufficient_data")
    assert.equal(metrics.current_score, null)
    assert.equal(metrics.excess_7d, null)
    assert.ok(metrics.excess_4h > 0)
  }
})
