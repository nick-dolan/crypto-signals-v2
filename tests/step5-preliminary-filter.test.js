import assert from "node:assert/strict"
import test from "node:test"

import { buildPreliminaryShortlist } from "../src/steps/step5-preliminary-filter/build-preliminary-shortlist.js"

function createProfile (baseCurrencyId, overrides = {}) {
  const features = {
    volatilityCompression: {
      range_compression_streak: 0,
      squeeze_age_hours: 0,
    },
    volumeOrderFlow: {
      volume_acceleration_3h: 0,
      rel_volume_at_time: 1,
      vd_net_4h_over_volume: 0,
      cvd_divergence_12h: 0,
    },
    derivatives: {
      oi_acceleration_4h: 0,
      oi_change_4h_z_30d: 0,
      oi_up_while_rv_down: false,
      funding_percentile_90d: 0.5,
      liq_total_4h_over_oi: 0,
      liq_imbalance_4h: 0,
      crowd_vs_top_traders: 0,
    },
    social: {
      interactions_acceleration_3h: 0,
      social_leads_price: 0,
    },
    relativeStrength: {
      corr_btc_change_24h_vs_7d: 0,
      residual_z_30d: 0,
    },
    breadthNarrative: {
      category_momentum_4h: null,
      category_breadth: null,
      coin_leads_category: null,
    },
    divergences: {
      coiling: false,
      attention_ahead: false,
      unconfirmed_move: false,
      exhausted_hype: false,
      laggard: false,
      resilient: false,
      squeeze_fuel: false,
    },
  }

  return {
    coin: {
      rank: 1,
      baseCurrencyId,
      symbol: baseCurrencyId,
      ...overrides.coin,
    },
    context: {
      atr24hPct: 0.02,
      ...overrides.context,
    },
    features: Object.fromEntries(Object.entries(features).map(([group, values]) => [
      group,
      { ...values, ...overrides.features?.[group] },
    ])),
  }
}

function candidateById (result, baseCurrencyId) {
  return result.candidates.find(candidate => (
    candidate.coin.baseCurrencyId === baseCurrencyId
  ))
}

test("preliminary shortlist keeps every divergence and only top active axes", () => {
  const compressionProfiles = Array.from({ length: 6 }, (_, index) => createProfile(
    `compression-${index + 1}`,
    {
      features: {
        volatilityCompression: {
          squeeze_age_hours: index + 4,
          range_compression_streak: index,
        },
      },
    },
  ))
  const flagged = createProfile("flagged", {
    features: { divergences: { exhausted_hype: true } },
  })
  const socialNoise = createProfile("social-noise", {
    features: {
      social: {
        social_dominance_z_30d: 20,
        interactions_z_30d: 20,
      },
    },
  })
  const result = buildPreliminaryShortlist([
    ...compressionProfiles,
    flagged,
    socialNoise,
  ])

  assert.equal(result.candidateCount, 6)
  assert.equal(result.excludedCoinCount, 2)
  assert.equal(result.filter.eligibleCoinCountByAxis.compression, 6)
  assert.equal(result.filter.eligibleCoinCountByAxis.social, 0)
  assert.equal(candidateById(result, "compression-1"), undefined)
  assert.ok(candidateById(result, "compression-6"))
  assert.deepEqual(candidateById(result, "flagged").selection, {
    priority: 6,
    selectedBy: ["divergences"],
    divergenceFlags: ["exhausted_hype"],
    activeAxes: [],
    setupSignals: [],
    triggerSignals: [],
    contextSignals: [],
  })
  assert.equal(candidateById(result, "social-noise"), undefined)
})

test("preliminary shortlist represents all six active axes", () => {
  const profiles = [
    createProfile("compression", {
      features: { volatilityCompression: { squeeze_age_hours: 4 } },
    }),
    createProfile("volume", {
      features: {
        volumeOrderFlow: {
          volume_acceleration_3h: 0.25,
          rel_volume_at_time: 1.5,
        },
      },
    }),
    createProfile("derivatives", {
      features: {
        derivatives: {
          oi_change_4h_z_30d: 0.75,
          oi_up_while_rv_down: true,
        },
      },
    }),
    createProfile("social", {
      features: { social: { interactions_acceleration_3h: 0.25 } },
    }),
    createProfile("relative", {
      features: {
        relativeStrength: {
          corr_btc_change_24h_vs_7d: -0.3,
          residual_z_30d: 1,
        },
      },
    }),
    createProfile("narrative", {
      features: {
        breadthNarrative: {
          category_momentum_4h: 0.01,
          category_breadth: 0.6,
          coin_leads_category: -0.01,
        },
      },
    }),
  ]
  const result = buildPreliminaryShortlist(profiles)

  assert.equal(result.candidateCount, 6)

  for (const [baseCurrencyId, axisName] of [
    ["compression", "compression"],
    ["volume", "volumeOrderFlow"],
    ["derivatives", "derivatives"],
    ["social", "social"],
    ["relative", "relativeStrength"],
    ["narrative", "narrative"],
  ]) {
    const candidate = candidateById(result, baseCurrencyId)

    assert.ok(candidate)
    assert.deepEqual(candidate.selection.selectedBy, [axisName])
    assert.deepEqual(candidate.selection.activeAxes, [axisName])
  }
})

test("preliminary shortlist deduplicates overlapping reasons", () => {
  const result = buildPreliminaryShortlist([
    createProfile("overlap", {
      features: {
        volatilityCompression: { squeeze_age_hours: 6 },
        social: { social_leads_price: 1.2 },
        divergences: { coiling: true },
      },
    }),
  ])
  const candidate = result.candidates[0]

  assert.equal(result.candidateCount, 1)
  assert.deepEqual(candidate.selection.selectedBy, [
    "divergences",
    "compression",
    "social",
  ])
  assert.deepEqual(candidate.selection.divergenceFlags, ["coiling"])
  assert.deepEqual(candidate.selection.setupSignals, ["volatilityCompression"])
  assert.deepEqual(candidate.selection.triggerSignals, ["socialAttention"])
})

test("preliminary shortlist orders role combinations before context", () => {
  const divergence = { divergences: { exhausted_hype: true } }
  const result = buildPreliminaryShortlist([
    createProfile("weak", { features: divergence }),
    createProfile("context", {
      features: {
        ...divergence,
        relativeStrength: {
          corr_btc_change_24h_vs_7d: -0.4,
          residual_z_30d: 1.2,
        },
      },
    }),
    createProfile("two-triggers", {
      features: {
        ...divergence,
        volumeOrderFlow: {
          volume_acceleration_3h: 0.5,
          rel_volume_at_time: 2,
        },
        social: { interactions_acceleration_3h: 0.5 },
      },
    }),
    createProfile("setup-trigger", {
      features: {
        ...divergence,
        volatilityCompression: { squeeze_age_hours: 6 },
        volumeOrderFlow: {
          volume_acceleration_3h: 0.5,
          rel_volume_at_time: 2,
        },
      },
    }),
  ])

  assert.deepEqual(
    result.candidates.map(candidate => candidate.coin.baseCurrencyId),
    ["setup-trigger", "two-triggers", "context", "weak"],
  )
})

test("preliminary shortlist applies the limit after signal priority", () => {
  const weakProfiles = Array.from({ length: 60 }, (_, index) => createProfile(
    `weak-${String(index).padStart(2, "0")}`,
    { features: { divergences: { exhausted_hype: true } } },
  ))
  const strongProfile = createProfile("zz-strong", {
    features: {
      volatilityCompression: { squeeze_age_hours: 6 },
      volumeOrderFlow: {
        volume_acceleration_3h: 0.5,
        rel_volume_at_time: 2,
      },
      divergences: { coiling: true },
    },
  })
  const result = buildPreliminaryShortlist([...weakProfiles, strongProfile])

  assert.equal(result.filter.nominatedBeforeLimit, 61)
  assert.equal(result.filter.limitApplied, true)
  assert.equal(result.candidateCount, 60)
  assert.equal(result.candidates[0].coin.baseCurrencyId, "zz-strong")
  assert.ok(candidateById(result, "weak-58"))
  assert.equal(candidateById(result, "weak-59"), undefined)
})

test("preliminary shortlist rejects duplicate identities", () => {
  assert.throws(
    () => buildPreliminaryShortlist([
      createProfile("duplicate"),
      createProfile("duplicate"),
    ]),
    /duplicate XTVC|duplicate duplicate/,
  )
})
