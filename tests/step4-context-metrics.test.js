import assert from "node:assert/strict"
import test from "node:test"

import { buildUniverseContext } from "../src/steps/step4-feature-metrics/build-universe-context.js"
import { calculateBreadthNarrativeMetrics } from "../src/steps/step4-feature-metrics/metrics/breadth-narrative.js"
import { calculateDivergenceFlags } from "../src/steps/step4-feature-metrics/metrics/divergence-flags.js"
import { calculateRelativeStrengthMetrics } from "../src/steps/step4-feature-metrics/metrics/relative-strength.js"

function assertClose (actual, expected, tolerance = 1e-10) {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `Expected ${actual} to be within ${tolerance} of ${expected}`,
  )
}

function createMarketContext (times) {
  const periods = close => times.map((time, index) => ({
    time,
    close: close(index),
  }))

  return {
    series: {
      total: { periods: periods(() => 1_000) },
      totales: { periods: periods(index => 900 - index) },
      total2es: { periods: periods(() => 500) },
      total3es: { periods: periods(() => 300) },
    },
  }
}

function categoryClose (valueAt8, valueAt12, length) {
  const close = Array(length).fill(100)
  close[8] = valueAt8
  close[12] = valueAt12
  return close
}

function createBaseCoins (times) {
  return [
    {
      coin: { baseCurrencyId: "TARGET", symbol: "TARGET" },
      categories: ["Zulu", "Alpha"],
      times,
      close: categoryClose(100, 200, times.length),
    },
    {
      coin: { baseCurrencyId: "PEER1", symbol: "PEER1" },
      categories: ["Zulu", "Alpha"],
      times,
      close: categoryClose(101, 103, times.length),
    },
    {
      coin: { baseCurrencyId: "PEER2", symbol: "PEER2" },
      categories: ["Zulu", "Alpha"],
      times,
      close: categoryClose(102, 106, times.length),
    },
    {
      coin: { baseCurrencyId: "PEER3", symbol: "PEER3" },
      categories: ["Zulu", "Alpha"],
      times,
      close: categoryClose(103, 102, times.length),
    },
    {
      coin: { baseCurrencyId: "XTVCBTC", symbol: "BTC" },
      categories: [],
      times,
      close: Array(times.length).fill(100),
    },
  ]
}

test("buildUniverseContext calculates shared market and category context", () => {
  const times = Array.from({ length: 25 }, (_, index) => index * 3_600)
  const context = buildUniverseContext(
    createBaseCoins(times),
    createMarketContext(times),
  )

  assert.deepEqual(context.times, times)
  assert.deepEqual(context.btcClose, Array(25).fill(100))
  assert.deepEqual(context.total3esClose, Array(25).fill(300))
  assert.deepEqual(
    context.stablecapChange24h.slice(0, 24),
    Array(24).fill(null),
  )
  assertClose(context.stablecapChange24h[24], 0.24)
  assert.deepEqual(context.segmentRotation4h.slice(0, 4), Array(4).fill(null))
  assertClose(context.segmentRotation4h[4].btc, -0.004)
  assertClose(context.segmentRotation4h[4].eth, 0)
  assertClose(context.segmentRotation4h[4].alts, 0)
  assertClose(context.segmentRotation4h[4].stables, 0.004)

  assert.deepEqual(context.universeBreadth4h.slice(0, 4), Array(4).fill(null))
  assert.equal(context.universeBreadth4h[4], 0)
  assert.equal(context.universeBreadth4h[12], 3 / 5)

  const category = context.categoryContextsByCoin.get("TARGET")
  const peerMedian = 103 / 101 - 1

  assert.equal(category.applicable, true)
  assert.equal(category.status, "available")
  assert.equal(category.category, "Alpha")
  assertClose(category.momentum4h[12], peerMedian)
  assert.equal(category.breadth[4], null)
  assert.equal(category.breadth[12], 2 / 3)
  assertClose(category.coinLeadsCategory[12], 1 - peerMedian)

  assert.deepEqual(context.categoryContextsByCoin.get("XTVCBTC"), {
    applicable: false,
    status: "not_applicable",
    category: null,
    momentum4h: Array(25).fill(null),
    breadth: Array(25).fill(null),
    coinLeadsCategory: Array(25).fill(null),
  })
})

test("buildUniverseContext distinguishes categories without enough peers", () => {
  const times = Array.from({ length: 13 }, (_, index) => index * 3_600)
  const baseCoins = createBaseCoins(times)
  baseCoins[4] = { ...baseCoins[4], categories: ["Solo"] }

  const category = buildUniverseContext(
    baseCoins,
    createMarketContext(times),
  ).categoryContextsByCoin.get("XTVCBTC")

  assert.equal(category.applicable, false)
  assert.equal(category.status, "insufficient_peers")
  assert.equal(category.category, null)
})

test("buildUniverseContext rejects grids that are not identical and hourly", () => {
  const times = Array.from({ length: 13 }, (_, index) => index * 3_600)
  const baseCoins = createBaseCoins(times)
  baseCoins[1] = {
    ...baseCoins[1],
    times: times.map((time, index) => index === 12 ? time + 1 : time),
  }

  assert.throws(
    () => buildUniverseContext(baseCoins, createMarketContext(times)),
    /identical hourly time grid/,
  )
})

test("calculateBreadthNarrativeMetrics keeps only coin category series", () => {
  const categoryContext = {
    momentum4h: Array(25).fill(0.02),
    breadth: Array(25).fill(0.75),
    coinLeadsCategory: Array(25).fill(-0.01),
  }
  const metrics = calculateBreadthNarrativeMetrics({ categoryContext })

  assert.deepEqual(Object.keys(metrics), [
    "category_momentum_4h",
    "category_breadth",
    "coin_leads_category",
  ])
  assert.equal(metrics.category_momentum_4h, categoryContext.momentum4h)
  assert.equal(metrics.category_breadth, categoryContext.breadth)
  assert.equal(metrics.coin_leads_category, categoryContext.coinLeadsCategory)
})

function closeFromLogReturns (returns, initial = 100) {
  return returns.reduce(
    (close, value) => [...close, close.at(-1) * Math.exp(value)],
    [initial],
  )
}

test("calculateRelativeStrengthMetrics calculates aligned rolling market metrics", () => {
  const btcHourlyReturns = Array.from(
    { length: 899 },
    (_, index) => 0.0005 + (index % 11 - 5) * 0.0001,
  )
  const coinClose = closeFromLogReturns(btcHourlyReturns.map(value => value * 2))
  const btcClose = closeFromLogReturns(btcHourlyReturns)
  const total3esClose = closeFromLogReturns(
    btcHourlyReturns.map(value => value * 0.5),
    1_000,
  )
  const metrics = calculateRelativeStrengthMetrics({
    coinClose,
    btcClose,
    total3esClose,
  })
  const last = coinClose.length - 1
  const coinReturn4h = Math.log(coinClose[last] / coinClose[last - 4])
  const btcReturn4h = Math.log(btcClose[last] / btcClose[last - 4])
  const coinReturn12h = coinClose[last] / coinClose[last - 12] - 1
  const marketReturn12h = total3esClose[last] / total3esClose[last - 12] - 1

  assert.deepEqual(Object.keys(metrics), [
    "beta_btc_7d",
    "corr_btc_24h",
    "corr_btc_change_24h_vs_7d",
    "residual_return_4h",
    "residual_z_30d",
    "rs_vs_total3es_12h",
  ])
  Object.values(metrics).forEach(series => assert.equal(series.length, coinClose.length))
  assert.equal(metrics.beta_btc_7d[167], null)
  assert.equal(metrics.corr_btc_24h[23], null)
  assertClose(metrics.beta_btc_7d[last], 2)
  assertClose(metrics.corr_btc_24h[last], 1)
  assertClose(metrics.corr_btc_change_24h_vs_7d[last], 0)
  assertClose(
    metrics.residual_return_4h[last],
    coinReturn4h - 2 * btcReturn4h,
  )
  assert.ok(Number.isFinite(metrics.residual_z_30d[last]))
  assertClose(
    metrics.rs_vs_total3es_12h[last],
    coinReturn12h - marketReturn12h,
  )
})

function closeFromFourHourReturns (returns4h) {
  const close = Array(returns4h.length).fill(100)

  for (let index = 4; index < close.length; index += 1) {
    close[index] = close[index - 4] * (1 + returns4h[index])
  }

  return close
}

function repeatingSignal (length) {
  return Array.from({ length }, (_, index) => (
    index % 3 === 0 ? 0 : index % 3 === 1 ? 0.01 : -0.01
  ))
}

test("calculateDivergenceFlags evaluates all conditions and preserves null warmup", () => {
  const length = 2_170
  const calm = length - 4
  const drop = length - 3
  const move = length - 2
  const last = length - 1
  const coinReturns4h = repeatingSignal(length)
  const btcReturns4h = repeatingSignal(length)
  const categoryMomentum = repeatingSignal(length)
  coinReturns4h[drop] = -0.5
  coinReturns4h[move] = 0.5
  btcReturns4h[last] = -0.5
  categoryMomentum[last] = 0.2

  const filled = value => Array(length).fill(value)
  const squeezeAge = filled(4)
  const oiChange = filled(1)
  const oiChangeZ = filled(0)
  const volumeAcceleration = filled(1)
  const volumeZ = filled(0)
  const socialLeadsPrice = filled(2)
  const socialDominanceZ = filled(0)
  const interactionsZ = filled(0)
  const interactionsAcceleration = filled(0)
  const categoryBreadth = filled(0.7)
  const coinLeadsCategory = filled(0)
  const fundingPercentile = filled(0.5)
  const crowdVsTopTraders = filled(0)
  const residualZ = filled(0)

  socialLeadsPrice[0] = 1
  socialDominanceZ[calm] = 2
  interactionsAcceleration[calm] = -1
  fundingPercentile[drop] = 0.05
  crowdVsTopTraders[drop] = -0.16
  oiChangeZ[last] = 2
  fundingPercentile[last] = 0.95
  crowdVsTopTraders[last] = 0.16
  coinLeadsCategory[last] = -0.01
  residualZ[last] = 1

  const flags = calculateDivergenceFlags({
    close: closeFromFourHourReturns(coinReturns4h),
    btcClose: closeFromFourHourReturns(btcReturns4h),
    openInterest: Array.from({ length }, (_, index) => 1_000 + index),
    volatilityCompression: { squeeze_age_hours: squeezeAge },
    volumeOrderFlow: {
      volume_acceleration_3h: volumeAcceleration,
      volume_z_30d: volumeZ,
    },
    derivatives: {
      oi_change_4h: oiChange,
      oi_change_4h_z_30d: oiChangeZ,
      funding_percentile_90d: fundingPercentile,
      crowd_vs_top_traders: crowdVsTopTraders,
    },
    social: {
      social_leads_price: socialLeadsPrice,
      social_dominance_z_30d: socialDominanceZ,
      interactions_z_30d: interactionsZ,
      interactions_acceleration_3h: interactionsAcceleration,
    },
    relativeStrength: { residual_z_30d: residualZ },
    breadthNarrative: {
      category_momentum_4h: categoryMomentum,
      category_breadth: categoryBreadth,
      coin_leads_category: coinLeadsCategory,
    },
  })

  assert.deepEqual(Object.keys(flags), [
    "coiling",
    "attention_ahead",
    "unconfirmed_move",
    "exhausted_hype",
    "laggard",
    "resilient",
    "squeeze_fuel",
  ])
  Object.values(flags).forEach(series => assert.equal(series.length, length))
  assert.equal(flags.coiling[0], true)
  assert.equal(flags.attention_ahead[0], false)
  assert.equal(flags.attention_ahead[1], true)
  assert.equal(flags.unconfirmed_move[0], null)
  assert.equal(flags.unconfirmed_move[drop], false)
  assert.equal(flags.unconfirmed_move[move], true)
  assert.equal(flags.exhausted_hype[calm], true)
  assert.equal(flags.laggard[0], null)
  assert.equal(flags.laggard[last], true)
  assert.equal(flags.resilient[last], true)
  assert.equal(flags.squeeze_fuel[drop], true)
  assert.equal(flags.squeeze_fuel[last], true)
})

test("calculateDivergenceFlags returns null when a required series is absent", () => {
  const length = 10
  const flags = calculateDivergenceFlags({
    close: Array(length).fill(100),
    btcClose: Array(length).fill(100),
  })

  assert.deepEqual(flags.coiling, Array(length).fill(null))
  assert.deepEqual(flags.attention_ahead, Array(length).fill(null))
  assert.deepEqual(flags.squeeze_fuel, Array(length).fill(null))
})
