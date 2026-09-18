import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

import { isArray } from "../src/helpers/utils.typed.js"
import { buildPreliminaryShortlist } from "../src/steps/step5-preliminary-filter/build-preliminary-shortlist.js"
import { decodeAgentPayload } from "../src/steps/step6-agent-payload/agent-payload-format.js"
import { buildAgentPayload } from "../src/steps/step6-agent-payload/build-agent-payload.js"
import { analyzeCandidates } from "../src/steps/step7-agent-analysis/analyze-candidates.js"

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
    sustainedStrength: {
      status: "persistent",
      history_score: 81.4115,
      current_score: 91.23456,
      history_hours: 1440.12345,
      peer_count: 99,
      down_windows: 64,
      up_windows: 85,
      daily_windows: 60,
      weekly_windows: 8,
      down_win_rate: 0.81234,
      down_positive_rate: 0.23456,
      down_excess_median: 0.0045678,
      up_participation_rate: 0.72345,
      up_excess_median: -0.00123456,
      daily_win_rate: 0.84567,
      weekly_win_rate: 0.875,
      excess_4h: 0.0123456,
      excess_12h: 0.0234567,
      excess_24h: 0.0345678,
      excess_7d: 0.0456789,
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

function getSustainedValues (payload, index = 0) {
  return Object.fromEntries(Object.entries(decodeAgentPayload(payload).candidates[index])
    .filter(([field]) => field.startsWith("sustained")))
}

test("agent payload groups the original fields in the approved order, including an empty shortlist", () => {
  const payload = buildAgentPayload(createShortlist([]))

  assert.equal(payload.candidateCount, 0)
  assert.deepEqual(payload.candidates, [])
  assert.deepEqual(decodeAgentPayload(payload).candidates, [])
  assert.deepEqual(Object.keys(payload.schema), [
    "profile", "volatility", "lifecycle", "volume", "derivatives", "social",
    "relativeStrength", "sustainedStrength", "categoryContext", "coingecko",
  ])
  assert.deepEqual(payload.schema, {
    profile: ["rank", "atrPct", "marketCapB", "volume24hM"],
    volatility: ["rvRatio", "bbPctile", "atrPctile", "rangeStreak", "squeezeAge"],
    lifecycle: [
      "priorRunupAtr72h",
      "max24hRunupLast7dAtr",
      "priorDrawdownAtr72h",
      "max24hDrawdownLast7dAtr",
      "rangePosition7d",
      "distanceToHigh24hAtr",
      "distanceToLow24hAtr",
      "preBreakoutSqueezeAge",
      "squeezeEndedHoursAgo",
      "breakoutAgeHours",
      "postBreakoutExtensionAtr",
      "extensionFromBaseAtr",
    ],
    volume: ["volumeZ", "volumeAccel3hPct", "relVolume", "vdShare4h", "cvdMinusPriceZ12h"],
    derivatives: [
      "oiChange1hPct",
      "oiChange4hPct",
      "oiChange12hPct",
      "oiAccel4hPct",
      "oiZ",
      "oiLevelPctile",
      "quietOi",
      "fundingRate",
      "fundingPctile",
      "fundingMinusOiZ4h",
      "premiumZ",
      "liqImbalance",
      "crowdVsTop",
    ],
    social: [
      "socialStatus",
      "socialDominanceZ",
      "interactionsZ",
      "socialAccel3hPct",
      "interactionsPerContributorZ",
      "postsPerContributor",
      "socialMinusPriceZ3h",
    ],
    relativeStrength: [
      "btcBeta7d",
      "btcCorr24h",
      "btcCorrChange",
      "residualLogReturn4hPct",
      "residualZ",
      "rsVsAlts12hPct",
    ],
    sustainedStrength: [
      "sustainedStatus",
      "sustainedHistoryScore",
      "sustainedCurrentScore",
      "sustainedDownWinRate",
      "sustainedDownPositiveRate",
      "sustainedDownExcessMedianPct",
      "sustainedUpParticipationRate",
      "sustainedExcess24hPct",
    ],
    categoryContext: ["category", "categoryStatus", "categoryMoveAtr", "categoryBreadth", "coinLeadAtr"],
    coingecko: ["coingeckoId", "coingeckoTrending", "coingeckoTrendingCategories"],
  })
})

test("agent payload creates documented grouped candidates without changing market values", () => {
  const shortlist = createShortlist([createCandidate("SOL")])
  const before = structuredClone(shortlist)
  const payload = buildAgentPayload(shortlist)
  const { fields, candidates: [values] } = decodeAgentPayload(payload)

  assert.equal(payload.schemaVersion, 11)
  assert.equal(payload.asOf, "2026-08-31T09:00:00.000Z")
  assert.equal(payload.timeframe, "1h")
  assert.equal(payload.objective, "P(|движение| > 2.5 ATR в следующие 4–12 часов)")
  assert.equal(payload.candidateOrder, "От наиболее приоритетного кандидата к наименее приоритетному")
  assert.equal(payload.candidateCount, 1)
  assert.equal(fields.length, 71)
  assert.equal(new Set(fields).size, 71)
  assert.equal(fields.includes("selectionRank"), false)
  assert.equal(Object.hasOwn(values, "selectionRank"), false)
  assert.equal(Object.keys(payload.definitions).length, fields.length + 1)
  assert.deepEqual(Object.keys(payload.definitions).sort(), [...fields, "selectionRank"].sort())
  assert.equal(payload.definitions.selectionRank, "Приоритет предварительного отбора, не готовый ответ")
  assert.deepEqual(Object.keys(payload.candidates[0]), [
    "symbol", "name", "selectionRank", ...Object.keys(payload.schema), "flags",
  ])
  assert.equal(payload.candidates[0].selectionRank, 1)
  for (const [group, names] of Object.entries(payload.schema)) {
    assert.ok(isArray(payload.candidates[0][group]), group)
    assert.equal(payload.candidates[0][group].length, names.length, group)
  }
  assert.deepEqual(shortlist, before)
  assert.deepEqual(decodeAgentPayload(JSON.parse(JSON.stringify(payload))), { fields, candidates: [values] })
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
    sustainedStatus: "persistent",
    sustainedHistoryScore: 81.412,
    sustainedCurrentScore: 91.235,

    sustainedDownWinRate: 0.812,
    sustainedDownPositiveRate: 0.235,
    sustainedDownExcessMedianPct: 0.457,
    sustainedUpParticipationRate: 0.723,
    sustainedExcess24hPct: 3.457,
    categoryMoveAtr: 1.458,
    categoryBreadth: 0.667,
    coinLeadAtr: -0.486,
    coingeckoId: null,
    coingeckoTrending: null,
    coingeckoTrendingCategories: null,
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
    assert.equal(serialized.includes(`"${excluded}"`), false)
  }
})

test("CoinGecko context passes JSON, validation and step 7 evidence without changing candidate order", async () => {
  const shortlist = createShortlist([
    createCandidate("SOL", {
      coin: { coingecko: { id: "solana", isTrending: true, trendingCategories: ["Layer 1 (L1)", "Smart Contract Platform"] } },
    }),
    createCandidate("BTC"),
    createCandidate("ETH", { coin: { coingecko: null } }),
    createCandidate("BNB", {
      coin: { coingecko: { id: "binancecoin", isTrending: true, trendingCategories: [] } },
    }),
  ])
  const before = structuredClone(shortlist)
  const payload = JSON.parse(JSON.stringify(buildAgentPayload(shortlist)))
  const { candidates } = decodeAgentPayload(payload)

  assert.deepEqual(payload.candidates.map(candidate => candidate.coingecko), [
    ["solana", true, ["Layer 1 (L1)", "Smart Contract Platform"]],
    [null, null, null],
    [null, null, null],
    ["binancecoin", true, []],
  ])
  assert.deepEqual(
    candidates.map(candidate => payload.schema.coingecko.map(field => candidate[field])),
    payload.candidates.map(candidate => candidate.coingecko),
  )
  assert.deepEqual(payload.candidates.map(candidate => [candidate.symbol, candidate.selectionRank]), [
    ["SOL", 1], ["BTC", 2], ["ETH", 3], ["BNB", 4],
  ])
  assert.equal(candidates[0].category, "layer-1")

  const systemPrompt = await readFile(new URL("../src/prompts/strong-move-probability.md", import.meta.url), "utf8")
  const analysis = await analyzeCandidates(payload, shortlist, systemPrompt, {
    callAgent: async (prompt, input) => {
      assert.equal(prompt, systemPrompt)
      assert.deepEqual(JSON.parse(input), payload)
      return JSON.stringify({
        schemaVersion: 1,
        asOf: payload.asOf,
        topCandidates: [],
        assessments: candidates.map(({ symbol }) => ({
          symbol,
          movementProbability: 0.25,
          estimateConfidence: "medium",
          directionBias: "unclear",
          drivers: [{
            fields: ["coingeckoId", "coingeckoTrending", "coingeckoTrendingCategories"],
            text: "Поисковое внимание не подтверждает направление движения",
          }],
          counterSignals: [],
        })),
      })
    },
    readCoinData: async () => assert.fail("CoinGecko context must not require raw history"),
  })

  assert.deepEqual(analysis.assessments.map(assessment => assessment.symbol), ["SOL", "BTC", "ETH", "BNB"])
  assert.deepEqual(analysis.assessments.map(assessment => assessment.drivers[0]), [
    "coingeckoId=solana и coingeckoTrending=true и coingeckoTrendingCategories=[\"Layer 1 (L1)\",\"Smart Contract Platform\"]: Поисковое внимание не подтверждает направление движения",
    "coingeckoId=null и coingeckoTrending=null и coingeckoTrendingCategories=null: Поисковое внимание не подтверждает направление движения",
    "coingeckoId=null и coingeckoTrending=null и coingeckoTrendingCategories=null: Поисковое внимание не подтверждает направление движения",
    "coingeckoId=binancecoin и coingeckoTrending=true и coingeckoTrendingCategories=[]: Поисковое внимание не подтверждает направление движения",
  ])
  assert.deepEqual(shortlist, before)
})

test("agent payload never infers CoinGecko matches or emits false trending status", () => {
  for (const coingecko of [
    undefined,
    null,
    { isTrending: true, trendingCategories: ["Layer 1 (L1)"] },
    { id: " ", isTrending: true, trendingCategories: [] },
    { id: "solana", isTrending: false, trendingCategories: [] },
  ]) {
    const payload = buildAgentPayload(createShortlist([createCandidate("SOL", { coin: { coingecko } })]))
    assert.deepEqual(payload.candidates[0].coingecko, [null, null, null])
  }
})

test("confirmed CoinGecko matches require a category array rather than inventing an empty intersection", () => {
  for (const trendingCategories of [undefined, null, "Layer 1 (L1)", [null], [""]]) {
    const candidate = createCandidate("SOL", {
      coin: { coingecko: { id: "solana", isTrending: true, trendingCategories } },
    })
    assert.throws(() => buildAgentPayload(createShortlist([candidate])), /CoinGecko trendingCategories must be an array/)
  }
})

test("CoinGecko context leaves selection, late-move exclusions and existing payload values unchanged", () => {
  const profiles = [
    createCandidate("SOL", {
      coin: { coingecko: { id: "solana", isTrending: true, trendingCategories: ["Layer 1 (L1)"] } },
    }),
    createCandidate("BTC"),
    createCandidate("ETH", {
      coin: { coingecko: { id: "ethereum", isTrending: true, trendingCategories: ["Layer 1 (L1)"] } },
      features: { movementLifecycle: { late_pump: true } },
    }),
    createCandidate("BNB", {
      coin: { coingecko: { id: "binancecoin", isTrending: true, trendingCategories: [] } },
      features: { movementLifecycle: { late_dump: true } },
    }),
  ]
  const before = structuredClone(profiles)
  const baselineProfiles = structuredClone(profiles)
  for (const profile of baselineProfiles) {
    delete profile.coin.coingecko
  }
  const selection = buildPreliminaryShortlist(profiles)
  const baselineSelection = buildPreliminaryShortlist(baselineProfiles)
  const withoutCoinGecko = structuredClone(selection)
  for (const candidate of withoutCoinGecko.candidates) {
    delete candidate.coin.coingecko
  }

  assert.deepEqual(withoutCoinGecko, baselineSelection)
  assert.deepEqual(selection.candidates.map(candidate => candidate.coin.symbol), ["BTC", "SOL"])

  const payload = buildAgentPayload(createShortlist(selection.candidates))
  const baselinePayload = buildAgentPayload(createShortlist(baselineSelection.candidates))
  assert.deepEqual({
    ...payload,
    candidates: payload.candidates.map(candidate => ({ ...candidate, coingecko: [null, null, null] })),
  }, baselinePayload)
  assert.deepEqual(profiles, before)
})

test("agent payload and prompt explain CoinGecko attention, unknown matches and separate category semantics", async () => {
  const payload = buildAgentPayload(createShortlist([]))
  const systemPrompt = await readFile(new URL("../src/prompts/strong-move-probability.md", import.meta.url), "utf8")

  assert.match(payload.definitions.coingeckoId, /CoinGecko id.*Binance USDT perpetual.*TV/)
  assert.match(payload.definitions.coingeckoTrending, /true.*поисковому вниманию.*null.*false не используется/)
  assert.match(payload.definitions.coingeckoTrendingCategories, /пересечения.*не TV-категории.*\[\].*не отсутствие данных/)
  assert.match(payload.conventions.null, /не доказывает отсутствие тренда/)
  for (const text of [payload.conventions.coingecko, systemPrompt]) {
    assert.match(text, /coin_id/)
    assert.match(text, /fuzzy-сопоставлен/)
    assert.match(text, /поисковое внимание, не цена, направление или ранний вход/)
    assert.match(text, /late_pump.*late_dump/)
  }
  assert.match(systemPrompt, /\[null, null, null\].*не доказанное отсутствие тренда/)
  assert.match(systemPrompt, /coingeckoTrendingCategories: \[\].*пересечений категорий нет.*не что данные отсутствуют/)
  assert.match(systemPrompt, /не TV-категории из `categoryContext`/)
  assert.match(systemPrompt, /coingeckoTrendingCategories` целиком, без индексов массива/)
})

test("agent payload documents sustained strength units, coverage and precomputed status", () => {
  const payload = buildAgentPayload(createShortlist([]))
  const fields = payload.schema.sustainedStrength

  assert.deepEqual(fields, [
    "sustainedStatus",
    "sustainedHistoryScore",
    "sustainedCurrentScore",
    "sustainedDownWinRate",
    "sustainedDownPositiveRate",
    "sustainedDownExcessMedianPct",
    "sustainedUpParticipationRate",
    "sustainedExcess24hPct",
  ])
  for (const field of fields) {
    assert.match(payload.definitions[field], /^Context:/)
    if (field.includes("Excess")) {
      assert.match(payload.definitions[field], /п\.п\./)
    }
  }
  assert.match(payload.definitions.sustainedHistoryScore, /0–100.*не вероятность/)
  assert.match(payload.definitions.sustainedCurrentScore, /0–100.*Не вероятность/)
  assert.match(payload.definitions.sustainedHistoryScore, />= 28.*>= 4.*>= 12.*>= 12/)
  assert.match(payload.conventions.sustainedStrength, /до предварительного отбора/)
  assert.match(payload.conventions.sustainedStrength, /сама монета исключена; минимум 3/)
  assert.match(payload.conventions.sustainedStrength, /до округления.*не пересчитывай/)
})

test("agent payload and prompt omit internal sustained details without changing full profiles", async () => {
  const candidate = createCandidate("SOL")
  const before = structuredClone(candidate)
  const payload = buildAgentPayload(createShortlist([candidate]))
  const serialized = JSON.stringify(payload)
  const systemPrompt = await readFile(new URL("../src/prompts/strong-move-probability.md", import.meta.url), "utf8")

  for (const field of [
    "sustainedHistoryHours", "sustainedPeerCount", "sustainedDownWindows",
    "sustainedUpWindows", "sustainedDailyWindows", "sustainedWeeklyWindows",
    "sustainedUpExcessMedianPct", "sustainedDailyWinRate", "sustainedWeeklyWinRate",
    "sustainedExcess4hPct", "sustainedExcess12hPct", "sustainedExcess7dPct",
  ]) {
    assert.equal(serialized.includes(field), false, field)
    assert.equal(systemPrompt.includes(field), false, field)
  }

  const changed = structuredClone(candidate)
  for (const field of [
    "history_hours", "peer_count", "down_windows", "up_windows", "daily_windows",
    "weekly_windows", "up_excess_median", "daily_win_rate", "weekly_win_rate",
    "excess_4h", "excess_12h", "excess_7d",
  ]) {
    changed.features.sustainedStrength[field] = 0
  }
  assert.deepEqual(buildAgentPayload(createShortlist([changed])), payload)
  assert.deepEqual(candidate, before)
})

for (const block of ["missing", "null"]) {
  test(`agent payload maps a legacy ${block} sustained-strength block to unavailable values`, () => {
    const candidate = createCandidate("SOL")
    if (block === "missing") {
      delete candidate.features.sustainedStrength
    } else {
      candidate.features.sustainedStrength = null
    }
    const before = structuredClone(candidate)
    const payload = buildAgentPayload(createShortlist([candidate]))
    const values = getSustainedValues(payload)

    assert.equal(Object.keys(values).length, 8)
    assert.deepEqual(values, Object.fromEntries(Object.keys(values).map(field => [
      field, field === "sustainedStatus" ? "insufficient_data" : null,
    ])))
    assert.deepEqual(getSustainedValues(JSON.parse(JSON.stringify(payload))), values)
    assert.deepEqual(candidate, before)
  })
}

test("insufficient sustained history preserves current strength and partial evidence", () => {
  const candidate = createCandidate("SOL", {
    features: {
      sustainedStrength: {
        status: "insufficient_data",
        history_score: null,
        history_hours: 168,
        peer_count: 3,
        down_windows: 0,
        up_windows: 12,
        daily_windows: 7,
        weekly_windows: 1,
        down_win_rate: null,
        down_positive_rate: null,
        down_excess_median: null,
        up_participation_rate: 1,
        up_excess_median: 0.0156789,
        daily_win_rate: 1,
        weekly_win_rate: 0,
        excess_7d: -0.00123456,
      },
    },
  })
  const before = structuredClone(candidate)
  const payload = buildAgentPayload(createShortlist([candidate]))

  assert.deepEqual(getSustainedValues(payload), {
    sustainedStatus: "insufficient_data",
    sustainedHistoryScore: null,
    sustainedCurrentScore: 91.235,

    sustainedDownWinRate: null,
    sustainedDownPositiveRate: null,
    sustainedDownExcessMedianPct: null,
    sustainedUpParticipationRate: 1,
    sustainedExcess24hPct: 3.457,
  })
  assert.deepEqual(candidate, before)
})

test("unavailable current strength preserves history, zero rates and signed excess", () => {
  const payload = buildAgentPayload(createShortlist([createCandidate("SOL", {
    features: {
      sustainedStrength: {
        status: "insufficient_data",
        current_score: null,
        down_positive_rate: 0,
        down_excess_median: 0,
        excess_24h: -0.0234567,
        excess_7d: null,
      },
    },
  })]))
  const values = getSustainedValues(payload)

  assert.equal(values.sustainedStatus, "insufficient_data")
  assert.equal(values.sustainedHistoryScore, 81.412)
  assert.equal(values.sustainedCurrentScore, null)
  assert.equal(values.sustainedDownWinRate, 0.812)
  assert.equal(values.sustainedDownPositiveRate, 0)
  assert.equal(values.sustainedDownExcessMedianPct, 0)
  assert.equal(values.sustainedExcess24hPct, -2.346)
})

for (const [status, historyScore, currentScore, downWinRate] of [
  ["persistent", 65, 65, 0.6],
  ["emerging", 64.9999975, 65, 0.5999999],
  ["fading", 65, 64.999999, 0.6],
  ["neutral", 64.9999975, 64.999999, 0.5999999],
]) {
  test(`agent payload preserves precomputed ${status} strength across rounded thresholds`, () => {
    const candidate = createCandidate("SOL", {
      features: {
        sustainedStrength: {
          status,
          history_score: historyScore,
          current_score: currentScore,
          down_win_rate: downWinRate,
          up_participation_rate: 0.6,
          daily_win_rate: 0.6,
          weekly_win_rate: 0.8,
          down_excess_median: -1e-8,
          excess_4h: 1e-8,
          excess_12h: 1e-8,
          excess_24h: 1e-8,
          excess_7d: 1e-8,
        },
      },
    })
    const before = structuredClone(candidate)
    const payload = buildAgentPayload(createShortlist([candidate]))
    const values = getSustainedValues(payload)

    assert.equal(values.sustainedStatus, status)
    assert.equal(values.sustainedHistoryScore, 65)
    assert.equal(values.sustainedCurrentScore, 65)
    assert.equal(values.sustainedDownWinRate, 0.6)
    assert.equal(values.sustainedDownExcessMedianPct, 0)
    assert.equal(values.sustainedExcess24hPct, 0)
    assert.deepEqual(candidate, before)
  })
}

test("agent payload keeps shortlist order and separates selection rank from market rank", () => {
  const shortlist = createShortlist([
    createCandidate("ZETA", { coin: { rank: 50 } }),
    createCandidate("ALPHA", { coin: { rank: 1 } }),
    createCandidate("MID", { coin: { rank: 5 } }),
  ])
  const before = structuredClone(shortlist)
  const payload = buildAgentPayload(shortlist)
  const { candidates } = decodeAgentPayload(payload)

  assert.deepEqual(payload.candidates.map(candidate => [candidate.symbol, candidate.selectionRank]), [
    ["ZETA", 1], ["ALPHA", 2], ["MID", 3],
  ])
  assert.deepEqual(candidates.map(candidate => candidate.symbol), ["ZETA", "ALPHA", "MID"])
  assert.deepEqual(candidates.map(candidate => candidate.rank), [50, 1, 5])
  assert.deepEqual(shortlist, before)
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
  const { candidates: rows } = decodeAgentPayload(payload)

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
  assert.equal(decodeAgentPayload(payload).fields.includes("liquidations4hOverOi"), false)
  assert.equal(decodeAgentPayload(payload).fields.includes("liqImbalance"), true)
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
  const [values] = decodeAgentPayload(payload).candidates

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
    assert.equal(decodeAgentPayload(payload).fields.includes("altMarketBackground"), false)
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
    const [values] = decodeAgentPayload(payload).candidates

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
    const [values] = decodeAgentPayload(payload).candidates

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

test("sustained strength passes steps 5 → 6 → 7 without changing selection or peer benchmarks", async () => {
  const profiles = [
    createCandidate("FIRST", { features: { sustainedStrength: { peer_count: 4 } } }),
    createCandidate("SECOND", {
      features: {
        sustainedStrength: {
          status: "insufficient_data",
          history_score: null,
          history_hours: 168,
          peer_count: 4,
          down_windows: 12,
          up_windows: 12,
          daily_windows: 7,
          weekly_windows: 1,
        },
      },
    }),
    createCandidate("LATEPUMP", { features: { movementLifecycle: { late_pump: true } } }),
    createCandidate("LATEDUMP", { features: { movementLifecycle: { late_dump: true } } }),
    createCandidate("QUIET", {
      features: {
        volatilityCompression: { squeeze_age_hours: 0 },
        movementLifecycle: { fresh_quiet_breakout: false },
        volumeOrderFlow: { volume_acceleration_3h: 0 },
        derivatives: { oi_change_4h_z_30d: 0, funding_percentile_90d: 0.5 },
        social: { interactions_acceleration_3h: 0, social_minus_price_z_3h: 0 },
        relativeStrength: { corr_btc_change_24h_vs_7d: 0 },
        breadthNarrative: { category_momentum_4h: 0 },
        divergences: { coiling: false, resilient: false },
      },
    }),
  ]
  const before = structuredClone(profiles)
  const legacyProfiles = structuredClone(profiles)
  for (const profile of legacyProfiles) {
    delete profile.features.sustainedStrength
  }
  const selection = buildPreliminaryShortlist(profiles)
  const legacySelection = structuredClone(selection)
  for (const candidate of legacySelection.candidates) {
    delete candidate.features.sustainedStrength
  }

  assert.deepEqual(legacySelection, buildPreliminaryShortlist(legacyProfiles))
  assert.deepEqual(selection.candidates.map(candidate => candidate.coin.symbol), ["FIRST", "SECOND"])
  assert.deepEqual(selection.candidates.map(candidate => candidate.features.sustainedStrength), [
    profiles[0].features.sustainedStrength,
    profiles[1].features.sustainedStrength,
  ])

  const shortlist = JSON.parse(JSON.stringify({ ...createShortlist([]), ...selection }))
  const payload = JSON.parse(JSON.stringify(buildAgentPayload(shortlist)))
  assert.equal(payload.candidateCount, 2)
  assert.deepEqual(payload.candidates.map(candidate => [candidate.symbol, candidate.selectionRank]), [
    ["FIRST", 1], ["SECOND", 2],
  ])
  assert.equal(shortlist.candidates[0].features.sustainedStrength.peer_count, 4)
  assert.equal(getSustainedValues(payload).sustainedCurrentScore, 91.235)

  const systemPrompt = await readFile(new URL("../src/prompts/strong-move-probability.md", import.meta.url), "utf8")
  const response = {
    schemaVersion: 1,
    asOf: payload.asOf,
    topCandidates: [{
      symbol: "FIRST",
      movementProbability: 0.25,
      explanation: "После затишья торговая активность оживает, но подтверждение пока частичное.",
    }],
    assessments: selection.candidates.map(({ coin }) => ({
      symbol: coin.symbol,
      movementProbability: 0.25,
      estimateConfidence: "medium",
      directionBias: "unclear",
      drivers: [
        {
          fields: ["sustainedStatus", "sustainedHistoryScore", "sustainedCurrentScore"],
          text: "Относительная сила учитывается как контекст",
        },
        {
          fields: ["sustainedDownWinRate", "sustainedDownPositiveRate", "sustainedDownExcessMedianPct"],
          text: "Поведение при падении рынка дополняет общую оценку силы",
        },
      ],
      counterSignals: [{
        fields: ["sustainedUpParticipationRate", "sustainedExcess24hPct"],
        text: "Участие в росте требует отдельного подтверждения свежим триггером",
      }],
    })),
  }
  const analysis = await analyzeCandidates(payload, shortlist, systemPrompt, {
    callAgent: async (prompt, input) => {
      assert.equal(prompt, systemPrompt)
      assert.deepEqual(JSON.parse(input), payload)
      return JSON.stringify(response)
    },
    readCoinData: async () => assert.fail("Saved sustained strength must not require raw history"),
  })

  assert.deepEqual(analysis.assessments.map(assessment => assessment.drivers), [
    [
      "sustainedStatus=persistent и sustainedHistoryScore=81.412 и sustainedCurrentScore=91.235: Относительная сила учитывается как контекст",
      "sustainedDownWinRate=0.812 и sustainedDownPositiveRate=0.235 и sustainedDownExcessMedianPct=0.457: Поведение при падении рынка дополняет общую оценку силы",
    ],
    [
      "sustainedStatus=insufficient_data и sustainedHistoryScore=null и sustainedCurrentScore=91.235: Относительная сила учитывается как контекст",
      "sustainedDownWinRate=0.812 и sustainedDownPositiveRate=0.235 и sustainedDownExcessMedianPct=0.457: Поведение при падении рынка дополняет общую оценку силы",
    ],
  ])
  for (const assessment of analysis.assessments) {
    assert.deepEqual(assessment.counterSignals, [
      "sustainedUpParticipationRate=0.723 и sustainedExcess24hPct=3.457: Участие в росте требует отдельного подтверждения свежим триггером",
    ])
    assert.equal(assessment.movementProbability, 0.25)
    assert.equal(assessment.directionBias, "unclear")
  }
  assert.deepEqual(analysis.topCandidates[0].drivers, analysis.assessments[0].drivers)
  assert.deepEqual(profiles, before)
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
