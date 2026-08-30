import assert from "node:assert/strict"
import test from "node:test"

import { buildAlignedCoinSeries, buildBaseSeries } from "../src/steps/step4-feature-metrics/build-base-series.js"
import { createFeatureProfile } from "../src/steps/step4-feature-metrics/build-feature-profiles.js"

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
    times: Array.from({ length: 24 }, (_, index) => (index + 1) * 3_600),
    close: Array(24).fill(10),
    volume: Array(24).fill(2),
    volumeDelta: [...Array(8).fill(null), ...Array(16).fill(1)],
  }
  const calculated = {
    categoryContext: {
      applicable: false,
      status: "insufficient_peers",
      category: null,
    },
    featureSeries: {
      volatilityCompression: { sample_metric: Array(24).fill(2) },
      breadthNarrative: {
        category_momentum_4h: Array(24).fill(null),
        category_breadth: Array(24).fill(null),
        coin_leads_category: Array(24).fill(null),
      },
      divergences: { laggard: Array(24).fill(null) },
    },
  }
  const result = createFeatureProfile(baseCoin, coinSeries, calculated)

  assert.equal(result.rejection, null)
  assert.equal(result.profile.context.volume24hUsd, 480)
  assert.equal(result.profile.context.categoryStatus, "insufficient_peers")
  assert.equal(result.profile.features.volatilityCompression.sample_metric, 2)
  assert.equal(result.profile.dataQuality.volumeDeltaHours, 16)
  assert.equal(result.profile.dataQuality.historyHours, 24)
})

test("createFeatureProfile rejects an unavailable required latest metric", () => {
  const result = createFeatureProfile(
    {
      coin: { baseCurrencyId: "XTVCBTC", symbol: "BTC" },
      categories: [],
      metadata: { marketCap: 1_000 },
    },
    {
      times: [3_600],
      close: [10],
      volume: [2],
      volumeDelta: [1],
    },
    {
      categoryContext: {
        applicable: true,
        status: "available",
        category: "layer-1",
      },
      featureSeries: {
        volatilityCompression: { sample_metric: [null] },
      },
    },
  )

  assert.equal(result.profile, null)
  assert.deepEqual(
    result.rejection.unavailableMetrics,
    ["volatilityCompression.sample_metric"],
  )
})
