import assert from "node:assert/strict"
import test from "node:test"

import { calculateDerivativesMetrics } from "../src/steps/step4-feature-metrics/metrics/derivatives.js"
import { calculateSocialMetrics } from "../src/steps/step4-feature-metrics/metrics/social.js"
import { calculateVolatilityCompressionMetrics } from "../src/steps/step4-feature-metrics/metrics/volatility-compression.js"
import { calculateVolumeOrderFlowMetrics } from "../src/steps/step4-feature-metrics/metrics/volume-order-flow.js"

const createSeries = mapper => Array.from({ length: 2_240 }, (_, index) => mapper(index))
const latest = series => series.at(-1)

function assertClose (actual, expected, tolerance = 1e-12) {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `Expected ${actual} to be within ${tolerance} of ${expected}`,
  )
}

function assertMetricShape (metrics, expectedKeys) {
  assert.deepEqual(Object.keys(metrics), expectedKeys)

  for (const [name, series] of Object.entries(metrics)) {
    assert.equal(series.length, 2_240, `${name} must stay aligned`)

    series.forEach((value, index) => {
      assert.ok(
        value === null || typeof value === "boolean" || Number.isFinite(value),
        `${name}[${index}] must be null, boolean, or finite`,
      )
    })

    assert.notEqual(latest(series), null, `${name} must be established at the latest hour`)
  }
}

test("volatility compression metrics preserve alignment and identify a mature squeeze", () => {
  const quietStart = 2_240 - 48
  const close = createSeries(index => (
    index >= quietStart ? 100 : 100 + (index % 2 === 0 ? -4 : 4)
  ))
  const high = close.map((value, index) => (
    value + (index >= quietStart ? 0.01 : 3)
  ))
  const low = close.map((value, index) => (
    value - (index >= quietStart ? 0.01 : 3)
  ))
  const metrics = calculateVolatilityCompressionMetrics({ high, low, close })

  assertMetricShape(metrics, [
    "rv_24h_over_rv_7d",
    "bb_bandwidth_pct_30d",
    "atr_pct_90d",
    "range_compression_streak",
    "squeeze_age_hours",
  ])
  assert.equal(metrics.rv_24h_over_rv_7d[0], null)
  assert.equal(latest(metrics.rv_24h_over_rv_7d), 0)
  assert.ok(latest(metrics.bb_bandwidth_pct_30d) <= 0.2)
  assert.ok(latest(metrics.atr_pct_90d) <= 0.2)
  assert.ok(latest(metrics.range_compression_streak) >= 24)
  assert.ok(latest(metrics.squeeze_age_hours) > 0)
})

test("volume and order-flow metrics use USD volume and base-volume delta shares", () => {
  const close = createSeries(index => (
    index >= 2_240 - 20 ? 10 : 100 + Math.sin(index / 9) * 3
  ))
  const volume = createSeries((index) => {
    if (index >= 2_240 - 3) {
      return 200
    }

    if (index >= 2_240 - 6) {
      return 100
    }

    return 100 + index % 11
  })
  const volumeDelta = createSeries((index) => {
    if (index >= 2_240 - 4) {
      return [10, 20, 30, 40][index - (2_240 - 4)]
    }

    return index % 9 - 4
  })
  const metrics = calculateVolumeOrderFlowMetrics({ close, volume, volumeDelta })

  assertMetricShape(metrics, [
    "volume_z_30d",
    "volume_acceleration_3h",
    "rel_volume_at_time",
    "vd_net_4h_over_volume",
    "cvd_minus_price_z_12h",
  ])
  assertClose(latest(metrics.volume_acceleration_3h), 1)
  assertClose(latest(metrics.vd_net_4h_over_volume), 1 / 7)
})

test("derivatives metrics expose OI flags, liquidation fallbacks, and trader disagreement", () => {
  const close = createSeries(index => 100 + Math.sin(index / 13) * 2)
  const openInterest = createSeries(index => 1_000 + index + Math.sin(index / 7) * 2)
  const fundingRate = createSeries(index => Math.sin(index / 19) * 0.001)
  const premium = close.map((value, index) => (
    value * (0.001 + Math.sin(index / 17) * 0.0005)
  ))
  const longLiquidations = createSeries(index => (
    index >= 2_240 - 4 ? 0 : (index % 7 - 3) * 0.1
  ))
  const shortLiquidations = createSeries(index => (
    index >= 2_240 - 4 ? 0 : (index % 5 - 2) * 0.1
  ))
  const longShortRatioAccounts = createSeries(index => (
    index === 2_240 - 1 ? 3 : 1.2 + Math.sin(index / 23) * 0.2
  ))
  const topTradersLong = createSeries(index => index === 2_240 - 1 ? 80 : 55)
  const topTradersShort = createSeries(index => index === 2_240 - 1 ? 20 : 45)
  const rv24OverRv7 = createSeries((index) => {
    if (index < 168) {
      return null
    }

    return index === 2_240 - 1 ? 0.5 : 1.2
  })
  const metrics = calculateDerivativesMetrics({
    close,
    openInterest,
    fundingRate,
    premium,
    longLiquidations,
    shortLiquidations,
    longShortRatioAccounts,
    topTradersLong,
    topTradersShort,
    rv24OverRv7,
  })

  assertMetricShape(metrics, [
    "oi_change_1h",
    "oi_change_4h",
    "oi_change_12h",
    "oi_acceleration_4h",
    "oi_change_4h_z_30d",
    "oi_up_while_rv_down",
    "funding_percentile_90d",
    "funding_minus_oi_z_4h",
    "premium_z_30d",
    "liquidations_4h_over_oi",
    "liq_imbalance_4h",
    "crowd_vs_top_traders",
  ])
  assert.equal(metrics.oi_up_while_rv_down[0], null)
  assert.equal(latest(metrics.oi_up_while_rv_down), true)
  assert.equal(latest(metrics.liquidations_4h_over_oi), 0)
  assert.equal(latest(metrics.liq_imbalance_4h), 0)
  assertClose(latest(metrics.crowd_vs_top_traders), -0.1)
})

test("social metrics use adjacent windows and zero-contributor fallbacks", () => {
  const close = createSeries(index => 100 + Math.sin(index / 11) * 2)
  const socialDominance = createSeries(index => 2 + Math.sin(index / 29) * 0.5)
  const interactions = createSeries((index) => {
    if (index >= 2_240 - 3) {
      return 20
    }

    if (index >= 2_240 - 6) {
      return 10
    }

    return 50 + index % 13 * 2
  })
  const activeContributors = createSeries(index => (
    index === 2_240 - 1 ? 0 : 10 + index % 4
  ))
  const createdPosts = createSeries(index => index === 2_240 - 1 ? 7 : 5 + index % 3)
  const metrics = calculateSocialMetrics({
    close,
    socialDominance,
    interactions,
    activeContributors,
    createdPosts,
  })

  assertMetricShape(metrics, [
    "social_dominance_z_30d",
    "interactions_z_30d",
    "interactions_acceleration_3h",
    "interactions_per_contributor_z",
    "created_posts_per_active_contributor",
    "social_minus_price_z_3h",
  ])
  assertClose(latest(metrics.interactions_acceleration_3h), 1)
  assert.equal(latest(metrics.created_posts_per_active_contributor), 7)
})
