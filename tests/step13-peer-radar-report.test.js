import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"

import { createBootstrapDataRelativePath } from "../src/steps/step2-data-bootstrap/check-coin-data-coverage.js"
import { readPeerRadarReport } from "../src/steps/step13-report/read-peer-radar-report.js"

function createRadar (empty = false) {
  return {
    schemaVersion: 1,
    asOf: "2026-09-24T06:00:00.000Z",
    snapshotClosedAt: "2026-09-24T07:00:00.000Z",
    generatedAt: "2026-09-24T07:17:00.000Z",
    scanGeneratedAt: "2026-09-24T07:15:00.000Z",
    registryGeneratedAt: "2026-09-22T12:00:00.000Z",
    timeframe: "1h",
    universeCoinCount: 8,
    loadedCoinCount: 5,
    coverage: { available: 1, partial: 1, no_peers: 1, insufficient_data: 1, not_covered: 1, unreviewed: 0, unavailable: 0 },
    criteria: { impulse: "Свежий импульс прямого соседа", lag: "Реакция существенно слабее", reaction: "flat/rising/falling" },
    candidateCount: empty ? 0 : 1,
    observationCount: empty ? 0 : 1,
    watchCount: empty ? 0 : 1,
    analysisStatus: empty ? "skipped_no_candidates" : "complete",
    analysis: { source: "github-copilot-sdk", model: "GPT-6-Astra", reasoningEffort: "high", callCount: empty ? 0 : 1 },
    observations: empty
      ? []
      : [{
          coin: { baseCurrencyId: "OUTSIDE", symbol: "OUTSIDE", name: "Outside shortlist", tradingViewSymbol: "CRYPTO:OUTSIDEUSD", marketSymbol: "BINANCE:OUTSIDEUSDT.P" },
          baseCurrencyId: "OUTSIDE",
          peerStatus: "partial",
          peerCount: 2,
          availablePeerCount: 1,
          benchmarkCoinCount: 3,
          verdict: "watch",
          explanation: "Сосед вырос, реакция кандидата слабее",
          caveats: ["Это наблюдение, не прогноз"],
          leaders: [{
            baseCurrencyId: "LEADER", symbol: "LEADER", type: "competitor",
            basis: "Shared product", caveat: "Different token economics",
            detectedAt: "2026-09-24T05:00:00.000Z", windowStartedAt: "2026-09-24T01:00:00.000Z",
            ageHours: 2, status: "fresh", return4hPct: 7.5, move4hAtr: 3,
            marketExcess4hAtr: 1.5, relativeVolume4h: 2, retainedPct: 90.123456789,
            returnSinceStartPct: 9, moveSinceStartAtr: 3.6,
            coinReturnSinceStartPct: -0.00123456789, coinMoveSinceStartAtr: -0.25,
            responseRatio: -0.25 / 3.6, gapAtr: 3.85, coinReaction: "flat",
          }],
        }],
  }
}

function missing () {
  return Object.assign(new Error("File missing"), { code: "ENOENT" })
}

function reader (radar, scan) {
  return async (filename) => {
    if (filename === "step12-peer-radar-analysis.json") {
      return radar
    }
    assert.equal(filename, "step11-peer-radar.json")
    if (scan === undefined) {
      throw missing()
    }
    return scan
  }
}

function scanFor (radar) {
  return { schemaVersion: 1, asOf: radar.asOf, snapshotClosedAt: radar.snapshotClosedAt, generatedAt: radar.scanGeneratedAt }
}

test("matching peer report is embedded intact, without requiring membership in main candidates", async () => {
  const radar = createRadar()
  const before = structuredClone(radar)
  const result = await readPeerRadarReport(radar.asOf, { readJson: reader(radar, scanFor(radar)) })

  assert.equal(result.status, "available")
  assert.equal(result.warning, null)
  assert.deepEqual(result.data, radar)
  assert.deepEqual(radar, before)
  assert.deepEqual(JSON.parse(JSON.stringify(result)), result)
  assert.equal(result.data.observations[0].leaders[0].coinReturnSinceStartPct, -0.00123456789)
})

test("step 12 is self-contained when the step 11 file is not present", async () => {
  const radar = createRadar()
  assert.equal((await readPeerRadarReport(radar.asOf, { readJson: reader(radar) })).status, "available")
})

test("an explicit empty report is distinct from missing data and preserves coverage", async () => {
  const radar = createRadar(true)
  radar.registryGeneratedAt = null
  radar.coverage = { available: 0, partial: 0, no_peers: 0, insufficient_data: 0, not_covered: 0, unreviewed: 0, unavailable: 5 }
  const result = await readPeerRadarReport(radar.asOf, { readJson: reader(radar) })

  assert.equal(result.status, "available")
  assert.equal(result.data.analysisStatus, "skipped_no_candidates")
  assert.equal(result.data.coverage.unavailable, 5)
  assert.deepEqual(result.data.observations, [])
})

test("missing, malformed and unreadable radar files never block the main report", async () => {
  for (const error of [missing(), new SyntaxError("Invalid JSON"), Object.assign(new Error("Access denied"), { code: "EACCES" })]) {
    const requested = []
    const result = await readPeerRadarReport(createRadar().asOf, {
      readJson: async (filename) => {
        requested.push(filename)
        throw error
      },
    })
    assert.deepEqual(requested, ["step12-peer-radar-analysis.json"])
    assert.equal(result.status, "unavailable")
    assert.equal(result.data, null)
    assert.match(result.warning, /отсутствует|Не удалось/)
  }
})

test("a different market snapshot is never mixed with the main report", async () => {
  const radar = createRadar()
  const result = await readPeerRadarReport("2026-09-24T07:00:00.000Z", { readJson: reader(radar) })
  assert.equal(result.status, "unavailable")
  assert.equal(result.data, null)
  assert.match(result.warning, /другому срезу/)
})

test("a newer scan at the same asOf makes the previous analysis unavailable", async () => {
  const radar = createRadar()
  for (const scan of [
    { ...scanFor(radar), generatedAt: "2026-09-24T07:20:00.000Z" },
    { ...scanFor(radar), asOf: "2026-09-24T07:00:00.000Z" },
    { ...scanFor(radar), schemaVersion: 2 },
    null,
  ]) {
    const result = await readPeerRadarReport(radar.asOf, { readJson: reader(radar, scan) })
    assert.equal(result.status, "unavailable")
    assert.equal(result.data, null)
    assert.match(result.warning, /текущему скану/)
  }
})

test("an unreadable current scan does not silently approve a previous analysis", async () => {
  const radar = createRadar()
  const result = await readPeerRadarReport(radar.asOf, {
    readJson: async (filename) => {
      if (filename === "step12-peer-radar-analysis.json") {
        return radar
      }
      throw new SyntaxError("Broken scan")
    },
  })
  assert.equal(result.status, "unavailable")
  assert.equal(result.data, null)
  assert.match(result.warning, /Broken scan/)
})

for (const [name, change] of [
  ["schema", radar => radar.schemaVersion = 2],
  ["timeframe", radar => radar.timeframe = "4h"],
  ["generated time", radar => radar.generatedAt = "invalid"],
  ["close timestamp", radar => radar.snapshotClosedAt = radar.asOf],
  ["coverage", radar => radar.coverage.partial = null],
  ["coverage total", radar => radar.coverage.available = 10],
  ["counts", radar => radar.watchCount = 0],
  ["observation count", radar => radar.observationCount = 2],
  ["duplicate coin", (radar) => {
    radar.observations.push(radar.observations[0])
    radar.observationCount = 2
    radar.candidateCount = 2
    radar.watchCount = 2
  }],
  ["analysis status", radar => radar.analysisStatus = "skipped_no_candidates"],
  ["analysis metadata", radar => radar.analysis = null],
  ["criteria", radar => radar.criteria = null],
  ["wrong ID", radar => radar.observations[0].baseCurrencyId = "DIFFERENT"],
  ["coin metadata", radar => radar.observations[0].coin = null],
  ["verdict", radar => radar.observations[0].verdict = "buy"],
  ["caveats", radar => radar.observations[0].caveats = "text"],
  ["missing leaders", radar => radar.observations[0].leaders = []],
  ["invalid leader", radar => radar.observations[0].leaders[0] = null],
  ["non-finite metric", radar => radar.observations[0].leaders[0].returnSinceStartPct = NaN],
  ["invalid reaction", radar => radar.observations[0].leaders[0].coinReaction = "buy"],
  ["invalid event time", radar => radar.observations[0].leaders[0].detectedAt = "invalid"],
]) {
  test(`invalid radar ${name} is omitted rather than breaking the browser`, async () => {
    const radar = createRadar()
    change(radar)
    const result = await readPeerRadarReport(radar.asOf, { readJson: reader(radar) })
    assert.equal(result.status, "unavailable")
    assert.equal(result.data, null)
    assert.match(result.warning, /Некорректный формат/)
  })
}

test("step 13 embeds outsider descriptions without changing radar data or main results", { timeout: 40_000 }, async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "peer-radar-html-"))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  await fs.mkdir(path.join(directory, "tmp"))
  await fs.mkdir(path.join(directory, "reports"))
  await fs.mkdir(path.join(directory, "data"))
  const radar = createRadar()
  const registryPath = path.join(directory, "data", "coin-descriptions.json")
  const registry = {
    coins: ["MAIN", "OUTSIDE", "LEADER", "UNUSED"].map(baseCurrencyId => ({
      baseCurrencyId,
      symbol: baseCurrencyId,
      name: `Coin ${baseCurrencyId}`,
      description: `Description ${baseCurrencyId}`,
      sources: [{ url: `https://example.com/${baseCurrencyId}`, checkedAt: "2026-09-24T07:00:00.000Z" }],
    })),
  }
  const writeJson = (filename, value) => fs.writeFile(path.join(directory, "tmp", filename), JSON.stringify(value))
  const sources = {
    asOf: radar.asOf,
    candidateCount: 1,
    candidates: [],
    newsEnrichment: { from: "2026-09-23T07:00:00.000Z", asOf: radar.generatedAt },
    twitterEnrichment: { from: "2026-09-23T07:00:00.000Z", asOf: radar.generatedAt },
  }
  const mainInputs = {
    "step5-preliminary-filter.json": {
      asOf: radar.asOf, timeframe: "1h", candidateCount: 1, universeCoinCount: 8,
      candidates: [{ coin: { baseCurrencyId: "MAIN", symbol: "MAIN", name: "Main coin", marketSymbol: "BINANCE:MAINUSDT.P" } }],
    },
    "step6-agent-payload.json": {
      schemaVersion: 12, asOf: radar.asOf, timeframe: "1h", candidateCount: 1, objective: "Main objective",
      marketContext: {}, marketDefinitions: {}, definitions: {}, flagDefinitions: {}, schema: { volume: ["volumeZ"] },
      candidates: [{ symbol: "MAIN", name: "Main coin", selectionRank: 1, flags: [], volume: [1.5] }],
    },
    "step7-agent-analysis.json": {
      asOf: radar.asOf, candidateCount: 1, topCandidates: [],
      assessments: [{ symbol: "MAIN", movementProbability: 0.6, estimateConfidence: "medium", drivers: ["Main driver"], counterSignals: [] }],
    },
    "step9-twitter-enrichment.json": sources,
    "step10-context-enrichment.json": { ...sources, generatedAt: radar.generatedAt },
  }
  await Promise.all(Object.entries(mainInputs).map(([filename, data]) => writeJson(filename, data)))
  await fs.writeFile(path.join(directory, "reports", "peer-radar-archive.json"), JSON.stringify(radar))
  let files = await fs.readdir(path.join(directory, "reports"))
  const run = async () => {
    await promisify(execFile)(process.execPath, [fileURLToPath(new URL("../src/step13-report.js", import.meta.url))], {
      cwd: directory, timeout: 10_000,
    })
    const current = await fs.readdir(path.join(directory, "reports"))
    const added = current.filter(filename => !files.includes(filename))
    assert.equal(added.length, 1)
    assert.match(added[0], /^report-.*\.html$/)
    files = current
    const html = await fs.readFile(path.join(directory, "reports", added[0]), "utf8")
    assert.match(html, /id="peer-radar"/)
    return JSON.parse(html.match(/<script id="report-data" type="application\/json">([\s\S]*?)<\/script>/)[1])
  }
  const mainOnly = (report) => {
    const { peerRadar, reportCreatedAt, coinDescriptions, ...main } = report
    assert.ok(peerRadar)
    assert.ok(reportCreatedAt)
    assert.ok(coinDescriptions)
    return main
  }

  const baseline = await run()
  assert.equal(baseline.peerRadar.status, "unavailable")
  assert.deepEqual(baseline.peerRadar.histories, {})
  assert.deepEqual(baseline.coins.map(coin => coin.symbol), ["MAIN"])
  assert.equal(baseline.coins[0].baseCurrencyId, "MAIN")
  assert.deepEqual(baseline.coinDescriptions, {})

  await fs.writeFile(registryPath, JSON.stringify(registry))
  const described = await run()
  assert.deepEqual(described.coinDescriptions, {
    MAIN: { description: registry.coins[0].description, sources: registry.coins[0].sources },
  })
  assert.deepEqual(mainOnly(described), mainOnly(baseline))
  assert.deepEqual(described.peerRadar, baseline.peerRadar)

  await writeJson("step12-peer-radar-analysis.json", radar)
  await writeJson("step11-peer-radar.json", scanFor(radar))
  const enriched = await run()
  const { histories, ...radarEnvelope } = enriched.peerRadar
  assert.deepEqual(radarEnvelope, { status: "available", warning: null, data: radar })
  assert.deepEqual(Object.keys(histories).sort(), ["LEADER", "OUTSIDE"])
  for (const history of Object.values(histories)) {
    assert.deepEqual(history.points, [])
    assert.match(history.warning, /недоступна/)
  }
  assert.deepEqual(mainOnly(enriched), mainOnly(baseline))
  assert.deepEqual(enriched.coinDescriptions.MAIN, described.coinDescriptions.MAIN)
  assert.deepEqual(enriched.coinDescriptions.OUTSIDE, {
    description: registry.coins[1].description, sources: registry.coins[1].sources,
  })
  assert.deepEqual(Object.keys(enriched.coinDescriptions).sort(), ["MAIN", "OUTSIDE"])
  assert.equal(enriched.peerRadar.data.observations[0].coin.symbol, "OUTSIDE")
  assert.equal(enriched.coins[0].movementProbability, 0.6)

  for (const coin of [
    radar.observations[0].coin,
    { baseCurrencyId: "LEADER", symbol: "LEADER", marketSymbol: "BYBIT:LEADERUSDT.P" },
  ]) {
    const filename = createBootstrapDataRelativePath(coin)
    await fs.mkdir(path.dirname(path.join(directory, "tmp", filename)), { recursive: true })
    await writeJson(filename, {
      coin, timeframe: "1h",
      chart: {
        info: { fullName: coin.marketSymbol },
        periods: Array.from({ length: 171 }, (_, index) => ({
          time: Date.parse(radar.asOf) / 1_000 - (169 - index) * 3_600,
          close: 100 + index,
        })),
      },
    })
  }
  const charted = await run()
  assert.deepEqual(charted.peerRadar.data, radar)
  assert.deepEqual(mainOnly(charted), mainOnly(baseline))
  assert.deepEqual(charted.coinDescriptions, enriched.coinDescriptions)
  assert.deepEqual(Object.keys(charted.peerRadar.histories).sort(), ["LEADER", "OUTSIDE"])
  assert.equal(charted.peerRadar.histories.LEADER.marketSymbol, "BYBIT:LEADERUSDT.P")
  for (const history of Object.values(charted.peerRadar.histories)) {
    assert.equal(history.warning, null)
    assert.equal(history.points.length, 169)
    assert.deepEqual(history.points[0], { time: Date.parse(radar.snapshotClosedAt) / 1_000 - 168 * 3_600, value: 101 })
    assert.deepEqual(history.points.at(-1), { time: Date.parse(radar.snapshotClosedAt) / 1_000, value: 269 })
  }
  assert.equal(await fs.readFile(path.join(directory, "tmp", "step12-peer-radar-analysis.json"), "utf8"), JSON.stringify(radar))

  await fs.writeFile(registryPath, "{broken JSON")
  const withoutDescriptions = await run()
  assert.deepEqual(withoutDescriptions.coinDescriptions, {})
  assert.deepEqual(mainOnly(withoutDescriptions), mainOnly(charted))
  assert.deepEqual(withoutDescriptions.peerRadar, charted.peerRadar)
  await fs.writeFile(registryPath, JSON.stringify(registry))

  await writeJson(createBootstrapDataRelativePath({ symbol: "LEADER", baseCurrencyId: "LEADER" }), { broken: true })
  const partial = await run()
  assert.equal(partial.peerRadar.status, "available")
  assert.deepEqual(partial.peerRadar.data, radar)
  assert.deepEqual(partial.peerRadar.histories.LEADER.points, [])
  assert.match(partial.peerRadar.histories.LEADER.warning, /некорректный формат/)
  assert.equal(partial.peerRadar.histories.OUTSIDE.warning, null)
  assert.deepEqual(mainOnly(partial), mainOnly(baseline))
  assert.deepEqual(partial.coinDescriptions, enriched.coinDescriptions)

  await writeJson("step12-peer-radar-analysis.json", createRadar(true))
  const empty = await run()
  assert.equal(empty.peerRadar.status, "available")
  assert.deepEqual(empty.peerRadar.data.observations, [])
  assert.deepEqual(empty.peerRadar.histories, {})
  assert.deepEqual(mainOnly(empty), mainOnly(baseline))
  assert.deepEqual(empty.coinDescriptions, described.coinDescriptions)

  await fs.writeFile(path.join(directory, "tmp", "step12-peer-radar-analysis.json"), "{broken JSON")
  const malformed = await run()
  assert.equal(malformed.peerRadar.status, "unavailable")
  assert.equal(malformed.peerRadar.data, null)
  assert.deepEqual(mainOnly(malformed), mainOnly(baseline))
  assert.deepEqual(malformed.coinDescriptions, described.coinDescriptions)

  await writeJson("step12-peer-radar-analysis.json", radar)
  await writeJson("step11-peer-radar.json", { ...scanFor(radar), generatedAt: "2026-09-24T07:30:00.000Z" })
  const stale = await run()
  assert.equal(stale.peerRadar.status, "unavailable")
  assert.deepEqual(stale.peerRadar.histories, {})
  assert.match(stale.peerRadar.warning, /текущему скану/)
  assert.deepEqual(mainOnly(stale), mainOnly(baseline))
  assert.deepEqual(stale.coinDescriptions, described.coinDescriptions)

  const otherSnapshot = { ...radar, asOf: "2026-09-24T05:00:00.000Z", snapshotClosedAt: "2026-09-24T06:00:00.000Z" }
  await writeJson("step12-peer-radar-analysis.json", otherSnapshot)
  const mismatched = await run()
  assert.equal(mismatched.peerRadar.status, "unavailable")
  assert.match(mismatched.peerRadar.warning, /другому срезу/)
  assert.deepEqual(mainOnly(mismatched), mainOnly(baseline))
  assert.deepEqual(mismatched.coinDescriptions, described.coinDescriptions)

  for (const [filename, data] of Object.entries(mainInputs)) {
    assert.equal(await fs.readFile(path.join(directory, "tmp", filename), "utf8"), JSON.stringify(data))
  }
  assert.equal(await fs.readFile(path.join(directory, "reports", "peer-radar-archive.json"), "utf8"), JSON.stringify(radar))
  assert.equal(await fs.readFile(registryPath, "utf8"), JSON.stringify(registry))
})
