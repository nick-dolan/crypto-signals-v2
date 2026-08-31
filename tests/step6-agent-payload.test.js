import assert from "node:assert/strict"
import test from "node:test"

import { buildAgentPayload } from "../src/steps/step6-agent-payload/build-agent-payload.js"

function createCandidate (symbol, overrides = {}) {
  const features = {
    volatilityCompression: {
      rv_24h_over_rv_7d: 0.61234,
      bb_bandwidth_pct_30d: 0.12345,
      atr_pct_90d: 0.23456,
      range_compression_streak: 3,
      squeeze_age_hours: 8,
    },
    volumeOrderFlow: {
      volume_z_30d: 1.8345,
      volume_acceleration_3h: 0.25123,
      rel_volume_at_time: 1.87654,
      vd_net_4h_over_volume: -0.12345,
      cvd_divergence_12h: 1.23456,
    },
    derivatives: {
      oi_change_1h: 0.00123,
      oi_change_4h: 0.01234,
      oi_change_12h: 0.02345,
      oi_acceleration_4h: 0.00678,
      oi_change_4h_z_30d: 1.2678,
      oi_up_while_rv_down: true,
      funding_percentile_90d: 0.91234,
      funding_oi_divergence: -1.23456,
      premium_z_30d: 0.45678,
      liq_total_4h_over_oi: 0.0004567,
      liq_imbalance_4h: -0.81234,
      crowd_vs_top_traders: 0.12345,
    },
    social: {
      social_dominance_z_30d: 0.92345,
      interactions_z_30d: 1.23456,
      interactions_acceleration_3h: 0.4321,
      interactions_per_contributor_z: 2.34567,
      created_posts_per_active_contributor: 0.12345,
      social_leads_price: 1.14567,
    },
    relativeStrength: {
      beta_btc_7d: 1.12345,
      corr_btc_24h: 0.65432,
      corr_btc_change_24h_vs_7d: -0.34567,
      residual_return_4h: 0.01234,
      residual_z_30d: 1.14567,
      rs_vs_total3es_12h: 0.02345,
    },
    breadthNarrative: {
      category_momentum_4h: 0.018,
      category_breadth: 0.66667,
      coin_leads_category: -0.006,
    },
    divergences: {
      coiling: true,
      attention_ahead: false,
      unconfirmed_move: false,
      exhausted_hype: false,
      laggard: false,
      resilient: true,
      squeeze_fuel: false,
    },
  }

  return {
    coin: {
      rank: 5,
      baseCurrencyId: `XTVC${symbol}`,
      symbol,
      name: "Solana",
      tradingViewSymbol: `CRYPTO:${symbol}USD`,
      marketSymbol: `BINANCE:${symbol}USDT.P`,
      categories: ["layer-1", "smart-contract-platforms"],
      ...overrides.coin,
    },
    context: {
      price: 123.45,
      atr24hPct: 0.012345,
      marketCap: 12_345_678_900,
      volume24hUsd: 987_654_321,
      narrativeCategory: "layer-1",
      categoryStatus: "available",
      ...overrides.context,
    },
    features: Object.fromEntries(Object.entries(features).map(([group, values]) => [
      group,
      { ...values, ...overrides.features?.[group] },
    ])),
    selection: {
      priority: 1,
      selectedBy: ["social"],
      activeAxes: ["social"],
    },
  }
}

function createShortlist (candidates) {
  return {
    generatedAt: "2026-08-31T10:00:00.000Z",
    featuresGeneratedAt: "2026-08-31T09:59:00.000Z",
    asOf: "2026-08-31T09:00:00.000Z",
    source: "tradingview",
    timeframe: "1h",
    marketContext: {
      breadth: 0.48858,
      segmentRotation: {
        btc: 0.0005958,
        eth: 0.0001131,
        alts: 0.0001018,
        stables: -0.0008108,
      },
      stablecapChange: -0.000232,
    },
    candidateCount: candidates.length,
    candidates,
  }
}

test("agent payload creates documented compact rows", () => {
  const payload = buildAgentPayload(createShortlist([createCandidate("SOL")]))
  const values = Object.fromEntries(payload.schema.map((name, index) => [
    name,
    payload.candidates[0][index],
  ]))

  assert.equal(payload.schemaVersion, 1)
  assert.equal(payload.asOf, "2026-08-31T09:00:00.000Z")
  assert.equal(payload.timeframe, "1h")
  assert.equal(payload.candidateCount, 1)
  assert.equal(payload.schema.length, 46)
  assert.deepEqual(Object.keys(payload.definitions), payload.schema)
  assert.equal(payload.candidates[0].length, payload.schema.length)
  assert.deepEqual(payload.marketContext, {
    breadth4h: 0.489,
    btcRotation4hPct: 0.06,
    ethRotation4hPct: 0.011,
    altsRotation4hPct: 0.01,
    stablesRotation4hPct: -0.081,
    stablecap24hPct: -0.023,
  })
  assert.deepEqual(values, {
    symbol: "SOL",
    name: "Solana",
    rank: 5,
    atrPct: 1.235,
    marketCapB: 12.346,
    volume24hM: 987.654,
    category: "layer-1",
    categoryStatus: "available",
    rvRatio: 0.612,
    bbPctile: 0.123,
    atrPctile: 0.235,
    rangeStreak: 3,
    squeezeAge: 8,
    volumeZ: 1.835,
    volumeAccel3hPct: 25.123,
    relVolume: 1.877,
    vdShare4h: -0.123,
    cvdMinusPriceZ12h: 1.235,
    oiChange1hPct: 0.123,
    oiChange4hPct: 1.234,
    oiChange12hPct: 2.345,
    oiAccel4hPct: 0.678,
    oiZ: 1.268,
    quietOi: true,
    fundingPctile: 0.912,
    fundingMinusOiZ4h: -1.235,
    premiumZ: 0.457,
    liqOiIndex: 0.046,
    liqImbalance: -0.812,
    crowdVsTop: 0.123,
    socialDominanceZ: 0.923,
    interactionsZ: 1.235,
    socialAccel3hPct: 43.21,
    interactionsPerContributorZ: 2.346,
    postsPerContributor: 0.123,
    socialVsPriceZ: 1.146,
    btcBeta7d: 1.123,
    btcCorr24h: 0.654,
    btcCorrChange: -0.346,
    residualLogReturn4hPct: 1.234,
    residualZ: 1.146,
    rsVsAlts12hPct: 2.345,
    categoryMoveAtr: 1.458,
    categoryBreadth: 0.667,
    coinLeadAtr: -0.486,
    flags: ["coiling", "resilient"],
  })

  const serialized = JSON.stringify(payload)

  for (const excluded of [
    "baseCurrencyId",
    "tradingViewSymbol",
    "marketSymbol",
    "selection",
    "priority",
    "selectedBy",
    "divergenceFlags",
    "activeAxes",
    "setupSignals",
    "triggerSignals",
    "contextSignals",
  ]) {
    assert.equal(serialized.includes(excluded), false)
  }
})

test("agent payload preserves order and nullable narrative metrics", () => {
  const payload = buildAgentPayload(createShortlist([
    createCandidate("FIRST"),
    createCandidate("SECOND", {
      coin: { name: "Second" },
      context: {
        narrativeCategory: null,
        categoryStatus: "not_applicable",
      },
      features: {
        breadthNarrative: {
          category_momentum_4h: null,
          category_breadth: null,
          coin_leads_category: null,
        },
        divergences: {
          coiling: false,
          laggard: null,
          resilient: false,
        },
      },
    }),
  ]))
  const rows = payload.candidates.map(row => Object.fromEntries(
    payload.schema.map((name, index) => [name, row[index]]),
  ))

  assert.deepEqual(rows.map(row => row.symbol), ["FIRST", "SECOND"])
  assert.equal(rows[1].category, null)
  assert.equal(rows[1].categoryStatus, "not_applicable")
  assert.equal(rows[1].categoryMoveAtr, null)
  assert.equal(rows[1].categoryBreadth, null)
  assert.equal(rows[1].coinLeadAtr, null)
  assert.deepEqual(rows[1].flags, [])
  assert.deepEqual(
    Object.keys(payload.marketDefinitions),
    Object.keys(payload.marketContext),
  )
  assert.deepEqual(Object.keys(payload.flagDefinitions), [
    "coiling",
    "attention_ahead",
    "unconfirmed_move",
    "exhausted_hype",
    "laggard",
    "resilient",
    "squeeze_fuel",
  ])
})

test("agent payload rejects an inconsistent shortlist count", () => {
  assert.throws(
    () => buildAgentPayload({
      ...createShortlist([createCandidate("SOL")]),
      candidateCount: 2,
    }),
    /declares 2 candidates but contains 1/,
  )
})
