import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import { isFinite } from "../src/helpers/utils.typed.js"
import { comparePriceCharacters } from "../src/research/compare-price-characters.js"
import { runPriceCharacterScan } from "../src/research/scan-price-characters.js"

function fixture (baseCurrencyId = "XTVCREF", analysisDays = 58) {
  const endTime = 1_800_000_000
  const startTime = endTime - analysisDays * 86400
  function summary (days, end) {
    return {
      days, startTime: end - days * 86400, endTime: end, bars: days * 96,
      medianRangePct: 1, rangeTailRatio: 8, rangeIqrOverMedian: 1, medianAbsReturnPct: 0.5,
      spikeRatePct: 4, spikeEvaluatedBars: days * 96, longWickRatePct: 10,
      efficiency4hMedian: 0.4, efficiency12hMedian: 0.2, top1PctMovementSharePct: 20,
      medianDailyTurnoverUsdt: 1_000_000, zeroReturnRatePct: 0, flatBarRatePct: 0,
    }
  }
  return {
    baseCurrencyId, symbol: baseCurrencyId.slice(4), marketSymbol: `BINANCE:${baseCurrencyId.slice(4)}USDT.P`,
    timeframe: "15m", startTime, endTime,
    coverage: {
      requestedDays: 90, analysisDays, analysisBars: analysisDays * 96, warmupBars: 97,
      totalBars: analysisDays * 96 + 97, intervalSeconds: 900, missingBars: 0,
    },
    windows: [...new Set([7, 30, analysisDays])].map(days => summary(days, endTime)),
    weeks: Array.from({ length: Math.ceil(analysisDays / 7) }, (_, index) => (
      summary(Math.min(7, analysisDays - index * 7), endTime - index * 7 * 86400)
    )).reverse(),
  }
}

function compare (profiles, reference = fixture()) {
  return comparePriceCharacters({
    reference, profiles, coinListGeneratedAt: "2027-01-15T06:00:00.000Z", coinCount: profiles.length + 1,
  })
}

function candidate (result, id) {
  return result.candidates.find(entry => entry.baseCurrencyId === id)
}

function closeTo (actual, expected) {
  assert.ok(isFinite(actual) && Math.abs(actual - expected) < 1e-10, `${actual} != ${expected}`)
}

test("tied midranks precede eligibility gates and all six distance groups have equal weight", () => {
  const reference = fixture()
  const clone = fixture("XTVCCLONE")
  const low = fixture("XTVCLOW")
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
  const result = compare([high, low, clone], reference)
  const entry = candidate(result, "XTVCLOW")

  assert.equal(result.coinListGeneratedAt, "2027-01-15T06:00:00.000Z")
  assert.equal(result.coverage.total, 4)

  // Midranks are 1/8 for low, 1/2 for reference/clone and 7/8 for high, even though high is ineligible.
  for (const group of ["bursts", "pace", "wicks", "path", "amplitude"]) {
    closeTo(entry.componentDistances[group], 37.5)
  }
  closeTo(entry.componentDistances.stability, 18.75)
  closeTo(entry.distance, 34.375)
  Object.values(entry.distanceByWindow).forEach(value => closeTo(value, 37.5))
  closeTo(entry.calmScore, 12.5)
  closeTo(result.reference.calmScore, 50)
  assert.equal(candidate(result, "XTVCCLONE").distance, 0)
  assert.equal(candidate(result, "XTVCHIGH").eligible, false)
  closeTo(candidate(result, "XTVCHIGH").distance, 34.375)
  assert.deepEqual(result.closest, ["XTVCCLONE", "XTVCLOW"])
  assert.deepEqual(result.calmer, ["XTVCLOW"])
})

test("missing historical baselines and matching metrics from a different period cannot imply similarity", () => {
  const incomplete = fixture("XTVCINCOMPLETE")
  incomplete.windows.forEach(window => window.spikeEvaluatedBars = 0)
  const result = compare([incomplete, fixture("XTVCCLONE")])
  const entry = candidate(result, "XTVCINCOMPLETE")

  assert.equal(entry.eligible, false)
  assert.equal(entry.distance, null)
  assert.equal(entry.calmScore, null)
  assert.equal(entry.calmerThanReference, false)
  assert.match(entry.exclusions.join("\n"), /baseline/)
  assert.deepEqual(result.closest, ["XTVCCLONE"])
  assert.deepEqual(result.calmer, [])

  const shifted = fixture("XTVCSHIFT")
  shifted.startTime += 900
  shifted.endTime += 900
  shifted.windows.concat(shifted.weeks).forEach((window) => {
    window.startTime += 900
    window.endTime += 900
  })
  assert.throws(() => compare([shifted]), /одинаковые полные периоды/)
})

function coinListFixture (symbol) {
  return {
    generatedAt: "2027-01-15T06:00:00.000Z",
    coins: ["PROVE", symbol].map((symbol, index) => ({
      baseCurrencyId: `XTVC${symbol}`, symbol, rank: index + 1,
      market: { tradingViewSymbol: `BINANCE:${symbol}USDT.P` },
    })),
  }
}

async function scanDirectory (context) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "price-character-"))
  context.after(() => fs.rm(directory, { recursive: true, force: true }))
  return directory
}

test("resuming migrates the legacy frozen coin list without replacing its coins or cached snapshots", async (context) => {
  const directory = await scanDirectory(context)
  const coinList = coinListFixture("OLD")
  const coinListPath = path.join(directory, "current-coin-list.json")
  const snapshot = {
    source: "tradingview", symbol: "PROVE", marketSymbol: "BINANCE:PROVEUSDT.P", timeframe: "15m",
    endTime: 1_800_000_000, analysisDays: 30,
    periods: Array.from({ length: 30 * 96 + 97 }, (_, index) => ({
      time: 1_800_000_000 - (30 * 96 + 97 - index) * 900,
      open: 100 + index / 100, max: 101 + index / 100, min: 99 + index / 100,
      close: 100.5 + index / 100, volume: 100,
    })),
  }
  await fs.mkdir(path.join(directory, "candles"))
  await Promise.all([
    fs.writeFile(path.join(directory, "reference.json"), JSON.stringify(snapshot)),
    fs.writeFile(path.join(directory, "universe.json"), JSON.stringify(coinList)),
    fs.writeFile(coinListPath, JSON.stringify(coinListFixture("NEW"))),
    fs.writeFile(path.join(directory, "candles", "XTVCOLD.json"), JSON.stringify({
      ...snapshot, symbol: "OLD", marketSymbol: "BINANCE:OLDUSDT.P",
    })),
  ])

  const report = await runPriceCharacterScan({ directory, coinListPath, cached: true })
  assert.equal(report.coinListGeneratedAt, coinList.generatedAt)
  assert.equal(report.coverage.total, 2)
  assert.equal(report.coverage.loaded, 2)
  assert.deepEqual(report.candidates.map(coin => coin.baseCurrencyId), ["XTVCOLD"])
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(directory, "coin-list.json"), "utf8")), coinList)
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(directory, "universe.json"), "utf8")), coinList)
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(directory, "report.json"), "utf8")), JSON.parse(JSON.stringify(report)))

  await Promise.all([fs.rm(path.join(directory, "universe.json")), fs.rm(coinListPath)])
  const resumed = await runPriceCharacterScan({ directory, coinListPath, cached: true })
  assert.equal(resumed.coinListGeneratedAt, coinList.generatedAt)
  assert.deepEqual(resumed.candidates.map(coin => coin.baseCurrencyId), ["XTVCOLD"])
  assert.equal(resumed.coverage.loaded, 2)
})

test("conflicting frozen coin lists stop a resumed scan without overwriting either list", async (context) => {
  const directory = await scanDirectory(context)
  const previous = coinListFixture("OLD")
  const current = coinListFixture("NEW")
  await Promise.all([
    fs.writeFile(path.join(directory, "reference.json"), "{}"),
    fs.writeFile(path.join(directory, "universe.json"), JSON.stringify(previous)),
    fs.writeFile(path.join(directory, "coin-list.json"), JSON.stringify(current)),
  ])

  await assert.rejects(runPriceCharacterScan({ directory, cached: true }), /Conflicting frozen coin lists/)
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(directory, "universe.json"), "utf8")), previous)
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(directory, "coin-list.json"), "utf8")), current)
})
