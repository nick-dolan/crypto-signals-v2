import assert from "node:assert/strict"
import test from "node:test"

import { isArray, isFinite, isNaN, isObject } from "../src/helpers/utils.typed.js"
import { comparePriceCharacters } from "../src/research/compare-price-characters.js"
import { buildPriceCharacterReport } from "../src/research/price-character.js"

function fixture (baseCurrencyId = "XTVCREF", analysisDays = 58) {
  const endTime = 1_800_000_000
  const startTime = endTime - analysisDays * 86400
  function summary (days, end) {
    return {
      label: `${days} дней`, days, startTime: end - days * 86400, endTime: end, bars: days * 96,
      netReturnPct: 12, medianRangePct: 1, p99RangePct: 8, maxRangePct: 12, rangeTailRatio: 8,
      rangeIqrOverMedian: 1, medianAbsReturnPct: 0.5, p99AbsReturnPct: 4,
      spikeCount: Math.round(days * 96 * 0.04), spikeRatePct: 4, spikeEvaluatedBars: days * 96,
      rangeOver3PctRatePct: 6, returnOver3PctRatePct: 2, longWickRatePct: 10,
      efficiency4hMedian: 0.4, efficiency12hMedian: 0.2, top1PctMovementSharePct: 20,
      medianDailyTurnoverUsdt: 1_000_000, zeroReturnRatePct: 0, flatBarRatePct: 0,
    }
  }
  return {
    schemaVersion: 1, generatedAt: "2027-01-15T08:00:00.000Z", collectedAt: "2027-01-15T07:00:00.000Z",
    source: "tradingview", baseCurrencyId, symbol: baseCurrencyId.slice(4), name: `Coin ${baseCurrencyId}`,
    marketSymbol: `BINANCE:${baseCurrencyId.slice(4)}USDT.P`, rank: 42, timeframe: "15m", startTime, endTime,
    coverage: {
      requestedDays: 90, analysisDays, analysisBars: analysisDays * 96, warmupBars: 97,
      totalBars: analysisDays * 96 + 97, intervalSeconds: 900, missingBars: 0,
    },
    warnings: analysisDays < 90 ? [`Получено ${analysisDays} дней вместо 90.`] : [],
    methodology: ["Исходные полные метрики."],
    windows: [...new Set([7, 30, analysisDays])].map(days => summary(days, endTime)),
    weeks: Array.from({ length: Math.ceil(analysisDays / 7) }, (_, index) => (
      summary(Math.min(7, analysisDays - index * 7), endTime - index * 7 * 86400)
    )).reverse(),
    spikes: [{ time: endTime - 900, rangePct: 8, rangeMultiple: 8 }],
  }
}

function month (profile) {
  return profile.windows.find(window => window.days === 30)
}

function calmerProfile (id, analysisDays = 58) {
  const profile = fixture(id, analysisDays)
  profile.windows.forEach(window => Object.assign(window, { spikeRatePct: 2, rangeTailRatio: 4, top1PctMovementSharePct: 10 }))
  profile.weeks.forEach(week => Object.assign(week, { spikeRatePct: 2 }))
  return profile
}

function compare (profiles, reference = fixture(), options = {}) {
  return comparePriceCharacters({
    reference, profiles, universeGeneratedAt: "2027-01-15T06:00:00.000Z", universeCount: profiles.length + 1, ...options,
  })
}

function candidate (result, id) {
  return result.candidates.find(entry => entry.baseCurrencyId === id)
}

function closeTo (actual, expected) {
  assert.ok(isFinite(actual) && Math.abs(actual - expected) < 1e-10, `${actual} != ${expected}`)
}

function assertUnscored (entry) {
  assert.equal(entry.eligible, false)
  assert.ok(entry.exclusions.length > 0)
  assert.equal(entry.distance, null)
  assert.equal(entry.calmScore, null)
  assert.ok(Object.values(entry.componentDistances).every(value => value === null))
  assert.ok(Object.values(entry.distanceByWindow).every(value => value === null))
  assert.equal(entry.calmerThanReference, false)
}

function freeze (value) {
  if (isArray(value) || isObject(value)) {
    Object.values(value).forEach(freeze)
    Object.freeze(value)
  }
  return value
}

test("exact clone has zero distance, preserves the full profile and follows the output contract", () => {
  const reference = fixture()
  const clone = { ...structuredClone(reference), baseCurrencyId: "XTVCCLONE", name: "Clone", rank: 7 }
  const result = compare([clone], reference)
  const entry = result.candidates[0]
  assert.equal(result.schemaVersion, 1)
  assert.ok(isFinite(Date.parse(result.generatedAt)))
  assert.equal(result.universeGeneratedAt, "2027-01-15T06:00:00.000Z")
  assert.equal(result.timeframe, "15m")
  assert.equal(result.analysisDays, 58)
  assert.equal(result.startTime, reference.startTime)
  assert.equal(result.endTime, reference.endTime)
  assert.deepEqual(result.coverage, { total: 2, loaded: 2, failed: 0, pending: 0, eligible: 1 })
  assert.equal(result.reference.profile, reference)
  assert.equal(result.reference.distance, 0)
  assert.equal(result.reference.calmerThanReference, false)
  assert.equal(entry.profile, clone)
  for (const key of ["baseCurrencyId", "symbol", "name", "marketSymbol", "rank"]) {
    assert.equal(entry[key], clone[key])
  }
  assert.equal(entry.eligible, true)
  assert.deepEqual(entry.exclusions, [])
  assert.equal(entry.distance, 0)
  assert.deepEqual(entry.distanceByWindow, { 7: 0, 30: 0, 58: 0 })
  assert.deepEqual(entry.componentDistances, { bursts: 0, pace: 0, wicks: 0, path: 0, amplitude: 0, stability: 0 })
  assert.equal(entry.calmScore, 50)
  assert.equal(entry.weeklySpikeP90Pct, 4)
  assert.equal(entry.weeklyRangeVariation, 0)
  assert.equal(entry.amplitudeRatio30d, 1)
  assert.equal(entry.turnoverRatio30d, 1)
  assert.deepEqual(result.closest, ["XTVCCLONE"])
  assert.deepEqual(result.calmer, [])
  assert.deepEqual(result.rejected, [])
  assert.deepEqual(result.pending, [])
  assert.ok(result.methodology.every(text => text.length > 0))
  assert.match(result.methodology.join("\n"), /less \+ equal\/2/)
})

test("midranks use the complete cohort before gates; all six groups have equal weight", () => {
  const reference = fixture()
  const low = calmerProfile("XTVCLOW")
  const high = fixture("XTVCHIGH")
  for (const [profile, factor] of [[low, 0.5], [high, 2]]) {
    profile.windows.forEach((window) => {
      for (const metric of ["rangeIqrOverMedian", "longWickRatePct", "efficiency4hMedian", "efficiency12hMedian", "medianAbsReturnPct"]) {
        window[metric] *= factor
      }
      Object.assign(window, {
        spikeRatePct: 4 * factor, rangeTailRatio: 8 * factor, top1PctMovementSharePct: 20 * factor,
        medianRangePct: factor === 0.5 ? 0.8 : 3,
      })
    })
    profile.weeks.forEach(week => Object.assign(week, { spikeRatePct: 4 * factor, medianRangePct: factor }))
  }
  const result = compare([high, low], reference)
  const entry = candidate(result, "XTVCLOW")
  for (const group of ["bursts", "pace", "wicks", "path", "amplitude"]) {
    closeTo(entry.componentDistances[group], 100 / 3)
  }
  closeTo(entry.componentDistances.stability, 50 / 3)
  closeTo(entry.distance, 275 / 9)
  Object.values(entry.distanceByWindow).forEach(value => closeTo(value, 100 / 3))
  closeTo(entry.calmScore, 100 / 6)
  closeTo(result.reference.calmScore, 50)
  assert.equal(candidate(result, "XTVCHIGH").eligible, false)
  assert.ok(isFinite(candidate(result, "XTVCHIGH").distance))
  assert.deepEqual(result.closest, ["XTVCLOW"])
  assert.deepEqual(result.calmer, ["XTVCLOW"])

  const invalid = calmerProfile("XTVCINVALID")
  invalid.windows[0].efficiency4hMedian = undefined
  const withInvalid = compare([invalid, high, low], reference)
  assert.deepEqual(candidate(withInvalid, "XTVCLOW"), entry)
  assert.deepEqual(candidate(withInvalid, "XTVCHIGH"), candidate(result, "XTVCHIGH"))
  assertUnscored(candidate(withInvalid, "XTVCINVALID"))
})

test("scalar rescaling and irrelevant return/direction data do not affect the ranking", () => {
  const reference = fixture()
  const profiles = [calmerProfile("XTVCLOW"), fixture("XTVCOTHER")]
  profiles[1].windows.forEach(window => Object.assign(window, { medianRangePct: 1.5, rangeIqrOverMedian: 3 }))
  const original = compare(profiles, reference)
  const changed = structuredClone([reference, ...profiles])
  changed.forEach((profile, index) => {
    profile.windows.forEach((window) => {
      window.medianRangePct *= 0.0001
      window.medianAbsReturnPct *= 100
      window.rangeIqrOverMedian *= 10
      window.medianDailyTurnoverUsdt *= 1000
      window.netReturnPct = index % 2 ? -999 : 100_000
      window.maxRangePct = null
      window.p99AbsReturnPct = undefined
    })
    profile.weeks.forEach(week => week.medianRangePct *= 0.0001)
  })
  const scaled = compare(changed.slice(1), changed[0])
  assert.deepEqual(scaled.closest, original.closest)
  assert.deepEqual(scaled.calmer, original.calmer)
  original.candidates.forEach((entry) => {
    const other = candidate(scaled, entry.baseCurrencyId)
    closeTo(other.distance, entry.distance)
    closeTo(other.calmScore, entry.calmScore)
    assert.deepEqual(other.componentDistances, entry.componentDistances)
    assert.equal(other.eligible, entry.eligible)
  })
})

test("30d amplitude, turnover and inactivity gates are inclusive and distinct from metric completeness", () => {
  const profiles = [
    ["XTVCLOW", { medianRangePct: 0.49 }, "medianRangePct"],
    ["XTVCHIGH", { medianRangePct: 2.01 }, "medianRangePct"],
    ["XTVCTURNOVER", { medianDailyTurnoverUsdt: 499_999 }, "medianDailyTurnoverUsdt"],
    ["XTVCZERO", { zeroReturnRatePct: 20.01 }, "zeroReturnRatePct"],
    ["XTVCFLAT", { flatBarRatePct: 1.01 }, "flatBarRatePct"],
    ["XTVCLOWBOUND", { medianRangePct: 0.5, medianDailyTurnoverUsdt: 500_000, zeroReturnRatePct: 20, flatBarRatePct: 1 }, null],
    ["XTVCHIGHBOUND", { medianRangePct: 2 }, null],
  ].map(([id, values, exclusion]) => {
    const profile = fixture(id)
    Object.assign(month(profile), values)
    return { profile, exclusion }
  })
  const result = compare(profiles.map(item => item.profile))
  profiles.forEach(({ profile, exclusion }) => {
    const entry = candidate(result, profile.baseCurrencyId)
    assert.equal(entry.eligible, exclusion === null)
    assert.ok(isFinite(entry.distance) && isFinite(entry.calmScore))
    if (exclusion) {
      assert.ok(entry.exclusions.some(reason => reason.includes(exclusion)))
      assert.ok(!result.closest.includes(profile.baseCurrencyId))
    } else {
      assert.deepEqual(entry.exclusions, [])
    }
  })
  closeTo(candidate(result, "XTVCLOW").amplitudeRatio30d, 0.49)
  closeTo(candidate(result, "XTVCTURNOVER").turnoverRatio30d, 0.499999)
  assert.equal(result.coverage.eligible, 2)
  assert.deepEqual(result.calmer, [])
})

test("missing, nonfinite and invalid comparison metrics never become zero or false calm", () => {
  const profiles = [undefined, null, NaN, Infinity, -Infinity, "0", false, -1].map((value, index) => {
    const profile = calmerProfile(`XTVCINVALID${index}`)
    profile.windows[index % 3].efficiency12hMedian = value
    return profile
  })
  const result = compare(profiles)
  result.candidates.forEach((entry) => {
    assertUnscored(entry)
    assert.match(entry.exclusions.join("\n"), /efficiency12hMedian/)
  })
  assert.deepEqual(result.closest, [])
  assert.deepEqual(result.calmer, [])
  assert.equal(result.coverage.eligible, 0)
  assert.equal(result.coverage.failed, 0)
})

test("undefined gate metrics, incomplete baselines and zero normalizers are explicitly excluded", () => {
  for (const [label, change, reason] of [
    ["turnover", profile => month(profile).medianDailyTurnoverUsdt = undefined, /medianDailyTurnoverUsdt/],
    ["zero rate", profile => month(profile).zeroReturnRatePct = NaN, /zeroReturnRatePct/],
    ["flat rate", profile => month(profile).flatBarRatePct = Infinity, /flatBarRatePct/],
    ["7d baseline", profile => profile.windows[0].spikeEvaluatedBars--, /baseline/],
    ["full baseline", profile => profile.windows.at(-1).spikeEvaluatedBars--, /baseline/],
    ["weekly baseline", profile => profile.weeks.at(-1).spikeEvaluatedBars--, /baseline/],
    ["range normalizer", profile => profile.windows[0].medianRangePct = 0, /нормировщик/],
    ["weekly normalizer", profile => profile.weeks.forEach(week => week.medianRangePct = 0), /недельной вариации/],
    ["weekly spike", profile => profile.weeks.at(-1).spikeRatePct = NaN, /spikeRatePct/],
    ["weekly range", profile => profile.weeks.at(-1).medianRangePct = undefined, /medianRangePct/],
  ]) {
    const profile = calmerProfile(`XTVC${label}`)
    change(profile)
    const result = compare([profile])
    assertUnscored(result.candidates[0])
    assert.match(result.candidates[0].exclusions.join("\n"), reason, label)
    assert.deepEqual(result.calmer, [])
  }
})

test("real buildPriceCharacterReport output works; an actually flat series is not a calm candidate", () => {
  function build (flat) {
    let price = 100
    return buildPriceCharacterReport({
      source: "tradingview", symbol: flat ? "FLAT" : "REF", marketSymbol: flat ? "BINANCE:FLATUSDT.P" : "BINANCE:REFUSDT.P",
      timeframe: "15m", analysisDays: 58, requestedDays: 90, endTime: 1_800_000_000,
      collectedAt: "2027-01-15T07:00:00.000Z",
      periods: Array.from({ length: 58 * 96 + 97 }, (_, index) => {
        const open = price
        price *= Math.exp(flat ? 0 : index % 3 ? 0.001 : -0.002)
        return {
          time: 1_800_000_000 - (58 * 96 + 97 - index) * 900,
          open, close: price, max: Math.max(open, price), min: Math.min(open, price), volume: 100,
        }
      }),
    })
  }
  const reference = { ...build(false), baseCurrencyId: "XTVCREF", name: "Reference", rank: 1 }
  const clone = { ...structuredClone(reference), baseCurrencyId: "XTVCCLONE" }
  const flat = { ...build(true), baseCurrencyId: "XTVCFLAT", name: "Flat", rank: 2 }
  const result = compare([flat, clone], reference)
  assert.equal(candidate(result, "XTVCCLONE").distance, 0)
  assert.equal(candidate(result, "XTVCCLONE").eligible, true)
  const entry = candidate(result, "XTVCFLAT")
  assertUnscored(entry)
  assert.equal(entry.profile.windows[0].spikeRatePct, null)
  assert.equal(entry.weeklySpikeP90Pct, null)
  assert.equal(entry.weeklyRangeVariation, null)
  assert.match(entry.exclusions.join("\n"), /baseline/)
  assert.deepEqual(result.closest, ["XTVCCLONE"])
  assert.deepEqual(result.calmer, [])
})

test("invalid reference metrics and reference turnover normalizer disable comparisons, not substitute zeros", () => {
  for (const change of [
    reference => reference.windows[0].rangeTailRatio = null,
    reference => month(reference).medianDailyTurnoverUsdt = 0,
  ]) {
    const reference = fixture()
    change(reference)
    const result = compare([calmerProfile("XTVCLOW")], reference)
    assert.equal(result.reference.eligible, false)
    assert.equal(result.reference.distance, 0)
    assert.equal(result.reference.calmScore, null)
    assertUnscored(result.candidates[0])
    assert.match(result.candidates[0].exclusions.join("\n"), /эталона/)
    assert.deepEqual(result.closest, [])
    assert.deepEqual(result.calmer, [])
    assert.match(result.warnings.join("\n"), /Эталон.*ранжирование недоступно/)
  }
})

test("temporal mismatches, incomplete coverage, duplicate windows and broken week partitions reject the call", () => {
  for (const [label, change] of [
    ["timeframe", profile => profile.timeframe = "1h"],
    ["shifted start", profile => profile.startTime += 900],
    ["shifted end", profile => profile.endTime += 900],
    ["different days", profile => profile.coverage.analysisDays = 57],
    ["missing bars", profile => profile.coverage.missingBars = 1],
    ["analysis bars", profile => profile.coverage.analysisBars--],
    ["warmup", profile => profile.coverage.warmupBars = 96],
    ["total bars", profile => profile.coverage.totalBars--],
    ["interval", profile => profile.coverage.intervalSeconds = 3600],
    ["missing window", profile => profile.windows.pop()],
    ["duplicate window", profile => profile.windows[1] = profile.windows[0]],
    ["window start", profile => profile.windows[0].startTime += 900],
    ["window end", profile => profile.windows[0].endTime -= 900],
    ["window bars", profile => profile.windows[0].bars--],
    ["missing week", profile => profile.weeks.pop()],
    ["duplicate week", profile => profile.weeks[1] = profile.weeks[2]],
    ["week start", profile => profile.weeks[1].startTime += 900],
    ["partial week", profile => profile.weeks[0].days = 7],
  ]) {
    const profile = fixture("XTVCBAD")
    change(profile)
    assert.throws(() => compare([profile]), /15m|окна|недели/, label)
  }
  const shifted = fixture("XTVCSHIFT")
  shifted.startTime += 900
  shifted.endTime += 900
  shifted.windows.concat(shifted.weeks).forEach((window) => {
    window.startTime += 900
    window.endTime += 900
  })
  assert.throws(() => compare([shifted]), /одинаковые/)
})

test("the minimum is 30 full days and coincident 30d/full windows are counted only once", () => {
  const reference = fixture("XTVCREF", 30)
  const profile = fixture("XTVCLOW", 30)
  Object.assign(month(profile), { spikeRatePct: 2, rangeTailRatio: 4, top1PctMovementSharePct: 10 })
  const result = compare([profile], reference)
  const entry = result.candidates[0]
  assert.deepEqual(Object.keys(entry.distanceByWindow), ["7", "30"])
  closeTo(entry.componentDistances.bursts, 25)
  closeTo(entry.distance, 25 / 6)
  assert.deepEqual(entry.distanceByWindow, { 7: 0, 30: 10 })
  closeTo(entry.calmScore, 100 * (0.5 + 0.25 + 0.5) / 3)
  assert.equal(entry.calmerThanReference, true)
  profile.windows.push(structuredClone(month(profile)))
  assert.throws(() => compare([profile], reference), /окна/)
  for (const days of [29, 91, 30.5]) {
    assert.throws(() => compare([], fixture("XTVCREF", days)), /30–90/)
  }
  reference.endTime++
  assert.throws(() => compare([], reference), /startTime\/endTime/)
})

test("weekly quantiles use complete 7d weeks with linear interpolation; partial metrics are ignored", () => {
  const profile = calmerProfile("XTVCWEEKLY")
  profile.weeks.filter(week => week.days === 7).forEach((week, index) => {
    week.spikeRatePct = index + 1
    week.medianRangePct = index + 1
  })
  Object.assign(profile.weeks[0], { spikeRatePct: 100, medianRangePct: 1000 })
  const result = compare([profile])
  closeTo(result.candidates[0].weeklySpikeP90Pct, 7.3)
  closeTo(result.candidates[0].weeklyRangeVariation, 7 / 9)
  assert.equal(result.candidates[0].eligible, true)
  assert.equal(result.candidates[0].calmerThanReference, false)
  const changed = structuredClone(profile)
  Object.assign(changed.weeks[0], { spikeRatePct: undefined, medianRangePct: NaN, spikeEvaluatedBars: 0 })
  const after = compare([changed]).candidates[0]
  assert.equal(after.eligible, true)
  assert.equal(after.weeklySpikeP90Pct, result.candidates[0].weeklySpikeP90Pct)
  assert.equal(after.weeklyRangeVariation, result.candidates[0].weeklyRangeVariation)
  assert.equal(after.distance, result.candidates[0].distance)
  assert.equal(after.calmScore, result.candidates[0].calmScore)
  assert.ok(isNaN(after.profile.weeks[0].medianRangePct))
})

test("eligibility is separate from calmer qualification; each raw condition is required and 7d may be worse", () => {
  const good = calmerProfile("XTVCGOOD")
  Object.assign(good.windows[0], { spikeRatePct: 40, rangeTailRatio: 40, top1PctMovementSharePct: 60 })
  const profiles = [good, fixture("XTVCCLONE")]
  for (const [id, change] of [
    ["XTVCSPIKE", profile => month(profile).spikeRatePct = 4],
    ["XTVCTAIL", profile => month(profile).rangeTailRatio = 8],
    ["XTVCSHARE", profile => month(profile).top1PctMovementSharePct = 20],
    ["XTVCFULL", profile => profile.windows.at(-1).spikeRatePct = 5],
    ["XTVCWEEK", profile => profile.weeks.forEach(week => week.spikeRatePct = 5)],
    ["XTVCINELIGIBLE", profile => month(profile).medianDailyTurnoverUsdt = 1],
  ]) {
    const profile = calmerProfile(id)
    change(profile)
    profiles.push(profile)
  }
  const result = compare(profiles)
  assert.equal(candidate(result, "XTVCGOOD").calmerThanReference, true)
  result.candidates.filter(entry => entry.baseCurrencyId !== "XTVCGOOD").forEach((entry) => {
    assert.equal(entry.calmerThanReference, false, entry.baseCurrencyId)
    assert.equal(entry.eligible, entry.baseCurrencyId !== "XTVCINELIGIBLE")
  })
  assert.deepEqual(result.calmer, ["XTVCGOOD"])
  assert.equal(result.closest[0], "XTVCCLONE")
  assert.ok(!result.closest.includes("XTVCINELIGIBLE"))

  const equalWeeklyAndFull = calmerProfile("XTVCEQUAL")
  equalWeeklyAndFull.windows.at(-1).spikeRatePct = 4
  equalWeeklyAndFull.weeks.forEach(week => week.spikeRatePct = 4)
  assert.equal(compare([equalWeeklyAndFull]).candidates[0].calmerThanReference, true)
})

test("ties are deterministic by ID, null scores come last, and list sizes are capped without fillers", () => {
  const profiles = Array.from({ length: 12 }, (_, index) => ({
    ...calmerProfile(`XTVC${String(index + 1).padStart(2, "0")}`), rank: 100 - index,
  }))
  const invalid = ["XTVCNULLZ", "XTVCNULLA"].map((id) => {
    const profile = fixture(id)
    month(profile).rangeTailRatio = null
    return profile
  })
  const first = compare([...invalid, ...profiles].reverse())
  const second = compare([...profiles, ...invalid])
  assert.deepEqual({ ...first, generatedAt: null }, { ...second, generatedAt: null })
  assert.deepEqual(first.closest, profiles.slice(0, 10).map(profile => profile.baseCurrencyId))
  assert.deepEqual(first.calmer, profiles.slice(0, 5).map(profile => profile.baseCurrencyId))
  assert.deepEqual(first.candidates.slice(-2).map(entry => entry.baseCurrencyId), ["XTVCNULLA", "XTVCNULLZ"])
  assert.ok(!first.closest.includes(first.reference.baseCurrencyId))
  assert.ok(!first.calmer.includes(first.reference.baseCurrencyId))
  assert.deepEqual(compare([fixture("XTVCONLY")]).calmer, [])
  const alone = compare([])
  assert.equal(alone.reference.distance, 0)
  assert.equal(alone.reference.calmScore, 50)
  assert.deepEqual(alone.closest, [])
  assert.deepEqual(alone.calmer, [])
  assert.equal(alone.coverage.eligible, 0)
})

test("duplicate IDs reject across loaded, rejected and pending coins", () => {
  const reference = fixture()
  const profile = fixture("XTVCCOIN")
  for (const [profiles, options] of [
    [[reference], {}],
    [[profile, structuredClone(profile)], {}],
    [[profile], { pending: [{ baseCurrencyId: profile.baseCurrencyId }] }],
    [[], { pending: [{ baseCurrencyId: reference.baseCurrencyId }] }],
    [[], { rejected: [{ coin: { baseCurrencyId: "XTVCBAD" }, reason: "Нет истории" }], pending: [{ baseCurrencyId: "XTVCBAD" }] }],
  ]) {
    assert.throws(() => compare(profiles, reference, { universeCount: 10, ...options }), /Дубликаты baseCurrencyId/)
  }
  assert.throws(() => compare([{ ...profile, baseCurrencyId: "" }]), /непустой baseCurrencyId/)
  assert.throws(() => compare([profile], reference, { universeCount: 1 }), /universeCount/)
  assert.throws(() => compare([profile], reference, { universeCount: 2.5 }), /universeCount/)
  assert.throws(() => comparePriceCharacters({ reference, profiles: null, universeCount: 1 }), /массивами/)
})

test("coverage and Russian warnings distinguish pending ranks, failed coins and inherited source limits", () => {
  const rejected = [{ coin: { baseCurrencyId: "XTVCFAILED", symbol: "FAILED", name: "Failed", marketSymbol: "BINANCE:FAILEDUSDT.P", rank: 3 }, reason: "Недостаточно истории" }]
  const pending = [{ baseCurrencyId: "XTVCPENDING", symbol: "PENDING", name: "Pending", marketSymbol: "BINANCE:PENDINGUSDT.P", rank: 4 }]
  const reference = fixture()
  reference.warnings.push("Особое ограничение источника.")
  const result = compare([fixture("XTVCCOIN")], reference, { rejected, pending, universeCount: 4 })
  assert.deepEqual(result.coverage, { total: 4, loaded: 2, failed: 1, pending: 1, eligible: 1 })
  assert.equal(result.rejected, rejected)
  assert.equal(result.pending, pending)
  assert.equal(result.candidates.length, 1)
  assert.ok(result.warnings.includes("Особое ограничение источника."))
  assert.match(result.warnings.join("\n"), /58 дней из запрошенных 90/)
  assert.match(result.warnings.join("\n"), /Неполное покрытие.*2 из 4/)
  assert.match(result.warnings.join("\n"), /Ожидают.*ранги предварительные/)
  assert.match(result.warnings.join("\n"), /Не загружено.*не сравнивались/)
  const unaccounted = compare([], fixture("XTVCREF", 90), { universeCount: 250 })
  assert.match(unaccounted.warnings.join("\n"), /249 монет нет профиля или статуса/)
  assert.deepEqual(compare([], fixture("XTVCREF", 90)).warnings, [])
})

test("frozen inputs, noncanonical window order and full profile data are preserved without mutation", () => {
  const reference = fixture()
  const profile = calmerProfile("XTVCCOIN")
  profile.windows.reverse()
  profile.weeks.reverse()
  const input = freeze({
    reference, profiles: [profile], universeGeneratedAt: "2027-01-15T06:00:00.000Z", universeCount: 4,
    rejected: [{ coin: { baseCurrencyId: "XTVCFAILED", symbol: "FAILED", name: "Failed", marketSymbol: "BINANCE:FAILEDUSDT.P", rank: 3 }, reason: "Нет истории" }],
    pending: [{ baseCurrencyId: "XTVCPENDING", symbol: "PENDING", name: "Pending", marketSymbol: "BINANCE:PENDINGUSDT.P", rank: 4 }],
  })
  const before = structuredClone(input)
  const result = comparePriceCharacters(input)
  assert.deepEqual(input, before)
  assert.deepEqual(result.reference.profile, before.reference)
  assert.deepEqual(result.candidates[0].profile, before.profiles[0])
  assert.equal(result.candidates[0].eligible, true)
  assert.deepEqual(result.calmer, ["XTVCCOIN"])
  assert.deepEqual(Object.keys(result.candidates[0].distanceByWindow), ["7", "30", "58"])
})
