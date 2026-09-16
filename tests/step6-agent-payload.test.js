import assert from "node:assert/strict"
import test from "node:test"

import { buildPreliminaryShortlist } from "../src/steps/step5-preliminary-filter/build-preliminary-shortlist.js"
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
    movementLifecycle: {
      prior_runup_atr_72h: 1.23456,
      max_24h_runup_last_7d_atr: 2.34567,
      prior_drawdown_atr_72h: 0,
      max_24h_drawdown_last_7d_atr: 1.45678,
      range_position_7d: 0.87654,
      distance_to_previous_high_atr: -0.123456,
      distance_to_previous_low_atr: 2.987654,
      pre_breakout_squeeze_age: 18,
      squeeze_ended_hours_ago: 3,
      breakout_age_hours: 2,
      post_breakout_extension_atr: 0.45678,
      extension_from_base_atr: 1.23456,
      fresh_quiet_breakout: true,
      late_pump: false,
      late_dump: false,
    },
    volumeOrderFlow: {
      volume_z_30d: 1.8345,
      volume_acceleration_3h: 0.25123,
      rel_volume_at_time: 1.87654,
      vd_net_4h_over_volume: -0.12345,
      cvd_minus_price_z_12h: 1.23456,
    },
    derivatives: {
      oi_change_1h: 0.00123,
      oi_change_4h: 0.01234,
      oi_change_12h: 0.02345,
      oi_acceleration_4h: 0.00678,
      oi_change_4h_z_30d: 1.2678,
      oi_level_percentile_90d: 0.876543,
      oi_up_while_rv_down: true,
      funding_rate: -0.0000123456789,
      funding_percentile_90d: 0.91234,
      funding_minus_oi_z_4h: -1.23456,
      premium_z_30d: 0.45678,
      liquidations_4h_over_oi: 0.0004567,
      liq_imbalance_4h: -0.81234,
      crowd_vs_top_traders: 0.12345,
    },
    social: {
      social_dominance_z_30d: 0.92345,
      interactions_z_30d: 1.23456,
      interactions_acceleration_3h: 0.4321,
      interactions_per_contributor_z: 2.34567,
      created_posts_per_active_contributor: 0.12345,
      social_minus_price_z_3h: 1.14567,
    },
    relativeStrength: {
      beta_btc_7d: 1.12345,
      corr_btc_24h: 0.65432,
      corr_btc_change_24h_vs_7d: -0.34567,
      residual_log_return_4h: 0.01234,
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
      range_pressure_up: false,
      range_pressure_down: false,
      short_squeeze_setup: false,
      long_squeeze_setup: false,
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
      socialStatus: "available",
      ...overrides.context,
    },
    features: Object.fromEntries(Object.entries(features).map(([group, values]) => {
      const override = overrides.features?.[group]

      return [group, override === null ? null : { ...values, ...override }]
    })),
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
      altMarketBackground: { status: "mixed", change4hPct: -1.23456789, breadth4h: 0.48858, warning: null },
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

  assert.equal(payload.schemaVersion, 7)
  assert.equal(payload.asOf, "2026-08-31T09:00:00.000Z")
  assert.equal(payload.timeframe, "1h")
  assert.equal(payload.candidateCount, 1)
  assert.equal(payload.schema.length, 60)
  assert.deepEqual(Object.keys(payload.definitions), payload.schema)
  assert.equal(payload.candidates[0].length, payload.schema.length)
  assert.deepEqual(payload.marketContext, {
    breadth4h: 0.489,
    altMarketBackground: { status: "mixed", change4hPct: -1.23456789, breadth4h: 0.48858, warning: null },
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
    priorRunupAtr72h: 1.235,
    max24hRunupLast7dAtr: 2.346,
    priorDrawdownAtr72h: 0,
    max24hDrawdownLast7dAtr: 1.457,
    rangePosition7d: 0.877,
    distanceToHigh24hAtr: -0.123,
    distanceToLow24hAtr: 2.988,
    preBreakoutSqueezeAge: 18,
    squeezeEndedHoursAgo: 3,
    breakoutAgeHours: 2,
    postBreakoutExtensionAtr: 0.457,
    extensionFromBaseAtr: 1.235,
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
    oiLevelPctile: 0.877,
    quietOi: true,
    fundingRate: -0.0000123456789,
    fundingPctile: 0.912,
    fundingMinusOiZ4h: -1.235,
    premiumZ: 0.457,
    liqImbalance: -0.812,
    crowdVsTop: 0.123,
    socialStatus: "available",
    socialDominanceZ: 0.923,
    interactionsZ: 1.235,
    socialAccel3hPct: 43.21,
    interactionsPerContributorZ: 2.346,
    postsPerContributor: 0.123,
    socialMinusPriceZ3h: 1.146,
    btcBeta7d: 1.123,
    btcCorr24h: 0.654,
    btcCorrChange: -0.346,
    residualLogReturn4hPct: 1.234,
    residualZ: 1.146,
    rsVsAlts12hPct: 2.345,
    categoryMoveAtr: 1.458,
    categoryBreadth: 0.667,
    coinLeadAtr: -0.486,
    flags: ["coiling", "resilient", "fresh_quiet_breakout"],
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

test("agent payload preserves order and nullable metrics", () => {
  const payload = buildAgentPayload(createShortlist([
    createCandidate("FIRST"),
    createCandidate("SECOND", {
      coin: { name: "Second" },
      context: {
        narrativeCategory: null,
        categoryStatus: "not_applicable",
      },
      features: {
        movementLifecycle: {
          pre_breakout_squeeze_age: null,
          squeeze_ended_hours_ago: null,
          breakout_age_hours: null,
          post_breakout_extension_atr: null,
          extension_from_base_atr: null,
          fresh_quiet_breakout: false,
          late_pump: false,
        },
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
  assert.equal(rows[1].preBreakoutSqueezeAge, null)
  assert.equal(rows[1].squeezeEndedHoursAgo, null)
  assert.equal(rows[1].breakoutAgeHours, null)
  assert.equal(rows[1].postBreakoutExtensionAtr, null)
  assert.equal(rows[1].extensionFromBaseAtr, null)
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
    "range_pressure_up",
    "range_pressure_down",
    "short_squeeze_setup",
    "long_squeeze_setup",
    "fresh_quiet_breakout",
    "late_pump",
    "late_dump",
  ])
})

test("unverified liquidation ratios never reach the agent payload", () => {
  const original = createCandidate("SOL")
  const changed = structuredClone(original)
  changed.features.derivatives.liquidations_4h_over_oi = 1_000_000

  const payload = buildAgentPayload(createShortlist([original]))
  assert.deepEqual(buildAgentPayload(createShortlist([changed])), payload)
  assert.equal(payload.schema.includes("liquidations4hOverOi"), false)
  assert.equal(payload.schema.includes("liqImbalance"), true)
})

test("agent payload marks the entire unavailable social block with nulls", () => {
  const payload = buildAgentPayload(createShortlist([
    createCandidate("DYDX", {
      context: { socialStatus: "unavailable" },
      features: {
        social: null,
        divergences: {
          attention_ahead: null,
          exhausted_hype: null,
        },
      },
    }),
  ]))
  const values = Object.fromEntries(payload.schema.map((name, index) => [
    name,
    payload.candidates[0][index],
  ]))

  assert.equal(values.socialStatus, "unavailable")

  for (const field of [
    "socialDominanceZ",
    "interactionsZ",
    "socialAccel3hPct",
    "interactionsPerContributorZ",
    "postsPerContributor",
    "socialMinusPriceZ3h",
  ]) {
    assert.equal(values[field], null)
  }
})

test("agent payload rejects incomplete social features marked available", () => {
  assert.throws(
    () => buildAgentPayload(createShortlist([
      createCandidate("SOL", {
        features: {
          social: { social_minus_price_z_3h: null },
        },
      }),
    ])),
    /social features do not match their status/,
  )
})

for (const background of [
  { status: "up", change4hPct: 0.000000001, breadth4h: 0.550000001, warning: null },
  { status: "down", change4hPct: -0.000000001, breadth4h: 0.449999999, warning: null },
  { status: "mixed", change4hPct: 1.23456789, breadth4h: 0.55, warning: null },
  { status: "unavailable", change4hPct: null, breadth4h: 0.6, warning: "TOTAL3ES недоступен" },
]) {
  test(`agent payload preserves the saved ${background.status} background without rounding or recalculation`, () => {
    const shortlist = createShortlist([createCandidate("SOL")])
    shortlist.marketContext.breadth = background.breadth4h
    shortlist.marketContext.altMarketBackground = background
    const before = structuredClone(shortlist)
    const payload = buildAgentPayload(shortlist)

    assert.deepEqual(payload.marketContext.altMarketBackground, background)
    assert.deepEqual(JSON.parse(JSON.stringify(payload)).marketContext.altMarketBackground, background)
    assert.deepEqual(shortlist, before)
    assert.equal(payload.schema.includes("altMarketBackground"), false)
    assert.match(payload.marketDefinitions.altMarketBackground, /шаге 4/)
    assert.match(payload.marketDefinitions.altMarketBackground, /не прогноз и не вероятность/)
    assert.match(payload.conventions.rounding, /altMarketBackground.*без округления/)
  })
}

test("agent payload leaves a legacy missing background unavailable instead of inferring it from breadth", () => {
  const shortlist = createShortlist([])
  delete shortlist.marketContext.altMarketBackground
  const payload = buildAgentPayload(shortlist)

  assert.equal(payload.marketContext.altMarketBackground, null)
  assert.deepEqual(Object.keys(payload.marketContext), Object.keys(payload.marketDefinitions))
})

for (const flag of ["range_pressure_up", "range_pressure_down", "short_squeeze_setup", "long_squeeze_setup"]) {
  test(`preliminary filter passes ${flag} and its supporting metrics to the agent without mutation`, () => {
    const candidate = createCandidate("SOL", {
      features: {
        movementLifecycle: { fresh_quiet_breakout: false },
        divergences: { coiling: false, resilient: false, [flag]: true },
      },
    })
    const before = structuredClone(candidate)
    const shortlist = { ...createShortlist([]), ...buildPreliminaryShortlist([candidate]) }
    const payload = buildAgentPayload(shortlist)
    const values = Object.fromEntries(payload.schema.map((name, index) => [name, payload.candidates[0][index]]))

    assert.equal(payload.candidateCount, 1)
    assert.deepEqual(values.flags, [flag])
    assert.equal(values.distanceToHigh24hAtr, -0.123)
    assert.equal(values.distanceToLow24hAtr, 2.988)
    assert.equal(values.fundingRate, candidate.features.derivatives.funding_rate)
    assert.equal(values.oiLevelPctile, 0.877)
    assert.ok(payload.flagDefinitions[flag])
    assert.deepEqual(candidate, before)
  })
}

test("funding keeps tiny signed values and flags are not recalculated from rounded metrics", () => {
  for (const funding of [-1e-12, 0, 1e-12]) {
    const candidate = createCandidate("SOL", {
      features: {
        movementLifecycle: { distance_to_previous_high_atr: 0.500001 },
        derivatives: { funding_rate: funding },
      },
    })
    const payload = buildAgentPayload(createShortlist([candidate]))
    const values = Object.fromEntries(payload.schema.map((name, index) => [name, payload.candidates[0][index]]))

    assert.equal(values.fundingRate, funding)
    assert.equal(values.distanceToHigh24hAtr, 0.5)
    assert.equal(values.flags.includes("range_pressure_up"), false)
    assert.match(payload.conventions.rounding, /fundingRate.*без округления/)
    assert.match(payload.conventions.flags, /до округления/)
  }
})

test("agent payload rejects missing or non-finite new core metrics with a rerun instruction", () => {
  for (const [group, field] of [
    ["movementLifecycle", "distance_to_previous_high_atr"],
    ["movementLifecycle", "distance_to_previous_low_atr"],
    ["derivatives", "funding_rate"],
    ["derivatives", "oi_level_percentile_90d"],
  ]) {
    for (const value of [undefined, null, NaN, Infinity]) {
      const candidate = createCandidate("SOL", { features: { [group]: { [field]: value } } })
      assert.throws(() => buildAgentPayload(createShortlist([candidate])), /rerun steps 4 and 5/)
    }
  }
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
