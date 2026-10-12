import assert from "node:assert/strict"
import test from "node:test"

import { isFinite } from "../src/helpers/utils.typed.js"
import { buildAltMarketBackground } from "../src/steps/step4-feature-metrics/build-alt-market-background.js"
import { buildUniverseContext } from "../src/steps/step4-feature-metrics/build-universe-context.js"
import { calculateDivergenceFlags } from "../src/steps/step4-feature-metrics/metrics/divergence-flags.js"
import { calculateRelativeStrengthMetrics } from "../src/steps/step4-feature-metrics/metrics/relative-strength.js"

function assertClose (actual, expected, tolerance = 1e-10) {
  assert.ok(isFinite(actual) && Math.abs(actual - expected) <= tolerance, `${actual} != ${expected}`)
}

function createMarketContext (times) {
  const periods = close => times.map((time, index) => ({ time, close: close(index) }))
  return {
    source: "tradingview",
    timeframe: "1h",
    collectedAt: new Date((times.at(-1) + 3_600) * 1_000).toISOString(),
    series: {
      total: { symbol: "CRYPTOCAP:TOTAL", periods: periods(() => 1_000) },
      totales: { symbol: "CRYPTOCAP:TOTALES", periods: periods(index => 900 - index) },
      total2es: { symbol: "CRYPTOCAP:TOTAL2ES", periods: periods(() => 500) },
      total3es: { symbol: "CRYPTOCAP:TOTAL3ES", periods: periods(() => 300) },
    },
  }
}

function createBaseCoins (times) {
  return [
    ["TARGET", 100, 200], ["PEER1", 101, 103], ["PEER2", 102, 106], ["PEER3", 103, 102],
    ["XTVCBTC", 100, 100], ["FLAT1", 100, 100], ["FLAT2", 100, 100],
  ].map(([id, at8, at12], index) => ({
    coin: { baseCurrencyId: id, symbol: id === "XTVCBTC" ? "BTC" : id },
    categories: index < 4 ? ["Alpha"] : [],
    times,
    close: times.map((_, hour) => hour === 8 ? at8 : hour === 12 ? at12 : 100),
  }))
}

function altInput (closes = [100, 125, 90, 115, 110]) {
  const times = closes.map((_, index) => Date.parse("2026-09-16T04:00:00.000Z") / 1_000 + index * 3_600)
  const marketData = createMarketContext(times)
  marketData.series.total3es.periods = times.map((time, index) => ({ time, close: closes[index] }))
  return { asOf: "2026-09-16T08:00:00.000Z", breadth4h: 0.6, marketData }
}

function closeFromLogReturns (returns, initial = 100) {
  const close = [initial]
  for (const value of returns) {
    close.push(close.at(-1) * Math.exp(value))
  }
  return close
}

function closeFromFourHourReturns (returns) {
  const close = Array(returns.length).fill(100)
  for (let index = 4; index < close.length; index += 1) {
    close[index] = close[index - 4] * (1 + returns[index])
  }
  return close
}

test("universe context uses unrounded whole-market breadth, peer-only category medians and one hourly grid", () => {
  const times = Array.from({ length: 25 }, (_, index) => index * 3_600)
  const baseCoins = createBaseCoins(times)
  const context = buildUniverseContext(baseCoins, createMarketContext(times))
  const category = context.categoryContextsByCoin.get("TARGET")

  assert.equal(context.universeBreadth4h[3], null)
  assert.equal(context.universeBreadth4h[12], 3 / 7)
  assertClose(context.stablecapChange24h[24], 0.24)
  assertClose(context.segmentRotation4h[4].btc, -0.004)
  assertClose(context.segmentRotation4h[4].stables, 0.004)
  assertClose(category.momentum4h[12], 103 / 101 - 1)
  assert.equal(category.breadth[4], null)
  assert.equal(category.breadth[12], 2 / 3)
  assertClose(category.coinLeadsCategory[12], 1 - (103 / 101 - 1))

  const snapshotTimes = times.slice(0, 13)
  const market = createMarketContext(snapshotTimes)
  market.series.total3es.periods[9].close = 1_000
  market.series.total3es.periods[12].close = 270
  const snapshot = buildUniverseContext(createBaseCoins(snapshotTimes), market)
  assert.equal(snapshot.asOf, "1970-01-01T12:00:00.000Z")
  assert.equal(snapshot.altMarketBackground.status, "down")
  assert.equal(snapshot.altMarketBackground.change4hPct, -10)
  assert.equal(snapshot.altMarketBackground.breadth4h, 3 / 7)

  baseCoins[1].times = times.with(12, times[12] + 1)
  assert.throws(() => buildUniverseContext(baseCoins, createMarketContext(times)), /identical hourly time grid/)
})

test("relative strength has numeric beta, correlation and residual references without lookahead or bridged gaps", () => {
  const returns = Array.from({ length: 899 }, (_, index) => 0.0005 + (index % 11 - 5) * 0.0001)
  const input = {
    coinClose: closeFromLogReturns(returns.map(value => value * 2)),
    btcClose: closeFromLogReturns(returns),
    total3esClose: closeFromLogReturns(returns.map(value => value * 0.5), 1_000),
  }
  const metrics = calculateRelativeStrengthMetrics(input)
  const last = input.coinClose.length - 1

  assert.equal(metrics.beta_btc_7d[167], null)
  assert.equal(metrics.corr_btc_24h[23], null)
  assertClose(metrics.beta_btc_7d[last], 2)
  assertClose(metrics.corr_btc_24h[last], 1)
  assertClose(metrics.corr_btc_change_24h_vs_7d[last], 0)
  assertClose(metrics.residual_log_return_4h[last], 0)
  assertClose(metrics.rs_vs_total3es_12h[last], input.coinClose[last] / input.coinClose[last - 12] - input.total3esClose[last] / input.total3esClose[last - 12])

  const prefix = calculateRelativeStrengthMetrics(Object.fromEntries(
    Object.entries(input).map(([name, series]) => [name, series.slice(0, 880)]),
  ))
  for (const [name, series] of Object.entries(prefix)) {
    assert.deepEqual(series, metrics[name].slice(0, 880), name)
  }
  const gapped = calculateRelativeStrengthMetrics({ ...input, btcClose: input.btcClose.with(400, null) })
  assert.equal(gapped.beta_btc_7d[568], null)
  assertClose(gapped.beta_btc_7d[569], 2)
  assert.equal(gapped.corr_btc_24h[424], null)
  assertClose(gapped.corr_btc_24h[425], 1)
  const flat = calculateRelativeStrengthMetrics({ ...input, btcClose: Array(900).fill(100) })
  assert.equal(flat.beta_btc_7d[last], null)
  assert.equal(flat.residual_log_return_4h[last], null)
})

test("divergences distinguish setup, diagnostic moves and market resilience with null warmup", () => {
  const returns = Array.from({ length: 800 }, (_, index) => (index % 3 - 1) * 0.01)
  const btcReturns = [...returns]
  const categoryMomentum = [...returns]
  returns[798] = 0.5
  btcReturns[799] = -0.5
  categoryMomentum[799] = 0.2
  const filled = value => Array(800).fill(value)
  const flags = calculateDivergenceFlags({
    close: closeFromFourHourReturns(returns),
    btcClose: closeFromFourHourReturns(btcReturns),
    volatilityCompression: { squeeze_age_hours: filled(4) },
    volumeOrderFlow: { volume_acceleration_3h: filled(0.25), volume_z_30d: filled(0) },
    derivatives: { oi_change_4h: filled(0.01), oi_change_4h_z_30d: filled(0) },
    social: {
      social_minus_price_z_3h: [1, ...filled(2).slice(1)],
      social_dominance_z_30d: filled(2),
      interactions_z_30d: filled(0),
      interactions_acceleration_3h: filled(-1),
    },
    relativeStrength: { residual_z_30d: filled(1) },
    breadthNarrative: {
      category_momentum_4h: categoryMomentum,
      category_breadth: filled(0.7),
      coin_leads_category: filled(-0.01),
    },
  })

  assert.equal(flags.coiling[799], true)
  assert.equal(flags.attention_ahead[0], false)
  assert.equal(flags.attention_ahead[1], true)
  assert.equal(flags.unconfirmed_move[0], null)
  assert.equal(flags.unconfirmed_move[798], true)
  assert.equal(flags.unconfirmed_move[799], false)
  assert.equal(flags.exhausted_hype[799], true)
  assert.equal(flags.laggard[0], null)
  assert.equal(flags.laggard[799], true)
  assert.equal(flags.resilient[799], true)
})

test("alt background requires price and breadth agreement at strict 55/45 thresholds", () => {
  for (const [change, breadth4h, status] of [
    [10, 0.6, "up"], [-10, 0.4, "down"],
    [10, 0.55, "mixed"], [-10, 0.45, "mixed"],
    [10, 0.4, "mixed"], [-10, 0.6, "mixed"], [0, 0.6, "mixed"],
  ]) {
    const input = altInput([100, 125, 90, 115, 100 + change])
    const result = buildAltMarketBackground({ ...input, breadth4h })
    assert.equal(result.status, status, `${change}% with breadth ${breadth4h}`)
    assert.equal(result.change4hPct, change)
    assert.equal(result.breadth4h, breadth4h)
  }
})

test("alt background uses the exact asOf four-hour window, not nearby or future saved candles", () => {
  const input = altInput([100, 200, 190, 180, 150])
  const periods = input.marketData.series.total3es.periods
  input.marketData.collectedAt = "2099-01-01T00:00:00.000Z"
  input.marketData.series.total3es.periods = [
    { time: periods[0].time - 3_600, close: 1 },
    ...periods.toReversed(),
    { time: periods[4].time + 3_600, close: 1_000 },
  ]
  const result = buildAltMarketBackground(input)
  assert.equal(result.status, "up")
  assert.equal(result.change4hPct, 50)

  const shifted = altInput()
  shifted.marketData.series.total3es.periods.forEach(period => period.time += 3_600)
  assert.equal(buildAltMarketBackground(shifted).change4hPct, null)
})

test("alt background refuses unclosed or incomplete candles without replacing unavailable metrics with zero", () => {
  const closed = buildAltMarketBackground(altInput())
  assert.equal(closed.change4hPct, 10)
  for (const change of [
    input => input.marketData.collectedAt = "2026-09-16T08:59:59.999Z",
    input => input.marketData.series.total3es.periods.splice(2, 1),
    input => input.marketData.series.total3es.periods.push(input.marketData.series.total3es.periods[2]),
    input => input.marketData.series.total3es.periods[2].time += 1,
    input => input.marketData.series.total3es.periods[0].close = 0,
    input => input.marketData.series.total3es.symbol = "CRYPTOCAP:TOTAL3",
  ]) {
    const input = altInput()
    change(input)
    const result = buildAltMarketBackground(input)
    assert.equal(result.status, "unavailable")
    assert.equal(result.change4hPct, null)
    assert.equal(result.breadth4h, 0.6)
  }
  const noBreadth = buildAltMarketBackground({ ...altInput(), breadth4h: null })
  assert.equal(noBreadth.status, "unavailable")
  assert.equal(noBreadth.change4hPct, 10)
  assert.equal(noBreadth.breadth4h, null)
})
