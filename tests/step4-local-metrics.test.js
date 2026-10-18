import assert from "node:assert/strict"
import test from "node:test"

import { isFinite } from "../src/helpers/utils.typed.js"
import { buildAlignedCoinSeries } from "../src/steps/step4-feature-metrics/build-base-series.js"
import { createFeatureProfile } from "../src/steps/step4-feature-metrics/build-feature-profiles.js"
import { calculateCoinMetrics } from "../src/steps/step4-feature-metrics/calculate-coin-metrics.js"
import { calculateDerivativesMetrics } from "../src/steps/step4-feature-metrics/metrics/derivatives.js"
import { calculateDivergenceFlags } from "../src/steps/step4-feature-metrics/metrics/divergence-flags.js"
import { calculateSocialMetrics } from "../src/steps/step4-feature-metrics/metrics/social.js"
import { calculateVolatilityCompressionMetrics } from "../src/steps/step4-feature-metrics/metrics/volatility-compression.js"
import { calculateVolumeOrderFlowMetrics } from "../src/steps/step4-feature-metrics/metrics/volume-order-flow.js"

const createSeries = mapper => Array.from({ length: 2_240 }, (_, index) => mapper(index))
const latest = series => series.at(-1)

function assertClose (actual, expected, tolerance = 1e-12) {
  assert.ok(isFinite(actual) && Math.abs(actual - expected) <= tolerance, `${actual} != ${expected}`)
}

function derivativesInput (openInterest) {
  const filled = value => openInterest.map(() => value)
  return {
    openInterest,
    fundingRate: filled(0),
    premium: filled(0.1),
    longLiquidations: filled(0),
    shortLiquidations: filled(0),
    longShortRatioAccounts: filled(1),
    topTradersLong: filled(50),
    topTradersShort: filled(-50),
    rv24OverRv7: filled(1),
  }
}

function socialInput (activePosts) {
  const filled = value => activePosts.map(() => value)
  return {
    close: filled(100),
    socialDominance: filled(2),
    interactions: filled(10),
    activeContributors: filled(10),
    createdPosts: filled(7),
    activePosts,
  }
}

function directionalInput (sign) {
  return {
    close: [100],
    movementLifecycle: {
      distance_to_previous_high_atr: [0.5],
      distance_to_previous_low_atr: [0.5],
    },
    volumeOrderFlow: { rel_volume_at_time: [1.5], vd_net_4h_over_volume: [sign * 0.1] },
    derivatives: {
      funding_rate: [-sign * 0.001],
      funding_percentile_90d: [sign === 1 ? 0.05 : 0.95],
      oi_level_percentile_90d: [0.8],
      oi_change_4h: [0.01],
      crowd_vs_top_traders: [-sign * 0.16],
    },
  }
}

test("volatility compression identifies a mature squeeze without future candles or filled gaps", () => {
  const close = createSeries(index => index >= 2_192 ? 100 : 100 + (index % 2 === 0 ? -4 : 4))
  const input = {
    close,
    high: close.map((value, index) => value + (index >= 2_192 ? 0.01 : 3)),
    low: close.map((value, index) => value - (index >= 2_192 ? 0.01 : 3)),
  }
  const metrics = calculateVolatilityCompressionMetrics(input)

  assert.equal(metrics.rv_24h_over_rv_7d[167], null)
  assert.equal(latest(metrics.rv_24h_over_rv_7d), 0)
  assertClose(latest(metrics.bb_bandwidth_pct_30d), 29 / 1_440)
  assertClose(latest(metrics.atr_pct_90d), 12 / 2_160)
  assert.equal(latest(metrics.range_compression_streak), 49)
  assert.ok(latest(metrics.squeeze_age_hours) >= 24)

  const prefix = calculateVolatilityCompressionMetrics(Object.fromEntries(
    Object.entries(input).map(([name, series]) => [name, series.slice(0, 2_216)]),
  ))
  for (const [name, series] of Object.entries(prefix)) {
    assert.deepEqual(series, metrics[name].slice(0, 2_216), name)
  }
  const gapped = calculateVolatilityCompressionMetrics({ ...input, high: input.high.with(2_238, null) })
  assert.equal(latest(gapped.squeeze_age_hours), null)
})

test("volume uses changing-price USD windows, base-volume delta shares and prior seasonal observations", () => {
  const input = {
    close: [...createSeries(() => 100).slice(0, -6), 10, 20, 30, 40, 50, 60],
    volume: [...createSeries(() => 10).slice(0, -6), 100, 100, 100, 200, 200, 200],
    volumeDelta: [...createSeries(() => 1).slice(0, -4), 10, 20, 30, 40],
  }
  const metrics = calculateVolumeOrderFlowMetrics(input)

  // USD volume rises from 6000 to 30000; base volume would give only a 100% rise.
  assertClose(latest(metrics.volume_acceleration_3h), 4)
  assertClose(latest(metrics.vd_net_4h_over_volume), 1 / 7)
  assertClose(latest(metrics.rel_volume_at_time), 12)

  const prefix = calculateVolumeOrderFlowMetrics(Object.fromEntries(
    Object.entries(input).map(([name, series]) => [name, series.slice(0, -6)]),
  ))
  for (const [name, series] of Object.entries(prefix)) {
    assert.deepEqual(series, metrics[name].slice(0, -6), name)
  }
  const gapped = calculateVolumeOrderFlowMetrics({ ...input, volume: input.volume.with(2_238, null) })
  assert.equal(latest(gapped.volume_acceleration_3h), null)
  assert.equal(latest(gapped.vd_net_4h_over_volume), null)
  const zeroPrevious = [...input.volume]
  zeroPrevious.fill(0, 2_234, 2_237)
  assert.equal(latest(calculateVolumeOrderFlowMetrics({ ...input, volume: zeroPrevious }).volume_acceleration_3h), null)
  const zeroCurrent = [...input.volume]
  zeroCurrent.fill(0, 2_236)
  assert.equal(latest(calculateVolumeOrderFlowMetrics({ ...input, volume: zeroCurrent }).vd_net_4h_over_volume), null)
  const zeroBaseline = [...createSeries(() => 0).slice(0, -6), ...input.volume.slice(-6)]
  assert.equal(latest(calculateVolumeOrderFlowMetrics({ ...input, volume: zeroBaseline }).rel_volume_at_time), null)
})

test("derivatives preserve signed funding and exactly 2160 OI observations with ties and gaps", () => {
  const openInterest = [null, ...Array(2_160).fill(1_000), 2_000, 1_000, null]
  const fundingRate = [null, -0.0123, 0, 0.0456, ...Array(2_160).fill(-0.000123)]
  const metrics = calculateDerivativesMetrics({ ...derivativesInput(openInterest), fundingRate })

  assert.deepEqual(metrics.funding_rate, fundingRate)
  assert.deepEqual(metrics.oi_level_percentile_90d.slice(0, 2_160), Array(2_160).fill(null))
  assert.equal(metrics.oi_level_percentile_90d[2_160], 0.5)
  assertClose(metrics.oi_level_percentile_90d[2_161], 2_159.5 / 2_160)
  assertClose(metrics.oi_level_percentile_90d[2_162], 2_159 / 2 / 2_160)
  assert.equal(metrics.oi_level_percentile_90d[2_163], null)
  assert.equal(metrics.oi_change_1h[2_162], -0.5)

  const rising = calculateDerivativesMetrics(derivativesInput(
    Array.from({ length: 13 }, (_, index) => 100 + index * 10),
  ))
  assertClose(latest(rising.oi_change_1h), 1 / 21)
  assertClose(latest(rising.oi_change_4h), 2 / 9)
  assertClose(latest(rising.oi_change_12h), 6 / 5)
  assertClose(latest(rising.oi_acceleration_4h), -4 / 63)
})

test("premium is not price-normalized and derivatives handle signed positions and zero denominators", () => {
  const input = {
    ...derivativesInput(createSeries(index => 1_000 + index)),
    close: createSeries(() => 100),
    premium: createSeries(index => index),
    longLiquidations: createSeries(() => 2),
    shortLiquidations: createSeries(() => -1),
    longShortRatioAccounts: createSeries(() => 3),
    topTradersLong: createSeries(() => 80),
    topTradersShort: createSeries(() => -20),
    rv24OverRv7: createSeries(() => 0.5),
  }
  const metrics = calculateDerivativesMetrics(input)
  const repriced = calculateDerivativesMetrics({ ...input, close: createSeries(index => 10 + index ** 2) })

  assertClose(latest(metrics.premium_z_30d), Math.sqrt(3 * 719 / 721))
  assert.deepEqual(metrics.premium_z_30d, repriced.premium_z_30d)
  assert.equal(latest(metrics.oi_up_while_rv_down), true)
  assertClose(latest(metrics.liquidations_4h_over_oi), 12 / 3_239)
  assertClose(latest(metrics.liq_imbalance_4h), 1 / 3)
  assertClose(latest(metrics.crowd_vs_top_traders), -0.1)

  const zero = calculateDerivativesMetrics({
    ...input,
    openInterest: createSeries(() => 0),
    longLiquidations: createSeries(() => 0),
    shortLiquidations: createSeries(() => 0),
    topTradersLong: createSeries(() => 0),
    topTradersShort: createSeries(() => 0),
  })
  assert.equal(latest(zero.liquidations_4h_over_oi), null)
  assert.equal(latest(zero.liq_imbalance_4h), 0)
  assert.equal(latest(zero.crowd_vs_top_traders), null)
})

test("social acceleration uses adjacent windows and does not divide by zero contributors", () => {
  const input = {
    ...socialInput(createSeries(() => 0)),
    interactions: [...createSeries(() => 10).slice(0, -3), 20, 20, 20],
    activeContributors: createSeries(index => index === 2_239 ? 0 : 10),
  }
  const metrics = calculateSocialMetrics(input)

  assertClose(latest(metrics.interactions_acceleration_3h), 1)
  assert.equal(latest(metrics.created_posts_per_active_contributor), 7)
  const gapped = calculateSocialMetrics({ ...input, interactions: input.interactions.with(2_238, null) })
  assert.equal(latest(gapped.interactions_acceleration_3h), null)
})

test("active posts normalize log levels over 30 days and compare adjacent six-hour means", () => {
  const metrics = calculateSocialMetrics(socialInput(createSeries(index => Math.expm1(index / 100))))

  assert.equal(metrics.active_posts_z_30d[718], null)
  assertClose(metrics.active_posts_z_30d[719], Math.sqrt(3 * 719 / 721), 1e-10)
  assertClose(latest(metrics.active_posts_z_30d), Math.sqrt(3 * 719 / 721), 1e-10)
  assert.deepEqual(metrics.active_posts_change_6h.slice(0, 11), Array(11).fill(null))
  assertClose(metrics.active_posts_change_6h[11], 0.06)
  assertClose(latest(metrics.active_posts_change_6h), 0.06)

  const irregular = calculateSocialMetrics(socialInput([
    ...createSeries(() => 5).slice(0, -12),
    0, 2, 4, 6, 8, 10,
    12, 16, 20, 24, 28, 32,
  ]))
  assertClose(latest(irregular.active_posts_change_6h), Math.log1p(22) - Math.log1p(5))
})

test("active posts preserve zeros and missing windows without looking ahead", () => {
  const input = socialInput([...createSeries(() => 0).slice(0, -6), 1, 2, 3, 4, 5, 6])
  const metrics = calculateSocialMetrics(input)

  assert.equal(metrics.active_posts_z_30d[2_233], 0)
  assert.equal(metrics.active_posts_change_6h[2_233], 0)
  assertClose(latest(metrics.active_posts_change_6h), Math.log1p(3.5))

  const prefix = calculateSocialMetrics(Object.fromEntries(
    Object.entries(input).map(([name, series]) => [name, series.slice(0, 2_237)]),
  ))
  for (const [name, series] of Object.entries(prefix)) {
    assert.deepEqual(series, metrics[name].slice(0, 2_237), name)
  }

  for (const index of [2_230, 2_236]) {
    const gapped = calculateSocialMetrics({ ...input, activePosts: input.activePosts.with(index, null) })
    assert.equal(latest(gapped.active_posts_change_6h), null)
    assert.equal(latest(gapped.active_posts_z_30d), null)
  }
  const earlierGap = calculateSocialMetrics({ ...input, activePosts: input.activePosts.with(2_200, null) })
  assert.equal(latest(earlierGap.active_posts_z_30d), null)
  assertClose(latest(earlierGap.active_posts_change_6h), Math.log1p(3.5))
})

test("range pressure requires signed proximity and flow, preserving null gaps", () => {
  for (const sign of [1, -1]) {
    const flag = sign === 1 ? "range_pressure_up" : "range_pressure_down"
    const opposite = sign === 1 ? "range_pressure_down" : "range_pressure_up"
    const distance = sign === 1 ? "distance_to_previous_high_atr" : "distance_to_previous_low_atr"
    const input = directionalInput(sign)
    const flags = calculateDivergenceFlags(input)
    assert.equal(flags[flag][0], true)
    assert.equal(flags[opposite][0], false)

    for (const [group, name, value, expected] of [
      ["movementLifecycle", distance, 0, true],
      ["movementLifecycle", distance, -0.01, false],
      ["movementLifecycle", distance, 0.51, false],
      ["volumeOrderFlow", "rel_volume_at_time", 1.49, false],
      ["volumeOrderFlow", "vd_net_4h_over_volume", sign * 0.09, false],
      ["volumeOrderFlow", "vd_net_4h_over_volume", -sign * 0.1, false],
    ]) {
      const scenario = structuredClone(input)
      scenario[group][name] = [value]
      assert.equal(calculateDivergenceFlags(scenario)[flag][0], expected, `${flag}: ${name} = ${value}`)
    }

    input.close = [100, 100, 100]
    input.movementLifecycle[distance] = [0.5, 0.5, 0.5]
    input.volumeOrderFlow.rel_volume_at_time = [1.5, 1.5, 1.5]
    input.volumeOrderFlow.vd_net_4h_over_volume = [null, sign * 0.1, null]
    assert.deepEqual(calculateDivergenceFlags(input)[flag], [null, true, null])
  }
})

test("squeeze setups require aligned funding, OI and flow while fuel needs strict crowd disagreement", () => {
  for (const sign of [1, -1]) {
    const setup = sign === 1 ? "short_squeeze_setup" : "long_squeeze_setup"
    const opposite = sign === 1 ? "long_squeeze_setup" : "short_squeeze_setup"
    const input = directionalInput(sign)
    const flags = calculateDivergenceFlags(input)
    assert.equal(flags[setup][0], true)
    assert.equal(flags[opposite][0], false)
    assert.equal(flags.squeeze_fuel[0], true)

    for (const [group, name, value, expectedSetup, expectedFuel] of [
      ["derivatives", "funding_rate", 0, false, false],
      ["derivatives", "funding_rate", sign * 0.001, false, false],
      ["derivatives", "funding_percentile_90d", sign === 1 ? 0.06 : 0.94, false, false],
      ["derivatives", "oi_level_percentile_90d", 0.79, false, false],
      ["derivatives", "oi_change_4h", 0, false, true],
      ["derivatives", "oi_change_4h", -0.01, false, true],
      ["volumeOrderFlow", "vd_net_4h_over_volume", -sign * 0.1, false, true],
      ["derivatives", "crowd_vs_top_traders", -sign * 0.15, true, false],
      ["derivatives", "crowd_vs_top_traders", sign * 0.16, true, false],
      ["volumeOrderFlow", "vd_net_4h_over_volume", null, null, true],
      ["derivatives", "funding_rate", null, null, null],
    ]) {
      const scenario = structuredClone(input)
      scenario[group][name] = [value]
      const actual = calculateDivergenceFlags(scenario)
      assert.equal(actual[setup][0], expectedSetup, `${setup}: ${name} = ${value}`)
      assert.equal(actual.squeeze_fuel[0], expectedFuel, `squeeze_fuel: ${name} = ${value}`)
    }
  }
})

test("profile assembly aligns short delta history, keeps latest calculations and rejects missing required metrics", () => {
  const times = createSeries(index => index * 3_600)
  const study = values => ({ periods: times.map((time, index) => ({ time, ...values(index) })) })
  const hourlyData = {
    coin: { baseCurrencyId: "TARGET", symbol: "TARGET" },
    availability: { social: { status: "unavailable" } },
    chart: {
      periods: times.map((time, index) => ({
        time, max: 102, min: 98, close: index === 2_239 ? 101 : 100, volume: index >= 2_236 ? 200 : 100,
      })),
    },
    studies: {
      volumeDelta: study(() => ({ close: 20 })),
      openInterest: study(index => ({ close: 1_000 + index })),
      fundingRate: study(index => ({ rate: index === 2_239 ? -0.000123 : 0.0001 })),
      liquidations: study(() => ({ long: 1, short: -1 })),
      longShortRatioAccounts: study(() => ({ ratio: 0.5 })),
      topTradersLongShortPositions: study(() => ({ long: 50, short: -50 })),
      premium: study(() => ({ close: 0.1 })),
    },
  }
  hourlyData.studies.volumeDelta.periods = hourlyData.studies.volumeDelta.periods.slice(734)
  const series = buildAlignedCoinSeries(hourlyData, times)
  const universeContext = {
    btcClose: createSeries(index => 200 + Math.sin(index / 17)),
    total3esClose: createSeries(index => 500 + Math.sin(index / 7)),
    categoryContextsByCoin: new Map([["TARGET", {
      applicable: false, status: "not_applicable", category: null,
      momentum4h: createSeries(() => null),
      breadth: createSeries(() => null),
      coinLeadsCategory: createSeries(() => null),
    }]]),
  }
  const calculated = calculateCoinMetrics(series, universeContext, "TARGET")
  const baseCoin = { coin: hourlyData.coin, categories: [], metadata: { marketCap: 1_000 } }
  const { profile, rejection } = createFeatureProfile(baseCoin, series, calculated)

  assert.deepEqual(series.volumeDelta.slice(0, 734), Array(734).fill(null))
  assert.equal(series.volumeDelta[734], 20)
  assert.equal(rejection, null)
  assert.equal(profile.context.volume24hUsd, 280_200)
  assertClose(profile.context.atr24hPct, 4 / 101)
  assert.equal(profile.features.derivatives.funding_rate, -0.000123)
  assertClose(profile.features.derivatives.oi_level_percentile_90d, 2_159.5 / 2_160)
  assert.equal(profile.features.divergences.short_squeeze_setup, true)
  assert.equal(profile.features.social, null)

  const socialData = {
    ...hourlyData,
    availability: { social: { status: "available" } },
    studies: {
      ...hourlyData.studies,
      socialDominance: study(() => ({ percent: 2 })),
      interactions: study(() => ({ value: 10 })),
      activeContributors: study(() => ({ value: 10 })),
      createdPosts: study(() => ({ value: 7 })),
      activePosts: study(index => ({ value: index >= 2_234 ? 42 : 0 })),
    },
  }
  const socialSeries = buildAlignedCoinSeries(socialData, times)
  assert.deepEqual(socialSeries.activePosts, createSeries(index => index >= 2_234 ? 42 : 0))
  const socialCalculated = calculateCoinMetrics(socialSeries, universeContext, "TARGET")
  const available = createFeatureProfile(baseCoin, socialSeries, socialCalculated)
  assert.equal(available.rejection, null)
  assert.equal(available.profile.context.socialStatus, "available")
  assert.ok(available.profile.features.social.active_posts_z_30d > 0)
  assertClose(available.profile.features.social.active_posts_change_6h, Math.log1p(42))

  socialCalculated.featureSeries.social.active_posts_change_6h[2_239] = null
  const partial = createFeatureProfile(baseCoin, socialSeries, socialCalculated)
  assert.equal(partial.rejection, null)
  assert.equal(partial.profile.context.socialStatus, "unavailable")
  assert.equal(partial.profile.features.social, null)
  assert.equal(partial.profile.features.divergences.attention_ahead, null)
  assert.equal(partial.profile.features.divergences.exhausted_hype, null)

  delete socialData.studies.activePosts
  assert.throws(() => buildAlignedCoinSeries(socialData, times), /rerun step 2/)

  calculated.featureSeries.derivatives.funding_rate[2_239] = null
  const missing = createFeatureProfile(baseCoin, series, calculated)
  assert.equal(missing.profile, null)
  assert.deepEqual(missing.rejection.unavailableMetrics, ["derivatives.funding_rate"])
})
