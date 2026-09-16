import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import {
  getActiveCoverageExclusionIds,
  getPermanentCoverageExclusionIds,
  readCoverageExclusions,
  readPermanentCoverageExclusions,
  selectCoverageExclusions,
  updateCoverageExclusions,
} from "../src/helpers/coverage-exclusions-helper.js"
import { evaluateCoinCoverage } from "../src/steps/step2-data-bootstrap/evaluate-coin-coverage.js"

async function createRegistryPath (context) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "coverage-exclusions-"))
  context.after(() => fs.rm(directory, { recursive: true, force: true }))
  return path.join(directory, "coverage-exclusions.json")
}

function createCoverageFixture ({ fetchHours = 24, volumeDeltaHours = 12 } = {}) {
  const nowTimestamp = Date.parse("2026-08-30T12:37:00Z") / 1_000
  const boundary = Math.floor(nowTimestamp / 3_600) * 3_600
  const coin = {
    baseCurrencyId: "XTVCMARSCOIN",
    symbol: "MARSCOIN",
    name: "Marscoin",
    circulatingSupply: 1,
    marketCap: 1,
    fullyDilutedValuation: 1,
    market: { baseCurrencyId: "XTVCMARSCOIN", tradingViewSymbol: "BINANCE:MARSCOINUSDT.P" },
  }
  const periods = hours => Array.from({ length: hours }, (_, index) => ({
    time: boundary - (hours - index) * 3_600,
    open: 1, max: 1, min: 1, close: 1, volume: 0,
  }))
  const chartData = {
    chart: {
      info: { fullName: coin.market.tradingViewSymbol, baseCurrencyId: coin.baseCurrencyId },
      periods: periods(fetchHours),
    },
    studies: Object.fromEntries([
      "volumeDelta", "openInterest", "fundingRate", "liquidations", "longShortRatioAccounts",
      "topTradersLongShortPositions", "premium", "socialDominance",
    ].map(key => [key, {
      status: "fulfilled",
      value: {
        fields: { close: "Close" },
        periods: periods(key === "volumeDelta" ? volumeDeltaHours : fetchHours).map(({ time }) => ({ time, close: 0 })),
      },
    }])),
  }

  return {
    chartData,
    check: () => ({
      ...coin,
      ...evaluateCoinCoverage(coin, chartData, {
        nowTimestamp, fetchHours, volumeDeltaHours, optionalSocialStudyKeys: ["socialDominance"],
      }),
      confirmedUnavailableMetrics: [],
    }),
  }
}

function createExcludedCoin () {
  return {
    baseCurrencyId: "XTVCMISSING",
    symbol: "MISS",
    name: "Missing Coin",
    unavailableMetrics: ["volumeDelta"],
    reasonCodes: ["volumeDelta:request_failed"],
  }
}

test("permanent coverage exclusions load without an expiration", async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "permanent-coverage-exclusions-"))
  const filePath = path.join(directory, "permanent-coverage-exclusions.json")

  context.after(() => fs.rm(directory, { recursive: true, force: true }))

  await fs.writeFile(filePath, JSON.stringify([
    {
      symbol: "SECOND",
      name: "Second Coin",
      baseCurrencyId: "XTVCSECOND",
    },
    {
      symbol: "FIRST",
      name: "First Coin",
      baseCurrencyId: "XTVCFIRST",
    },
  ]))

  const exclusions = await readPermanentCoverageExclusions({ filePath })

  assert.deepEqual(exclusions.map(exclusion => exclusion.symbol), [
    "FIRST",
    "SECOND",
  ])
  assert.deepEqual(
    [...getPermanentCoverageExclusionIds(exclusions)],
    ["XTVCFIRST", "XTVCSECOND"],
  )
})

test("legacy coverage exclusions load with empty diagnostics", async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "coverage-exclusions-"))
  const filePath = path.join(directory, "coverage-exclusions.json")

  context.after(() => fs.rm(directory, { recursive: true, force: true }))

  await fs.writeFile(filePath, JSON.stringify([{
    symbol: "LEGACY",
    name: "Legacy Coin",
    baseCurrencyId: "XTVCLEGACY",
    recheckAfter: "2026-09-29T12:00:00.000Z",
  }]))

  assert.deepEqual(await readCoverageExclusions({ filePath }), [{
    symbol: "LEGACY",
    name: "Legacy Coin",
    baseCurrencyId: "XTVCLEGACY",
    unavailableMetrics: [],
    reasonCodes: [],
    recheckAfter: "2026-09-29T12:00:00.000Z",
  }])
})

test("social-only coverage exclusions do not block a coin", () => {
  const now = new Date("2026-08-30T12:00:00Z")
  const createExclusion = (baseCurrencyId, unavailableMetrics) => ({
    symbol: baseCurrencyId,
    name: baseCurrencyId,
    baseCurrencyId,
    unavailableMetrics,
    reasonCodes: [],
    recheckAfter: "2026-09-29T12:00:00.000Z",
  })
  const activeIds = getActiveCoverageExclusionIds([
    createExclusion("XTVCSOCIAL", [
      "socialDominance",
      "interactions",
      "activeContributors",
      "createdPosts",
    ]),
    createExclusion("XTVCMIXED", ["socialDominance", "premium"]),
    createExclusion("XTVCCORE", ["premium"]),
    createExclusion("XTVCLEGACY", []),
  ], { now })

  assert.deepEqual([...activeIds], ["XTVCCORE", "XTVCLEGACY", "XTVCMIXED"])
})

test("coverage exclusions persist, expire, and clear after a recheck", async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "coverage-exclusions-"))
  const filePath = path.join(directory, "coverage-exclusions.json")
  const excludedAt = new Date("2026-08-30T12:00:00Z")

  context.after(() => fs.rm(directory, { recursive: true, force: true }))

  const firstUpdate = await updateCoverageExclusions({
    checkedBaseCurrencyIds: ["XTVCMISSING"],
    excludedCoins: [createExcludedCoin()],
    filePath,
    now: excludedAt,
  })
  const persisted = await readCoverageExclusions({ filePath })

  assert.equal(firstUpdate.excludedNowCount, 1)
  assert.equal(firstUpdate.activeCount, 1)
  assert.deepEqual(persisted, [{
    symbol: "MISS",
    name: "Missing Coin",
    baseCurrencyId: "XTVCMISSING",
    unavailableMetrics: ["volumeDelta"],
    reasonCodes: ["volumeDelta:request_failed"],
    recheckAfter: "2026-09-29T12:00:00.000Z",
  }])
  assert.deepEqual(
    [...getActiveCoverageExclusionIds(persisted, { now: excludedAt })],
    ["XTVCMISSING"],
  )
  assert.equal(
    getActiveCoverageExclusionIds(persisted, {
      now: new Date("2026-09-30T12:00:00Z"),
    }).size,
    0,
  )

  await updateCoverageExclusions({
    checkedBaseCurrencyIds: ["XTVCMISSING"],
    excludedCoins: [],
    filePath,
    now: new Date("2026-09-30T12:00:00Z"),
  })

  assert.deepEqual(await readCoverageExclusions({ filePath }), [])
})

test("MARSCOIN-like short history is excluded until its required hours close, then expires and clears", async (context) => {
  const filePath = await createRegistryPath(context)
  const fixture = createCoverageFixture()
  fixture.chartData.chart.periods = fixture.chartData.chart.periods.slice(-10)
  for (const study of Object.values(fixture.chartData.studies)) {
    study.value.periods = study.value.periods.slice(-10)
  }
  const rejected = fixture.check()
  const before = structuredClone(rejected)
  assert.equal(rejected.complete, false)
  assert.deepEqual(rejected.unavailableMetrics, [])
  assert.deepEqual(rejected.confirmedUnavailableMetrics, [])

  const excludedCoins = selectCoverageExclusions([rejected])
  assert.equal(excludedCoins.length, 1)
  assert.deepEqual(excludedCoins[0].unavailableMetrics, [
    "ohlcv", "volumeDelta", "openInterest", "fundingRate", "liquidations",
    "longShortRatioAccounts", "topTradersLongShortPositions", "premium",
  ])
  assert.equal(excludedCoins[0].recheckAfter, "2026-08-31T02:00:00.000Z")
  assert.deepEqual(rejected, before)

  const updated = await updateCoverageExclusions({
    checkedBaseCurrencyIds: [rejected.baseCurrencyId], excludedCoins, filePath,
    now: "2026-08-30T14:25:00Z",
  })
  const persisted = await readCoverageExclusions({ filePath })
  assert.equal(updated.activeCount, 1)
  assert.equal(updated.excludedNowCount, 1)
  assert.deepEqual(persisted, [{
    symbol: rejected.symbol, name: rejected.name, baseCurrencyId: rejected.baseCurrencyId,
    unavailableMetrics: excludedCoins[0].unavailableMetrics,
    reasonCodes: rejected.reasonCodes,
    recheckAfter: "2026-08-31T02:00:00.000Z",
  }])
  assert.deepEqual([...getActiveCoverageExclusionIds(persisted, {
    now: "2026-08-31T01:59:59.999Z",
  })], [rejected.baseCurrencyId])
  assert.equal(getActiveCoverageExclusionIds(persisted, { now: "2026-08-31T02:00:00Z" }).size, 0)

  await updateCoverageExclusions({
    checkedBaseCurrencyIds: [rejected.baseCurrencyId], excludedCoins: [], filePath,
    now: "2026-08-31T02:00:00Z",
  })
  assert.deepEqual(await readCoverageExclusions({ filePath }), [])
})

test("different windows and internal gaps use the latest deadline, without summing missing_hours and missing_values", async (context) => {
  const filePath = await createRegistryPath(context)
  const fixture = createCoverageFixture()
  fixture.chartData.studies.volumeDelta.value.periods.splice(0, 3)
  fixture.chartData.studies.openInterest.value.periods.splice(-3, 1)
  const rejected = fixture.check()
  assert.equal(rejected.coverage.studies.volumeDelta.recheckAfter, "2026-08-30T15:00:00.000Z")
  assert.equal(rejected.coverage.studies.openInterest.recheckAfter, "2026-08-31T10:00:00.000Z")
  assert.deepEqual(rejected.reasonCodes, [
    "volumeDelta:missing_hours", "volumeDelta:missing_values", "openInterest:missing_hours", "openInterest:missing_values",
  ])

  const updated = await updateCoverageExclusions({
    checkedBaseCurrencyIds: [rejected.baseCurrencyId],
    excludedCoins: selectCoverageExclusions([rejected]), filePath, now: "2026-08-30T12:37:00Z",
  })
  assert.deepEqual(updated.registry[0].unavailableMetrics, ["volumeDelta", "openInterest"])
  assert.equal(updated.registry[0].recheckAfter, "2026-08-31T10:00:00.000Z")
})

test("partial missing_values without missing_hours also receive an exact deadline", async (context) => {
  const filePath = await createRegistryPath(context)
  const fixture = createCoverageFixture()
  fixture.chartData.studies.premium.value.periods.at(-1).close = null
  const rejected = fixture.check()
  assert.deepEqual(rejected.reasonCodes, ["premium:missing_values"])

  const updated = await updateCoverageExclusions({
    checkedBaseCurrencyIds: [rejected.baseCurrencyId],
    excludedCoins: selectCoverageExclusions([rejected]), filePath, now: "2026-08-30T12:37:00Z",
  })
  assert.deepEqual(updated.registry[0].unavailableMetrics, ["premium"])
  assert.equal(updated.registry[0].recheckAfter, "2026-08-31T12:00:00.000Z")
})

test("optional Social gaps neither exclude a coin nor extend a required source deadline", () => {
  const fixture = createCoverageFixture()
  fixture.chartData.studies.socialDominance.value.periods.pop()
  const socialOnly = fixture.check()
  assert.equal(socialOnly.coverage.studies.socialDominance.recheckAfter, "2026-08-31T12:00:00.000Z")
  assert.equal(socialOnly.complete, true)
  assert.deepEqual(selectCoverageExclusions([socialOnly]), [])

  fixture.chartData.chart.periods.shift()
  const [exclusion] = selectCoverageExclusions([fixture.check()])
  assert.deepEqual(exclusion.unavailableMetrics, ["ohlcv"])
  assert.equal(exclusion.recheckAfter, "2026-08-30T13:00:00.000Z")
})

for (const failure of ["missing_values", "request_failed"]) {
  test(`fully unavailable ${failure} still requires confirmation and retains the 30-day cooldown`, async (context) => {
    const filePath = await createRegistryPath(context)
    const fixture = createCoverageFixture()
    if (failure === "missing_values") {
      for (const period of fixture.chartData.studies.premium.value.periods) {
        period.close = null
      }
    } else {
      fixture.chartData.studies.premium = { status: "rejected", reason: new Error("Unavailable") }
    }
    const rejected = fixture.check()
    assert.deepEqual(rejected.unavailableMetrics, ["premium"])
    assert.deepEqual(selectCoverageExclusions([rejected]), [])
    rejected.confirmedUnavailableMetrics = ["premium"]

    const updated = await updateCoverageExclusions({
      checkedBaseCurrencyIds: [rejected.baseCurrencyId],
      excludedCoins: selectCoverageExclusions([rejected]), filePath, now: "2026-08-30T12:37:00Z",
    })
    assert.deepEqual(updated.registry[0].unavailableMetrics, ["premium"])
    assert.equal(updated.registry[0].recheckAfter, "2026-09-29T12:37:00.000Z")
  })
}

test("a confirmed unavailable source keeps its cooldown alongside a shorter history delay", async (context) => {
  const filePath = await createRegistryPath(context)
  const fixture = createCoverageFixture()
  fixture.chartData.studies.openInterest.value.periods.shift()
  fixture.chartData.studies.premium = { status: "rejected", reason: new Error("Unavailable") }
  const rejected = fixture.check()
  rejected.confirmedUnavailableMetrics = ["premium"]
  const excludedCoins = selectCoverageExclusions([rejected])
  assert.equal(excludedCoins[0].recheckAfter, "2026-08-30T13:00:00.000Z")

  const updated = await updateCoverageExclusions({
    checkedBaseCurrencyIds: [rejected.baseCurrencyId], excludedCoins, filePath, now: "2026-08-30T12:37:00Z",
  })
  assert.deepEqual(updated.registry[0].unavailableMetrics, ["premium", "openInterest"])
  assert.equal(updated.registry[0].recheckAfter, "2026-09-29T12:37:00.000Z")
})

test("a history delay longer than 30 days is not shortened by an unavailable source cooldown", async (context) => {
  const filePath = await createRegistryPath(context)
  const fixture = createCoverageFixture({ fetchHours: 2_400, volumeDeltaHours: 1_666 })
  fixture.chartData.studies.openInterest.value.periods = fixture.chartData.studies.openInterest.value.periods.slice(-1_000)
  fixture.chartData.studies.premium = { status: "rejected", reason: new Error("Unavailable") }
  const rejected = fixture.check()
  rejected.confirmedUnavailableMetrics = ["premium"]

  const updated = await updateCoverageExclusions({
    checkedBaseCurrencyIds: [rejected.baseCurrencyId],
    excludedCoins: selectCoverageExclusions([rejected]), filePath, now: "2026-08-30T12:37:00Z",
  })
  assert.equal(updated.registry[0].recheckAfter, "2026-10-27T20:00:00.000Z")
})

test("an elapsed history deadline is not postponed to the end of a long bootstrap", async (context) => {
  const filePath = await createRegistryPath(context)
  const fixture = createCoverageFixture()
  fixture.chartData.chart.periods.shift()
  const rejected = fixture.check()

  const updated = await updateCoverageExclusions({
    checkedBaseCurrencyIds: [rejected.baseCurrencyId],
    excludedCoins: selectCoverageExclusions([rejected]), filePath, now: "2026-08-30T14:00:00Z",
  })
  assert.equal(updated.registry[0].recheckAfter, "2026-08-30T13:00:00.000Z")
  assert.equal(updated.activeCount, 0)
})

test("request-wide failures and malformed hourly grids are not treated as predictable history shortages", () => {
  const fixture = createCoverageFixture()
  const rejected = fixture.check()
  assert.deepEqual(selectCoverageExclusions([{
    ...rejected, reasonCodes: ["coverage:request_failed"], coverage: null,
  }]), [])

  fixture.chartData.chart.periods.shift()
  fixture.chartData.chart.periods.push({ ...fixture.chartData.chart.periods[0] })
  const invalid = fixture.check()
  assert.ok(invalid.reasonCodes.includes("ohlcv:missing_hours"))
  assert.equal(invalid.coverage.ohlcv.recheckAfter, null)
  assert.deepEqual(selectCoverageExclusions([invalid]), [])
})

test("updating and clearing one history exclusion preserves unchecked registry entries", async (context) => {
  const filePath = await createRegistryPath(context)
  const other = createExcludedCoin()
  await updateCoverageExclusions({
    checkedBaseCurrencyIds: [other.baseCurrencyId], excludedCoins: [other], filePath, now: "2026-08-30T12:37:00Z",
  })
  const fixture = createCoverageFixture()
  fixture.chartData.chart.periods.shift()
  const rejected = fixture.check()
  const updated = await updateCoverageExclusions({
    checkedBaseCurrencyIds: [rejected.baseCurrencyId],
    excludedCoins: selectCoverageExclusions([rejected]), filePath, now: "2026-08-30T12:37:00Z",
  })
  assert.equal(updated.registry.length, 2)
  const cleared = await updateCoverageExclusions({
    checkedBaseCurrencyIds: [rejected.baseCurrencyId], excludedCoins: [], filePath, now: "2026-08-30T13:00:00Z",
  })
  assert.deepEqual(cleared.registry.map(coin => coin.baseCurrencyId), [other.baseCurrencyId])
  assert.equal(cleared.registry[0].recheckAfter, "2026-09-29T12:37:00.000Z")
})

test("invalid explicit history deadlines are rejected without changing the registry", async (context) => {
  const filePath = await createRegistryPath(context)
  const coin = createExcludedCoin()
  await updateCoverageExclusions({
    checkedBaseCurrencyIds: [coin.baseCurrencyId], excludedCoins: [coin], filePath, now: "2026-08-30T12:37:00Z",
  })
  const before = await fs.readFile(filePath, "utf8")
  await assert.rejects(updateCoverageExclusions({
    checkedBaseCurrencyIds: [coin.baseCurrencyId],
    excludedCoins: [{ ...coin, recheckAfter: "invalid" }], filePath, now: "2026-08-30T12:37:00Z",
  }), /recheckAfter must be a valid timestamp/)
  assert.equal(await fs.readFile(filePath, "utf8"), before)
})
