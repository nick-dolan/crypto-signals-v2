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
      cvd_minus_price_z_12h: 0,
    },
    derivatives: {
      oi_acceleration_4h: 0,
      oi_change_4h_z_30d: 0,
      oi_up_while_rv_down: false,
      funding_rate: 0,
      funding_percentile_90d: 0.5,
      liquidations_4h_over_oi: 0,
      liq_imbalance_4h: 0,
      crowd_vs_top_traders: 0,
    },
    social: {
      interactions_acceleration_3h: 0,
      social_minus_price_z_3h: 0,
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
    movementLifecycle: {
      fresh_quiet_breakout: false,
      late_dump: false,
      late_pump: false,
    },
    divergences: {
      coiling: false,
      attention_ahead: false,
      unconfirmed_move: false,
      exhausted_hype: false,
      laggard: false,
      resilient: false,
      squeeze_fuel: false,
      range_pressure_up: false,
      range_pressure_down: false,
      short_squeeze_setup: false,
      long_squeeze_setup: false,
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
      socialStatus: "available",
      ...overrides.context,
    },
    features: Object.fromEntries(Object.entries(features).map(([group, values]) => {
      const override = overrides.features?.[group]

      return [group, override === null ? null : { ...values, ...override }]
    })),
  }
}

function candidateById (result, baseCurrencyId) {
  return result.candidates.find(candidate => (
    candidate.coin.baseCurrencyId === baseCurrencyId
  ))
}

test("preliminary shortlist keeps nominating divergences and only top active axes", () => {
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
    features: { divergences: { coiling: true } },
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
    divergenceFlags: ["coiling"],
    activeAxes: [],
    setupSignals: [],
    triggerSignals: [],
    contextSignals: [],
  })
  assert.equal(candidateById(result, "social-noise"), undefined)
})

test("non-predictive divergence flags remain diagnostic without nominating or creating triggers", () => {
  const result = buildPreliminaryShortlist([
    createProfile("diagnostic", {
      features: {
        volatilityCompression: { squeeze_age_hours: 4 },
        divergences: { unconfirmed_move: true, exhausted_hype: true },
      },
    }),
    createProfile("unconfirmed-only", {
      features: { divergences: { unconfirmed_move: true } },
    }),
    createProfile("exhausted-only", {
      features: { divergences: { exhausted_hype: true } },
    }),
  ])
  const diagnostic = candidateById(result, "diagnostic")

  assert.equal(result.candidateCount, 1)
  assert.equal(result.filter.divergenceNominatedCoinCount, 0)
  assert.deepEqual(diagnostic.selection.selectedBy, ["compression"])
  assert.deepEqual(diagnostic.selection.divergenceFlags, [
    "unconfirmed_move", "exhausted_hype",
  ])
  assert.deepEqual(diagnostic.selection.triggerSignals, [])
})

for (const flag of ["coiling", "attention_ahead", "laggard", "resilient", "squeeze_fuel"]) {
  test(`preliminary shortlist preserves ${flag} as a nominating divergence`, () => {
    const result = buildPreliminaryShortlist([
      createProfile("candidate", { features: { divergences: { [flag]: true } } }),
    ])

    assert.equal(result.candidateCount, 1)
    assert.equal(result.filter.divergenceNominatedCoinCount, 1)
    assert.deepEqual(result.candidates[0].selection.selectedBy, ["divergences"])
    assert.deepEqual(result.candidates[0].selection.divergenceFlags, [flag])
  })
}

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

test("unverified liquidation scale cannot activate, score, or create a derivatives trigger", () => {
  const oiProfiles = ["a", "b", "c", "d", "e", "z-liquidations"].map(
    baseCurrencyId => createProfile(baseCurrencyId, {
      features: {
        derivatives: {
          oi_change_4h_z_30d: 0.75,
          oi_up_while_rv_down: true,
          ...(baseCurrencyId === "z-liquidations"
            ? { liquidations_4h_over_oi: 1, liq_imbalance_4h: 1 }
            : {}),
        },
      },
    }),
  )
  const result = buildPreliminaryShortlist([
    ...oiProfiles,
    createProfile("liquidations-only", {
      features: {
        derivatives: {
          liquidations_4h_over_oi: 1,
          liq_imbalance_4h: 1,
        },
      },
    }),
    createProfile("diagnostic-liquidations", {
      features: {
        derivatives: {
          liquidations_4h_over_oi: 1,
          liq_imbalance_4h: 1,
        },
        divergences: { range_pressure_up: true },
      },
    }),
  ])

  assert.deepEqual(
    result.candidates
      .filter(candidate => candidate.selection.selectedBy.includes("derivatives"))
      .map(candidate => candidate.coin.baseCurrencyId),
    ["a", "b", "c", "d", "e"],
  )
  assert.equal(candidateById(result, "z-liquidations"), undefined)
  assert.equal(candidateById(result, "liquidations-only"), undefined)
  assert.deepEqual(
    candidateById(result, "diagnostic-liquidations").selection.triggerSignals,
    ["volumeOrderFlow"],
  )
})

for (const [label, fundingRate, fundingPercentile, crowdPositioning, expected] of [
  ["negative rate at a low percentile with a short crowd", -0.0001, 0.05, -0.2, true],
  ["positive rate at a high percentile with a long crowd", 0.0001, 0.95, 0.2, true],
  ["positive rate at a low percentile", 0.0001, 0.05, -0.2, false],
  ["negative rate at a high percentile", -0.0001, 0.95, 0.2, false],
]) {
  test(`crowd setup requires aligned funding sign: ${label}`, () => {
    const result = buildPreliminaryShortlist([
      createProfile("candidate", {
        features: {
          derivatives: {
            funding_rate: fundingRate,
            funding_percentile_90d: fundingPercentile,
            crowd_vs_top_traders: crowdPositioning,
          },
        },
      }),
    ])

    assert.equal(result.candidateCount, Number(expected))

    if (expected) {
      assert.deepEqual(result.candidates[0].selection.selectedBy, ["derivatives"])
      assert.deepEqual(result.candidates[0].selection.setupSignals, ["crowdedPositioning"])
    }
  })
}

test("preliminary shortlist keeps a social-unavailable coin eligible by core axes", () => {
  const result = buildPreliminaryShortlist([
    createProfile("no-social", {
      context: { socialStatus: "unavailable" },
      features: {
        volatilityCompression: { squeeze_age_hours: 6 },
        social: null,
        divergences: {
          attention_ahead: null,
          exhausted_hype: null,
        },
      },
    }),
  ])
  const candidate = result.candidates[0]

  assert.equal(result.candidateCount, 1)
  assert.deepEqual(candidate.selection.selectedBy, ["compression"])
  assert.deepEqual(candidate.selection.activeAxes, ["compression"])
  assert.deepEqual(candidate.selection.triggerSignals, [])
  assert.equal(result.filter.eligibleCoinCountByAxis.social, 0)
})

test("preliminary shortlist deduplicates overlapping reasons", () => {
  const result = buildPreliminaryShortlist([
    createProfile("overlap", {
      features: {
        volatilityCompression: { squeeze_age_hours: 6 },
        social: { social_minus_price_z_3h: 1.2 },
        movementLifecycle: { fresh_quiet_breakout: true },
        divergences: { coiling: true },
      },
    }),
  ])
  const candidate = result.candidates[0]

  assert.equal(result.candidateCount, 1)
  assert.deepEqual(candidate.selection.selectedBy, [
    "divergences",
    "movementLifecycle",
    "compression",
    "social",
  ])
  assert.deepEqual(candidate.selection.divergenceFlags, ["coiling"])
  assert.deepEqual(candidate.selection.setupSignals, [
    "volatilityCompression",
    "preBreakoutCompression",
  ])
  assert.deepEqual(candidate.selection.triggerSignals, [
    "freshBreakout",
    "socialAttention",
  ])
})

test("preliminary shortlist nominates a fresh quiet breakout as setup and trigger", () => {
  const result = buildPreliminaryShortlist([
    createProfile("fresh", {
      features: {
        movementLifecycle: { fresh_quiet_breakout: true },
      },
    }),
  ])
  const candidate = result.candidates[0]

  assert.equal(result.candidateCount, 1)
  assert.equal(result.filter.freshQuietBreakoutNominatedCoinCount, 1)
  assert.deepEqual(candidate.selection.selectedBy, ["movementLifecycle"])
  assert.deepEqual(candidate.selection.activeAxes, [])
  assert.deepEqual(candidate.selection.setupSignals, ["preBreakoutCompression"])
  assert.deepEqual(candidate.selection.triggerSignals, ["freshBreakout"])
})

test("preliminary shortlist excludes late pumps and dumps before nomination", () => {
  const result = buildPreliminaryShortlist([
    createProfile("eligible", {
      features: { volatilityCompression: { squeeze_age_hours: 4 } },
    }),
    createProfile("late-pump", {
      features: {
        volatilityCompression: { squeeze_age_hours: 24 },
        volumeOrderFlow: {
          volume_acceleration_3h: 1,
          rel_volume_at_time: 4,
        },
        movementLifecycle: { late_pump: true },
        divergences: { coiling: true },
      },
    }),
    createProfile("late-dump", {
      features: {
        volatilityCompression: { squeeze_age_hours: 24 },
        movementLifecycle: { late_dump: true },
        divergences: { range_pressure_down: true },
      },
    }),
    createProfile("late-both", {
      features: {
        movementLifecycle: { late_dump: true, late_pump: true },
        divergences: { short_squeeze_setup: true },
      },
    }),
  ])

  assert.deepEqual(
    result.candidates.map(candidate => candidate.coin.baseCurrencyId),
    ["eligible"],
  )
  assert.equal(result.excludedCoinCount, 3)
  assert.equal(result.filter.latePumpExcludedCoinCount, 2)
  assert.equal(result.filter.lateDumpExcludedCoinCount, 2)
  assert.equal(result.filter.divergenceNominatedCoinCount, 0)
  assert.equal(result.filter.eligibleCoinCountByAxis.compression, 1)
  assert.equal(result.filter.eligibleCoinCountByAxis.volumeOrderFlow, 0)
})

test("preliminary shortlist orders role combinations before context", () => {
  const divergence = { divergences: { attention_ahead: true } }
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
    { features: { divergences: { attention_ahead: true } } },
  ))
  const strongProfile = createProfile("zz-strong", {
    features: {
      volatilityCompression: { squeeze_age_hours: 6 },
      volumeOrderFlow: {
        volume_acceleration_3h: 0.5,
        rel_volume_at_time: 2,
      },
      movementLifecycle: { fresh_quiet_breakout: true },
      divergences: { coiling: true },
    },
  })
  const result = buildPreliminaryShortlist([...weakProfiles, strongProfile])

  assert.equal(result.filter.nominatedBeforeLimit, 61)
  assert.equal(result.filter.freshQuietBreakoutNominatedCoinCount, 1)
  assert.equal(result.filter.limitApplied, true)
  assert.equal(result.candidateCount, 60)
  assert.equal(result.candidates[0].coin.baseCurrencyId, "zz-strong")
  assert.ok(candidateById(result, "weak-58"))
  assert.equal(candidateById(result, "weak-59"), undefined)
})

for (const flag of ["range_pressure_up", "range_pressure_down", "short_squeeze_setup", "long_squeeze_setup"]) {
  test(`preliminary shortlist nominates ${flag} without an active axis and still excludes late pumps`, () => {
    const profile = createProfile("candidate", { features: { divergences: { [flag]: true } } })
    const before = structuredClone(profile)
    const result = buildPreliminaryShortlist([
      profile,
      createProfile("late", { features: { movementLifecycle: { late_pump: true }, divergences: { [flag]: true } } }),
    ])
    const candidate = result.candidates[0]

    assert.equal(result.candidateCount, 1)
    assert.equal(result.filter.latePumpExcludedCoinCount, 1)
    assert.deepEqual(candidate.selection.selectedBy, ["divergences"])
    assert.deepEqual(candidate.selection.divergenceFlags, [flag])
    assert.deepEqual(candidate.selection.activeAxes, [])
    assert.deepEqual(candidate.selection.triggerSignals, ["volumeOrderFlow"])
    assert.deepEqual(candidate.selection.setupSignals, flag.endsWith("squeeze_setup") ? ["squeezeFuel"] : [])
    assert.deepEqual(profile, before)
  })
}

test("directional patterns share existing flow and squeeze roles instead of counting duplicate confirmations", () => {
  const result = buildPreliminaryShortlist([
    createProfile("overlap", {
      features: {
        volumeOrderFlow: { volume_acceleration_3h: 0.5, rel_volume_at_time: 2 },
        divergences: { squeeze_fuel: true, range_pressure_up: true, short_squeeze_setup: true },
      },
    }),
  ])

  assert.deepEqual(result.candidates[0].selection.setupSignals, ["squeezeFuel"])
  assert.deepEqual(result.candidates[0].selection.triggerSignals, ["volumeOrderFlow"])
  assert.deepEqual(result.candidates[0].selection.divergenceFlags, [
    "squeeze_fuel", "range_pressure_up", "short_squeeze_setup",
  ])
})

test("unavailable directional patterns neither nominate candidates nor create roles", () => {
  const result = buildPreliminaryShortlist([
    createProfile("unavailable", {
      features: {
        divergences: {
          range_pressure_up: null, range_pressure_down: null, short_squeeze_setup: null, long_squeeze_setup: null,
        },
      },
    }),
  ])

  assert.equal(result.candidateCount, 0)
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
