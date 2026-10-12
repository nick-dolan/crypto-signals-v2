import assert from "node:assert/strict"
import test from "node:test"

import { buildPreliminaryShortlist } from "../src/steps/step5-preliminary-filter/build-preliminary-shortlist.js"

function createProfile (baseCurrencyId, overrides = {}) {
  const features = {
    volatilityCompression: { range_compression_streak: 0, squeeze_age_hours: 0 },
    volumeOrderFlow: {
      volume_acceleration_3h: 0, rel_volume_at_time: 1, vd_net_4h_over_volume: 0, cvd_minus_price_z_12h: 0,
    },
    derivatives: {
      oi_acceleration_4h: 0, oi_change_4h_z_30d: 0, oi_up_while_rv_down: false,
      funding_rate: 0, funding_percentile_90d: 0.5, crowd_vs_top_traders: 0,
      liquidations_4h_over_oi: 0, liq_imbalance_4h: 0,
    },
    social: { interactions_acceleration_3h: 0, social_minus_price_z_3h: 0 },
    relativeStrength: { corr_btc_change_24h_vs_7d: 0, residual_z_30d: 0 },
    breadthNarrative: { category_momentum_4h: null, category_breadth: null, coin_leads_category: null },
    movementLifecycle: { fresh_quiet_breakout: false, late_dump: false, late_pump: false },
    divergences: {
      coiling: false, attention_ahead: false, unconfirmed_move: false, exhausted_hype: false,
      laggard: false, resilient: false, squeeze_fuel: false,
      range_pressure_up: false, range_pressure_down: false, short_squeeze_setup: false, long_squeeze_setup: false,
    },
  }
  return {
    coin: { rank: 1, baseCurrencyId, symbol: baseCurrencyId, ...overrides.coin },
    context: { atr24hPct: 0.02, socialStatus: "available", ...overrides.context },
    features: Object.fromEntries(Object.entries(features).map(([group, values]) => {
      const override = overrides.features?.[group]
      return [group, override === null ? null : { ...values, ...override }]
    })),
  }
}

function candidateById (result, baseCurrencyId) {
  return result.candidates.find(candidate => candidate.coin.baseCurrencyId === baseCurrencyId)
}

test("shortlist selects top active axes but social, context and diagnostic flags need market evidence", () => {
  const compression = Array.from({ length: 6 }, (_, index) => createProfile(`compression-${index + 1}`, {
    context: { socialStatus: "unavailable" },
    features: { volatilityCompression: { squeeze_age_hours: index + 4 }, social: null },
  }))
  const result = buildPreliminaryShortlist([
    ...compression,
    createProfile("flagged", { features: { divergences: { coiling: true } } }),
    createProfile("outside-core-five", {
      features: { volatilityCompression: { squeeze_age_hours: 4 }, social: { interactions_acceleration_3h: 0.5 } },
    }),
    createProfile("volume", {
      features: { volumeOrderFlow: { volume_acceleration_3h: 0.25, rel_volume_at_time: 1.5 } },
    }),
    createProfile("derivatives", {
      features: { derivatives: { oi_change_4h_z_30d: 0.75, oi_up_while_rv_down: true } },
    }),
    createProfile("relative", {
      features: {
        relativeStrength: { corr_btc_change_24h_vs_7d: -0.3, residual_z_30d: 1 },
        divergences: { coiling: true },
      },
    }),
    createProfile("narrative", {
      features: {
        breadthNarrative: { category_momentum_4h: 0.01, category_breadth: 0.6, coin_leads_category: -0.01 },
        divergences: { coiling: true },
      },
    }),
    createProfile("noise", {
      features: {
        social: { interactions_acceleration_3h: 0.5, social_minus_price_z_3h: 2 },
        relativeStrength: { corr_btc_change_24h_vs_7d: -0.4, residual_z_30d: 2 },
        breadthNarrative: { category_momentum_4h: 0.02, category_breadth: 0.8, coin_leads_category: -0.02 },
        divergences: { attention_ahead: true, laggard: true, resilient: true },
      },
    }),
    createProfile("diagnostic", { features: { divergences: { unconfirmed_move: true, exhausted_hype: true } } }),
  ])

  assert.equal(result.candidateCount, 11)
  assert.equal(candidateById(result, "compression-1"), undefined)
  for (const id of ["compression-2", "compression-3", "compression-4", "compression-5", "compression-6"]) {
    assert.deepEqual(candidateById(result, id).selection.selectedBy, ["compression"])
  }
  assert.deepEqual(candidateById(result, "outside-core-five").selection.selectedBy, ["social"])
  assert.deepEqual(candidateById(result, "flagged").selection.selectedBy, ["divergences"])
  for (const [id, axis] of [["volume", "volumeOrderFlow"], ["derivatives", "derivatives"], ["relative", "relativeStrength"], ["narrative", "narrative"]]) {
    assert.ok(candidateById(result, id).selection.selectedBy.includes(axis))
  }
  assert.equal(candidateById(result, "noise"), undefined)
  assert.equal(candidateById(result, "diagnostic"), undefined)
})

test("derivatives nomination respects funding direction and ignores unverified liquidation scale", () => {
  for (const [fundingRate, fundingPercentile, crowd, expected] of [
    [-0.0001, 0.05, -0.2, true], [0.0001, 0.95, 0.2, true],
    [0.0001, 0.05, -0.2, false], [-0.0001, 0.95, 0.2, false],
  ]) {
    const result = buildPreliminaryShortlist([createProfile("crowd", {
      features: {
        derivatives: { funding_rate: fundingRate, funding_percentile_90d: fundingPercentile, crowd_vs_top_traders: crowd },
      },
    })])
    assert.equal(result.candidateCount, Number(expected), `funding ${fundingRate}, percentile ${fundingPercentile}`)
    if (expected) {
      assert.deepEqual(result.candidates[0].selection.setupSignals, ["crowdedPositioning"])
    }
  }
  const result = buildPreliminaryShortlist([
    ...["a", "b", "c", "d", "e", "z-liquidations"].map(id => createProfile(id, {
      features: {
        derivatives: {
          oi_change_4h_z_30d: 0.75, oi_up_while_rv_down: true,
          liquidations_4h_over_oi: id === "z-liquidations" ? 1 : 0,
          liq_imbalance_4h: id === "z-liquidations" ? 1 : 0,
        },
      },
    })),
    createProfile("liquidations-only", {
      features: { derivatives: { liquidations_4h_over_oi: 1, liq_imbalance_4h: 1 } },
    }),
  ])
  assert.deepEqual(result.candidates.map(candidate => candidate.coin.baseCurrencyId), ["a", "b", "c", "d", "e"])
  assert.ok(result.candidates.every(candidate => candidate.selection.triggerSignals.length === 0))
})

test("late pumps and dumps are excluded before axis and divergence nomination", () => {
  const result = buildPreliminaryShortlist([
    createProfile("eligible", { features: { volatilityCompression: { squeeze_age_hours: 4 } } }),
    createProfile("late-pump", {
      features: {
        volatilityCompression: { squeeze_age_hours: 24 },
        volumeOrderFlow: { volume_acceleration_3h: 1, rel_volume_at_time: 4 },
        movementLifecycle: { late_pump: true },
        divergences: { coiling: true, short_squeeze_setup: true },
      },
    }),
    createProfile("late-dump", {
      features: {
        volatilityCompression: { squeeze_age_hours: 24 },
        movementLifecycle: { late_dump: true },
        divergences: { range_pressure_down: true, long_squeeze_setup: true },
      },
    }),
  ])

  assert.deepEqual(result.candidates.map(candidate => candidate.coin.baseCurrencyId), ["eligible"])
  assert.equal(result.filter.latePumpExcludedCoinCount, 1)
  assert.equal(result.filter.lateDumpExcludedCoinCount, 1)
  assert.equal(result.filter.divergenceNominatedCoinCount, 0)
  assert.equal(result.filter.eligibleCoinCountByAxis.compression, 1)
  assert.equal(result.filter.eligibleCoinCountByAxis.volumeOrderFlow, 0)
})

test("fresh and directional setups nominate without axes and overlapping confirmations count once", () => {
  for (const [flag, setup] of [
    ["range_pressure_up", []], ["range_pressure_down", []],
    ["short_squeeze_setup", ["squeezeFuel"]], ["long_squeeze_setup", ["squeezeFuel"]],
    ["squeeze_fuel", ["squeezeFuel"]],
  ]) {
    const result = buildPreliminaryShortlist([createProfile("directional", {
      features: { divergences: { [flag]: true } },
    })])
    assert.equal(result.candidateCount, 1, flag)
    assert.deepEqual(result.candidates[0].selection.setupSignals, setup)
    assert.deepEqual(result.candidates[0].selection.triggerSignals, flag === "squeeze_fuel" ? [] : ["volumeOrderFlow"])
  }
  const result = buildPreliminaryShortlist([
    createProfile("fresh", { features: { movementLifecycle: { fresh_quiet_breakout: true } } }),
    createProfile("overlap", {
      features: {
        volumeOrderFlow: { volume_acceleration_3h: 0.5, rel_volume_at_time: 2 },
        divergences: { squeeze_fuel: true, range_pressure_up: true, short_squeeze_setup: true },
      },
    }),
    createProfile("unavailable", {
      features: {
        divergences: { range_pressure_up: null, range_pressure_down: null, short_squeeze_setup: null, long_squeeze_setup: null },
      },
    }),
  ])
  assert.equal(result.candidateCount, 2)
  assert.deepEqual(candidateById(result, "fresh").selection.setupSignals, ["preBreakoutCompression"])
  assert.deepEqual(candidateById(result, "fresh").selection.triggerSignals, ["freshBreakout"])
  assert.deepEqual(candidateById(result, "overlap").selection.setupSignals, ["squeezeFuel"])
  assert.deepEqual(candidateById(result, "overlap").selection.triggerSignals, ["volumeOrderFlow"])
})

test("shortlist prioritizes setup plus trigger, multiple triggers and context before the limit", () => {
  const weak = Array.from({ length: 60 }, (_, index) => createProfile(`weak-${String(index).padStart(2, "0")}`, {
    features: { divergences: { coiling: true } },
  }))
  const noise = Array.from({ length: 60 }, (_, index) => createProfile(`aa-social-${index}`, {
    features: { social: { interactions_acceleration_3h: 1 }, divergences: { attention_ahead: true, resilient: true } },
  }))
  const result = buildPreliminaryShortlist([
    ...noise,
    ...weak,
    createProfile("zz-context", {
      features: {
        divergences: { coiling: true },
        relativeStrength: { corr_btc_change_24h_vs_7d: -0.4, residual_z_30d: 1.2 },
      },
    }),
    createProfile("zz-triggers", {
      features: {
        divergences: { coiling: true },
        volumeOrderFlow: { volume_acceleration_3h: 0.5, rel_volume_at_time: 2 },
        social: { interactions_acceleration_3h: 0.5 },
      },
    }),
    createProfile("zz-setup", {
      coin: { rank: 999 },
      features: {
        divergences: { coiling: true },
        volatilityCompression: { squeeze_age_hours: 6 },
        volumeOrderFlow: { volume_acceleration_3h: 0.5, rel_volume_at_time: 2 },
        movementLifecycle: { fresh_quiet_breakout: true },
      },
    }),
  ])

  assert.equal(result.filter.nominatedBeforeLimit, 63)
  assert.equal(result.candidateCount, 50)
  assert.deepEqual(result.candidates.slice(0, 3).map(candidate => candidate.coin.baseCurrencyId), ["zz-setup", "zz-triggers", "zz-context"])
  assert.equal(result.candidates[0].coin.rank, 999)
  assert.ok(candidateById(result, "weak-46"))
  assert.equal(candidateById(result, "weak-47"), undefined)
  assert.ok(result.candidates.every(candidate => !candidate.coin.baseCurrencyId.startsWith("aa-social-")))
})
