import assert from "node:assert/strict"
import test from "node:test"

import { buildUniverseContext } from "../src/steps/step4-feature-metrics/build-universe-context.js"
import { createFeatureProfile } from "../src/steps/step4-feature-metrics/build-feature-profiles.js"
import { calculateCoinMetrics } from "../src/steps/step4-feature-metrics/calculate-coin-metrics.js"
import { buildSustainedStrength } from "../src/steps/step4-feature-metrics/metrics/sustained-strength.js"

function assertClose (actual, expected) {
  assert.ok(Math.abs(actual - expected) < 1e-10, `Expected ${actual} to equal ${expected}`)
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
  const times = Array.from({ length: hours + 1 }, (_, index) => index * 3_600)
  const baseCoins = [
    ["TARGET", returns.map(target)],
    ["BTC", returns.map(value => value - 0.0002)],
    ["PEER2", returns],
    ["PEER3", returns.map(value => value + 0.0002)],
  ].map(([symbol, values]) => ({
    coin: { baseCurrencyId: symbol, symbol },
    categories: [],
    metadata: { marketCap: 1_000_000 },
    times,
    close: prices(values),
  }))

  return { baseCoins, total3esClose: prices(returns, 1_000) }
}

function targetMetrics (universe) {
  return buildSustainedStrength(universe.baseCoins, universe.total3esClose).get("TARGET")
}

test("sustained strength uses the entire price history and disjoint windows", () => {
  const universe = createUniverse()
  const before = structuredClone(universe)
  const metrics = targetMetrics(universe)

  assert.equal(metrics.status, "persistent")
  assert.equal(metrics.history_hours, 2_399)
  assert.equal(metrics.peer_count, 3)
  assert.equal(metrics.down_windows + metrics.up_windows, 599)
  assert.equal(metrics.daily_windows, 99)
  assert.equal(metrics.weekly_windows, 14)
  assert.equal(metrics.history_score, 100)
  assert.equal(metrics.current_score, 100)
  assert.equal(metrics.down_win_rate, 1)
  assert.equal(metrics.down_positive_rate, 0)
  assert.ok(metrics.down_excess_median > 0)
  assert.ok(metrics.up_excess_median > 0)
  assert.equal(metrics.up_participation_rate, 1)
  assert.equal(metrics.daily_win_rate, 1)
  assert.equal(metrics.weekly_win_rate, 1)
  for (const [field, hours] of [["excess_4h", 4], ["excess_12h", 12], ["excess_24h", 24], ["excess_7d", 168]]) {
    const coin = universe.baseCoins[0].close
    const market = universe.total3esClose
    assertClose(metrics[field], coin.at(-1) / coin.at(-1 - hours) - market.at(-1) / market.at(-1 - hours))
  }
  assert.deepEqual(universe, before)
  assert.deepEqual(
    buildSustainedStrength([...universe.baseCoins].reverse(), universe.total3esClose).get("TARGET"),
    metrics,
  )
})

test("growing against a falling market is distinguished from merely losing less", () => {
  const defensive = targetMetrics(createUniverse())
  const countertrend = targetMetrics(createUniverse({ target: value => value < 0 ? 0.0005 : value + 0.0005 }))

  assert.equal(countertrend.status, "persistent")
  assert.equal(countertrend.down_positive_rate, 1)
  assert.ok(countertrend.down_excess_median > defensive.down_excess_median)
})

test("recent weakness cannot be hidden by strong historical performance", () => {
  const metrics = targetMetrics(createUniverse({ target: (value, index) => value + (index >= 2_375 ? -0.003 : 0.0003) }))

  assert.equal(metrics.status, "fading")
  assert.ok(metrics.history_score > 90)
  assertClose(metrics.current_score, 100 / 12)
  assert.ok(metrics.excess_4h < 0)
  assert.ok(metrics.excess_12h < 0)
  assert.ok(metrics.excess_24h < 0)
})

test("new strength can emerge before the weekly relative return turns positive", () => {
  const metrics = targetMetrics(createUniverse({ target: (value, index) => value + (index >= 2_375 ? 0.003 : -0.001) }))

  assert.equal(metrics.status, "emerging")
  assert.ok(metrics.history_score < 65)
  assert.equal(metrics.current_score, 75)
  assert.ok(metrics.excess_24h > 0)
  assert.ok(metrics.excess_7d < 0)
})

test("one old pump is not persistent strength", () => {
  const metrics = targetMetrics(createUniverse({ target: (value, index) => value + (index === 240 ? Math.log(5) : 0) }))

  assert.equal(metrics.status, "neutral")
  assert.ok(metrics.history_score < 30)
  assert.equal(metrics.current_score, 50)
  assert.ok(metrics.daily_win_rate < 0.02)
  assert.ok(metrics.weekly_win_rate < 0.08)
})

test("a motionless coin does not qualify as persistently strong", () => {
  const metrics = targetMetrics(createUniverse({ target: () => 0 }))

  assert.equal(metrics.status, "neutral")
  assert.equal(metrics.down_win_rate, 1)
  assert.equal(metrics.up_participation_rate, 0)
  assert.equal(metrics.down_positive_rate, 0)
})

test("a low-beta coin that always lags rallies cannot qualify as persistent", () => {
  const metrics = targetMetrics(createUniverse({ target: value => value * 0.1 }))

  assert.notEqual(metrics.status, "persistent")
  assert.equal(metrics.down_win_rate, 1)
  assert.equal(metrics.up_participation_rate, 0)
})

test("matching peer returns gives half rank but no outperformance wins", () => {
  const metrics = targetMetrics(createUniverse({ target: value => value }))

  assert.equal(metrics.status, "neutral")
  assert.equal(metrics.current_score, 50)
  assert.equal(metrics.down_win_rate, 0)
  assert.equal(metrics.daily_win_rate, 0)
  assert.equal(metrics.weekly_win_rate, 0)
  assert.equal(metrics.up_participation_rate, 1)
})

for (const peers of [[0.01, 0.02, 0.04], [0, 0.02, 0.04, 0.08]]) {
  test(`peer median excludes the coin with ${peers.length} other coins`, () => {
    const returns = [0.3, ...peers]
    const baseCoins = returns.map((value, index) => ({
      coin: { baseCurrencyId: String(index) },
      close: [...Array(168).fill(100), 100 * (1 + value)],
    }))
    const metrics = buildSustainedStrength(baseCoins, Array(169).fill(1_000)).get("0")
    assertClose(metrics.excess_4h, 0.3 - (peers.length === 3 ? 0.02 : 0.03))
    assert.equal(metrics.current_score, 100)
  })
}

test("cross-sectional ranks handle tied coins without depending on coin order", () => {
  const returns = [-0.03, 0.02, 0.02, 0.06, 0.1]
  const baseCoins = returns.map((value, index) => ({
    coin: { baseCurrencyId: String(index) },
    close: [...Array(168).fill(100), 100 * (1 + value)],
  }))
  const results = buildSustainedStrength(baseCoins, Array(169).fill(1_000))

  assert.equal(results.get("0").current_score, 0)
  assert.equal(results.get("1").current_score, 37.5)
  assert.equal(results.get("2").current_score, 37.5)
  assert.equal(results.get("4").current_score, 100)
})

for (const direction of [-1, 1]) {
  test(`a one-sided market (${direction}) preserves evidence without inventing the missing regime`, () => {
    const metrics = targetMetrics(createUniverse({ market: () => direction * 0.002 }))

    assert.equal(metrics.status, "insufficient_data")
    assert.equal(metrics.history_score, null)
    assert.equal(metrics.current_score, 100)
    assert.equal(metrics.daily_win_rate, 1)
    if (direction === 1) {
      assert.equal(metrics.down_windows, 0)
      assert.equal(metrics.down_win_rate, null)
      assert.equal(metrics.down_positive_rate, null)
      assert.equal(metrics.down_excess_median, null)
    } else {
      assert.equal(metrics.up_windows, 0)
      assert.equal(metrics.up_participation_rate, null)
      assert.equal(metrics.up_excess_median, null)
    }
  })
}

test("market regimes need breadth and TOTAL3ES confirmation, not either one alone", () => {
  const universe = createUniverse()
  universe.total3esClose = universe.total3esClose.map(value => 1_000_000 / value)
  const metrics = targetMetrics(universe)

  assert.equal(metrics.down_windows, 0)
  assert.equal(metrics.up_windows, 0)
  assert.equal(metrics.history_score, null)
  assert.equal(metrics.current_score, 100)
  assert.equal(metrics.status, "insufficient_data")
})

test("flat peers are not counted as falling peers", () => {
  const universe = createUniverse({ market: () => -0.002 })
  universe.baseCoins[2].close.fill(100)
  universe.baseCoins[3].close.fill(100)
  const metrics = targetMetrics(universe)

  assert.equal(metrics.down_windows, 0)
  assert.equal(metrics.history_score, null)
})

test("both history length and repeated market regimes are required", () => {
  const short = targetMetrics(createUniverse({ hours: 671 }))
  const enough = targetMetrics(createUniverse({ hours: 672 }))
  const fewDownWindows = targetMetrics(createUniverse({ market: index => index < 24 ? -0.002 : 0.002 }))

  assert.equal(short.status, "insufficient_data")
  assert.equal(short.history_score, null)
  assert.equal(short.current_score, 100)
  assert.equal(enough.status, "persistent")
  assert.equal(enough.daily_windows, 28)
  assert.equal(enough.weekly_windows, 4)
  assert.ok(fewDownWindows.down_windows > 0 && fewDownWindows.down_windows < 12)
  assert.equal(fewDownWindows.down_win_rate, 1)
  assert.equal(fewDownWindows.history_score, null)
})

test("fewer than three peers or a missing horizon is insufficient, not a zero score", () => {
  const small = createUniverse()
  small.baseCoins.pop()
  const metrics = targetMetrics(small)
  assert.equal(metrics.peer_count, 2)
  assert.equal(metrics.history_score, null)
  assert.equal(metrics.current_score, null)
  assert.equal(metrics.excess_4h, null)
  assert.equal(metrics.status, "insufficient_data")

  const short = targetMetrics(createUniverse({ hours: 24 }))
  assert.ok(short.excess_4h > 0)
  assert.ok(short.excess_24h > 0)
  assert.equal(short.excess_7d, null)
  assert.equal(short.current_score, null)
})

for (const value of [null, 0, -1, NaN, Infinity]) {
  test(`invalid interior price ${value} is not silently bridged`, () => {
    const universe = createUniverse()
    universe.baseCoins[1].close[2_300] = value
    const metrics = targetMetrics(universe)

    assert.equal(metrics.status, "insufficient_data")
    assert.equal(metrics.current_score, null)
    assert.equal(metrics.excess_7d, null)
    assert.ok(metrics.excess_4h > 0)
    assert.deepEqual(JSON.parse(JSON.stringify(metrics)), metrics)
  })
}

function marketContextFor (baseCoins, total3esClose) {
  const times = baseCoins[0].times
  return {
    collectedAt: new Date((times.at(-1) + 3_600) * 1_000).toISOString(),
    series: Object.fromEntries([
      ["total", 10], ["totales", 9], ["total2es", 4], ["total3es", 1],
    ].map(([key, scale]) => [key, {
      symbol: `CRYPTOCAP:${key.toUpperCase()}`,
      periods: times.map((time, index) => ({ time, close: total3esClose[index] * scale })),
    }])),
  }
}

test("step 4 passes a whole-universe snapshot through metric calculation and profile compaction", () => {
  const { baseCoins, total3esClose } = createUniverse()
  const context = buildUniverseContext(baseCoins, marketContextFor(baseCoins, total3esClose))
  const baseCoin = baseCoins[0]
  const filled = value => baseCoin.close.map(() => value)
  const coinSeries = {
    close: baseCoin.close,
    high: baseCoin.close.map(value => value + 1),
    low: baseCoin.close.map(value => value - 1),
    volume: filled(100),
    volumeDelta: baseCoin.close.map((_, index) => index < 734 ? null : 10),
    openInterest: baseCoin.close.map((_, index) => 1_000 + index),
    fundingRate: filled(0.0001),
    premium: filled(0.1),
    longLiquidations: filled(10),
    shortLiquidations: filled(-10),
    longShortRatioAccounts: filled(1),
    topTradersLong: filled(50),
    topTradersShort: filled(-50),
    socialStatus: "unavailable",
  }
  const calculated = calculateCoinMetrics(coinSeries, context, "TARGET")
  const result = createFeatureProfile(baseCoin, coinSeries, calculated)

  assert.equal(result.rejection, null)
  assert.equal(context.sustainedStrengthByCoin.size, baseCoins.length)
  assert.deepEqual(result.profile.features.sustainedStrength, targetMetrics({ baseCoins, total3esClose }))
  assert.equal(result.profile.features.sustainedStrength.daily_windows, 99)

  calculated.featureSeries.sustainedStrength = targetMetrics(createUniverse({ market: () => 0.002 }))
  const unavailable = createFeatureProfile(baseCoin, coinSeries, calculated)
  assert.equal(unavailable.rejection, null)
  assert.equal(unavailable.profile.features.sustainedStrength.status, "insufficient_data")
  assert.equal(unavailable.profile.features.sustainedStrength.down_win_rate, null)

  calculated.featureSeries.sustainedStrength.history_score = NaN
  assert.deepEqual(createFeatureProfile(baseCoin, coinSeries, calculated).rejection.unavailableMetrics, [
    "sustainedStrength.history_score",
  ])
})
