import assert from "node:assert/strict"
import test from "node:test"

import { decodeAgentPayload } from "../src/steps/step9-agent-payload/agent-payload-format.js"
import { buildAgentPayload } from "../src/steps/step9-agent-payload/build-agent-payload.js"

function createCandidate (symbol) {
  return {
    coin: { symbol, name: symbol, rank: 5 },
    context: {
      atr24hPct: 0.012345, marketCap: 12_345_678_900, volume24hUsd: 987_654_321,
      narrativeCategory: "layer-1", categoryStatus: "available", socialStatus: "available",
    },
    features: {
      volatilityCompression: {
        rv_24h_over_rv_7d: 0.61234, bb_bandwidth_pct_30d: 0.12345, atr_pct_90d: 0.23456,
        range_compression_streak: 3, squeeze_age_hours: 8,
      },
      movementLifecycle: {
        prior_runup_atr_72h: 1.23456, prior_drawdown_atr_72h: 0,
        max_24h_runup_last_7d_atr: 2.34567, max_24h_drawdown_last_7d_atr: 1.45678,
        range_position_7d: 0.87654, distance_to_previous_high_atr: -0.123456, distance_to_previous_low_atr: 2.987654,
        pre_breakout_squeeze_age: 18, squeeze_ended_hours_ago: 3, breakout_age_hours: 2,
        post_breakout_extension_atr: 0.45678, extension_from_base_atr: 1.23456,
        fresh_quiet_breakout: true, late_pump: false, late_dump: false,
      },
      volumeOrderFlow: {
        volume_z_30d: 1.8345, volume_acceleration_3h: 0.25123, rel_volume_at_time: 1.87654,
        vd_net_4h_over_volume: -0.12345, cvd_minus_price_z_12h: 1.23456,
      },
      derivatives: {
        oi_change_1h: 0.00123, oi_change_4h: 0.01234, oi_change_12h: 0.02345, oi_acceleration_4h: 0.00678,
        oi_change_4h_z_30d: 1.2678, oi_level_percentile_90d: 0.876543,
        funding_rate: -0.0000123456789, funding_percentile_90d: 0.91234, funding_minus_oi_z_4h: -1.23456,
        premium_z_30d: 0.45678, liquidations_4h_over_oi: 1_000_000, liq_imbalance_4h: -0.81234, crowd_vs_top_traders: 0.12345,
      },
      social: {
        social_dominance_z_30d: 0.92345, interactions_z_30d: 1.23456, interactions_acceleration_3h: 0.4321,
        interactions_per_contributor_z: 2.34567, created_posts_per_active_contributor: 0.12345, social_minus_price_z_3h: 1.14567,
      },
      relativeStrength: {
        beta_btc_7d: 1.12345, corr_btc_24h: 0.65432, corr_btc_change_24h_vs_7d: -0.34567,
        residual_log_return_4h: 0.01234, residual_z_30d: 1.14567, rs_vs_total3es_12h: 0.02345,
      },
      sustainedStrength: {
        status: "persistent", history_score: 81.4115, current_score: 91.23456,
        down_win_rate: 0.81234, down_positive_rate: 0.23456, down_excess_median: 0.0045678,
        up_participation_rate: 0.72345, excess_24h: 0.0345678,
      },
      breadthNarrative: { category_momentum_4h: 0.018, category_breadth: 0.66667 },
      divergences: { coiling: true, resilient: false },
    },
  }
}

test("agent data preserves order, units, signed funding and missing values through JSON", () => {
  const first = createCandidate("ZETA")
  const second = createCandidate("ALPHA")
  second.coin.rank = 1
  second.context.socialStatus = "unavailable"
  second.features.social = null
  Object.assign(second.features.movementLifecycle, {
    prior_runup_atr_72h: 0, prior_drawdown_atr_72h: 1.23456,
    breakout_age_hours: null, fresh_quiet_breakout: false,
  })
  const shortlist = {
    asOf: "2026-08-31T09:00:00.000Z", timeframe: "1h", candidateCount: 2, candidates: [first, second],
    marketContext: {
      altMarketBackground: { status: "mixed", change6hPct: -1.23456789, breadth6h: 0.48858, warning: null },
      segmentRotation6h: { btc: 0.0005958, eth: 0.0001151, alts: 0.0001051, stables: -0.000816 },
      stablecapChange6h: -0.000232,
    },
  }
  const payload = buildAgentPayload(shortlist)
  const { candidates } = decodeAgentPayload(JSON.parse(JSON.stringify(payload)))

  assert.deepEqual(candidates.map(coin => coin.symbol), ["ZETA", "ALPHA"])
  assert.deepEqual(candidates.map(coin => coin.priorMoveAtr72h), [1.235, -1.235])
  assert.equal(candidates[0].atrPct, 1.235)
  assert.equal(candidates[0].marketCapB, 12.346)
  assert.equal(candidates[0].volume24hM, 987.654)
  assert.equal(candidates[0].rvRatio, 0.612)
  assert.equal(candidates[0].volumeAccel3hPct, 25.123)
  assert.equal(candidates[0].oiChange4hPct, 1.234)
  assert.equal(candidates[0].fundingRate, -0.0000123456789)
  assert.equal(candidates[0].socialAccel3hPct, 43.21)
  assert.equal(candidates[0].residualLogReturn4hPct, 1.234)
  assert.equal(candidates[0].sustainedDownExcessMedianPct, 0.457)
  assert.equal(candidates[0].categoryMoveAtr, 1.458)
  assert.deepEqual(candidates[0].flags, ["coiling", "fresh_quiet_breakout"])
  assert.equal(Object.hasOwn(candidates[0], "liquidations4hOverOi"), false)
  assert.equal(candidates[1].breakoutAgeHours, null)
  assert.equal(candidates[1].socialStatus, "unavailable")
  assert.equal(candidates[1].interactionsZ, null)
  assert.deepEqual(candidates[1].flags, ["coiling"])
  assert.equal(payload.schemaVersion, 17)
  assert.deepEqual(payload.marketContext, {
    altMarketBackground: shortlist.marketContext.altMarketBackground,
    btcRotation6hPct: 0.06, ethRotation6hPct: 0.012, altsRotation6hPct: 0.011,
    stablesRotation6hPct: -0.082, stablecap6hPct: -0.023,
  })
})

test("agent payload refuses to relabel old market context as six-hour data", () => {
  assert.throws(() => buildAgentPayload({
    candidateCount: 0,
    candidates: [],
    marketContext: {
      segmentRotation: { btc: 0.01, eth: 0, alts: 0, stables: -0.01 },
      stablecapChange: 0.02,
    },
  }), /6-hour market context; rerun steps 4 and 5/)
})
