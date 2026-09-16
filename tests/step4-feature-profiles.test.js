import assert from "node:assert/strict"
import test from "node:test"

import { buildAlignedCoinSeries, buildBaseSeries } from "../src/steps/step4-feature-metrics/build-base-series.js"
import { createFeatureProfile } from "../src/steps/step4-feature-metrics/build-feature-profiles.js"
import { calculateCoinMetrics } from "../src/steps/step4-feature-metrics/calculate-coin-metrics.js"

function study (periods) {
  return { periods }
}

function createHourlyData () {
  const times = [3_600, 7_200, 10_800]
  const periods = times.map((time, index) => ({
    time,
    max: 12 + index,
    min: 8 + index,
    close: 10 + index,
    volume: 100 + index,
  }))
  const dense = field => times.map((time, index) => ({
    time,
    [field]: index + 1,
  }))

  return {
    coin: {
      baseCurrencyId: "XTVCBTC",
      symbol: "BTC",
      marketSymbol: "BINANCE:BTCUSDT.P",
    },
    availability: {
      social: { status: "available" },
    },
    chart: { periods },
    studies: {
      volumeDelta: study([{ time: times[2], close: 3 }]),
      openInterest: study(dense("close")),
      fundingRate: study(dense("rate")),
      liquidations: study(times.map((time, index) => ({
        time,
        long: index,
        short: -index,
      }))),
      longShortRatioAccounts: study(dense("ratio")),
      topTradersLongShortPositions: study(times.map((time, index) => ({
        time,
        long: 50 + index,
        short: -50 + index,
      }))),
      premium: study(dense("close")),
      socialDominance: study(dense("percent")),
      interactions: study(dense("value")),
      activeContributors: study(dense("value")),
      createdPosts: study(dense("value")),
    },
  }
}

test("buildAlignedCoinSeries aligns the shorter Volume Delta history", () => {
  const hourlyData = createHourlyData()
  const times = hourlyData.chart.periods.map(period => period.time)
  const series = buildAlignedCoinSeries(hourlyData, times)

  assert.deepEqual(series.times, times)
  assert.deepEqual(series.close, [10, 11, 12])
  assert.deepEqual(series.volumeDelta, [null, null, 3])
  assert.deepEqual(series.shortLiquidations, [0, -1, -2])
  assert.deepEqual(series.topTradersShort, [-50, -49, -48])
})

test("buildAlignedCoinSeries omits an unavailable atomic social group", () => {
  const hourlyData = createHourlyData()
  hourlyData.availability.social.status = "unavailable"

  for (const key of [
    "socialDominance",
    "interactions",
    "activeContributors",
    "createdPosts",
  ]) {
    delete hourlyData.studies[key]
  }

  const times = hourlyData.chart.periods.map(period => period.time)
  const series = buildAlignedCoinSeries(hourlyData, times)

  assert.equal(series.socialStatus, "unavailable")
  assert.equal("socialDominance" in series, false)
  assert.equal("interactions" in series, false)
})

test("buildBaseSeries joins accepted data with step 1 metadata and preserves rank", () => {
  const hourlyData = createHourlyData()
  const input = {
    coinData: [hourlyData],
    sourceUniverse: {
      coins: [{
        rank: 1,
        baseCurrencyId: "XTVCBTC",
        symbol: "BTC",
        name: "Bitcoin",
        tradingViewSymbol: "CRYPTO:BTCUSD",
        categories: ["layer-1"],
        marketCap: 1_000,
        market: { tradingViewSymbol: "BINANCE:BTCUSDT.P" },
      }],
    },
  }
  const baseCoins = buildBaseSeries(input)

  assert.equal(baseCoins.length, 1)
  assert.equal(baseCoins[0].coin.rank, 1)
  assert.deepEqual(baseCoins[0].categories, ["layer-1"])
  assert.deepEqual(baseCoins[0].close, [10, 11, 12])
  assert.equal(baseCoins[0].hourlyData, hourlyData)
})

test("buildAlignedCoinSeries rejects a mismatched grid", () => {
  assert.throws(
    () => buildAlignedCoinSeries(createHourlyData(), [3_600, 7_200, 14_400]),
    /does not use the universe hourly grid/,
  )
})

test("createFeatureProfile compacts latest metrics and calculates 24h USD volume", () => {
  const baseCoin = {
    coin: { rank: 1, baseCurrencyId: "XTVCBTC", symbol: "BTC" },
    categories: ["layer-1"],
    metadata: { marketCap: 1_000 },
  }
  const coinSeries = {
    close: Array(24).fill(10),
    volume: Array(24).fill(2),
    socialStatus: "unavailable",
  }
  const calculated = {
    atr24hPct: Array(24).fill(0.02),
    categoryContext: {
      applicable: false,
      status: "insufficient_peers",
      category: null,
    },
    featureSeries: {
      volatilityCompression: { sample_metric: Array(24).fill(2) },
      movementLifecycle: {
        prior_runup_atr_72h: Array(24).fill(1),
        max_24h_runup_last_7d_atr: Array(24).fill(2),
        range_position_7d: Array(24).fill(0.5),
        distance_to_previous_high_atr: Array(24).fill(0.25),
        distance_to_previous_low_atr: Array(24).fill(2),
        pre_breakout_squeeze_age: Array(24).fill(null),
        squeeze_ended_hours_ago: Array(24).fill(null),
        breakout_age_hours: Array(24).fill(null),
        post_breakout_extension_atr: Array(24).fill(null),
        extension_from_base_atr: Array(24).fill(null),
        fresh_quiet_breakout: Array(24).fill(false),
        late_pump: Array(24).fill(false),
      },
      derivatives: {
        funding_rate: [...Array(23).fill(0.000123), -0.000123],
        oi_level_percentile_90d: [...Array(23).fill(0.5), 0.9],
      },
      social: null,
      breadthNarrative: {
        category_momentum_4h: Array(24).fill(null),
        category_breadth: Array(24).fill(null),
        coin_leads_category: Array(24).fill(null),
      },
      divergences: {
        attention_ahead: Array(24).fill(null),
        exhausted_hype: Array(24).fill(null),
        laggard: Array(24).fill(null),
        range_pressure_up: [...Array(23).fill(false), true],
        range_pressure_down: [...Array(23).fill(true), false],
        short_squeeze_setup: [...Array(23).fill(false), true],
        long_squeeze_setup: [...Array(23).fill(true), false],
      },
    },
  }
  const result = createFeatureProfile(baseCoin, coinSeries, calculated)

  assert.equal(result.rejection, null)
  assert.equal(result.profile.context.volume24hUsd, 480)
  assert.equal(result.profile.context.atr24hPct, 0.02)
  assert.equal(result.profile.context.categoryStatus, "insufficient_peers")
  assert.equal(result.profile.context.socialStatus, "unavailable")
  assert.equal(result.profile.features.social, null)
  assert.equal(result.profile.features.volatilityCompression.sample_metric, 2)
  assert.equal(result.profile.features.movementLifecycle.breakout_age_hours, null)
  assert.equal(result.profile.features.movementLifecycle.late_pump, false)
  assert.equal(result.profile.features.movementLifecycle.distance_to_previous_high_atr, 0.25)
  assert.equal(result.profile.features.movementLifecycle.distance_to_previous_low_atr, 2)
  assert.deepEqual(result.profile.features.derivatives, {
    funding_rate: -0.000123,
    oi_level_percentile_90d: 0.9,
  })
  assert.deepEqual(result.profile.features.divergences, {
    attention_ahead: null,
    exhausted_hype: null,
    laggard: null,
    range_pressure_up: true,
    range_pressure_down: false,
    short_squeeze_setup: true,
    long_squeeze_setup: false,
  })
  assert.equal("dataQuality" in result.profile, false)
})

test("createFeatureProfile downgrades an incomplete derived social block", () => {
  const result = createFeatureProfile(
    {
      coin: { rank: 1, baseCurrencyId: "XTVCBTC", symbol: "BTC" },
      categories: [],
      metadata: { marketCap: 1_000 },
    },
    {
      close: Array(24).fill(10),
      volume: Array(24).fill(2),
      socialStatus: "available",
    },
    {
      atr24hPct: Array(24).fill(0.02),
      categoryContext: {
        applicable: false,
        status: "not_applicable",
        category: null,
      },
      featureSeries: {
        social: {
          social_dominance_z_30d: [0],
          interactions_z_30d: [0],
          interactions_acceleration_3h: [null],
          interactions_per_contributor_z: [0],
          created_posts_per_active_contributor: [0],
          social_minus_price_z_3h: [null],
        },
        divergences: {
          attention_ahead: [null],
          exhausted_hype: [null],
        },
      },
    },
  )

  assert.equal(result.rejection, null)
  assert.equal(result.profile.context.socialStatus, "unavailable")
  assert.equal(result.profile.features.social, null)
  assert.equal(result.profile.features.divergences.attention_ahead, null)
  assert.equal(result.profile.features.divergences.exhausted_hype, null)
})

test("calculateCoinMetrics passes directional metrics and flags through to the latest feature profile", async (t) => {
  for (const direction of ["up", "down"]) {
    await t.test(direction, () => {
      const sign = direction === "up" ? 1 : -1
      const series = mapper => Array.from({ length: 2_240 }, (_, index) => mapper(index))
      const baseCoin = {
        coin: { baseCurrencyId: "TARGET", symbol: "TARGET" },
        categories: [],
        metadata: { marketCap: 1_000 },
      }
      const coinSeries = {
        close: series(index => index === 2_239 ? 100 + sign : 100 + Math.sin(index / 11)),
        high: series(() => 102),
        low: series(() => 98),
        volume: series(index => index >= 2_236 ? 200 : 100),
        volumeDelta: series(index => sign * (index >= 2_236 ? 40 : 20)),
        openInterest: series(index => 1_000 + index),
        fundingRate: series(index => -sign * (0.0001 + index * 0.000001)),
        premium: series(() => 0.1),
        longLiquidations: series(() => 0),
        shortLiquidations: series(() => 0),
        longShortRatioAccounts: series(() => direction === "up" ? 0.5 : 2),
        topTradersLong: series(() => 50),
        topTradersShort: series(() => 50),
        socialStatus: "unavailable",
      }
      const universeContext = {
        btcClose: series(index => 200 + Math.sin(index / 17)),
        total3esClose: series(index => 500 + Math.sin(index / 7)),
        categoryContextsByCoin: new Map([["TARGET", {
          applicable: false,
          status: "not_applicable",
          category: null,
          momentum4h: series(() => null),
          breadth: series(() => null),
          coinLeadsCategory: series(() => null),
        }]]),
      }
      const calculated = calculateCoinMetrics(coinSeries, universeContext, "TARGET")
      const result = createFeatureProfile(baseCoin, coinSeries, calculated)

      assert.equal(result.rejection, null)
      assert.equal(result.profile.features.derivatives.funding_rate, coinSeries.fundingRate.at(-1))
      assert.equal(result.profile.features.derivatives.oi_level_percentile_90d, 2_159.5 / 2_160)
      assert.equal(
        result.profile.features.derivatives.funding_percentile_90d,
        (direction === "up" ? 0.5 : 2_159.5) / 2_160,
      )
      assert.equal(result.profile.features.divergences.squeeze_fuel, true)
      for (const [flag, expected] of [
        ["range_pressure_up", direction === "up"],
        ["range_pressure_down", direction === "down"],
        ["short_squeeze_setup", direction === "up"],
        ["long_squeeze_setup", direction === "down"],
      ]) {
        assert.equal(calculated.featureSeries.divergences[flag][0], null)
        assert.equal(calculated.featureSeries.divergences[flag].at(-1), expected)
        assert.equal(result.profile.features.divergences[flag], expected)
      }
      for (const flag of ["short_squeeze_setup", "long_squeeze_setup", "squeeze_fuel"]) {
        assert.deepEqual(
          calculated.featureSeries.divergences[flag].slice(0, 2_159),
          Array(2_159).fill(null),
        )
      }
    })
  }
})

test("createFeatureProfile rejects an unavailable required latest metric", () => {
  const result = createFeatureProfile(
    {
      coin: { baseCurrencyId: "XTVCBTC", symbol: "BTC" },
      categories: [],
      metadata: { marketCap: 1_000 },
    },
    {
      close: [10],
      volume: [2],
      socialStatus: "unavailable",
    },
    {
      categoryContext: {
        applicable: true,
        status: "available",
        category: "layer-1",
      },
      featureSeries: {
        volatilityCompression: { sample_metric: [null] },
        social: null,
      },
    },
  )

  assert.equal(result.profile, null)
  assert.deepEqual(
    result.rejection.unavailableMetrics,
    ["volatilityCompression.sample_metric"],
  )
})
