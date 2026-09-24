import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"

import { buildPeerRadar } from "../src/steps/step11-peer-radar/build-peer-radar.js"

function createInput (last = 804) {
  const times = Array.from({ length: last + 1 }, (_, index) => (
    Date.parse("2026-08-01T00:00:00.000Z") / 1_000 + index * 3_600
  ))
  const coins = ["TARGET", "LEADER", "MARKET1", "MARKET2", "MARKET3"].map((id, index) => ({
    baseCurrencyId: id,
    symbol: id,
    name: id,
    rank: index + 1,
    categories: [],
    tradingViewSymbol: `CRYPTO:${id}USD`,
    market: { tradingViewSymbol: `BINANCE:${id}USDT.P` },
  }))
  const input = {
    sourceUniverse: { generatedAt: new Date((times.at(-1) + 3_600) * 1_000).toISOString(), coins },
    coinData: coins.map(coin => ({
      coin: { baseCurrencyId: coin.baseCurrencyId, marketSymbol: coin.market.tradingViewSymbol },
      chart: { periods: times.map(time => ({ time, close: 100, max: 101, min: 99, volume: 100 })) },
    })),
    coinPeers: {
      schemaVersion: 1,
      generatedAt: "2026-07-31T00:00:00.000Z",
      universe: { coins: coins.map(({ baseCurrencyId }) => ({ baseCurrencyId, reviewStatus: "reviewed" })) },
      relations: [{ coinIds: ["TARGET", "LEADER"], type: "competitor", basis: "Shared product", caveat: "Different token economics" }],
    },
  }
  setReaction(input, "LEADER", 106)
  return input
}

function setReaction (input, id, close) {
  for (const period of input.coinData.find(data => data.coin.baseCurrencyId === id).chart.periods.slice(800)) {
    Object.assign(period, { close, max: close + 1, min: close - 1, volume: 100 })
  }
  const first = input.coinData.find(data => data.coin.baseCurrencyId === id).chart.periods[800]
  if (first && id === "LEADER") {
    first.volume = 600
  }
}

function assertClose (actual, expected) {
  assert.ok(Math.abs(actual - expected) < 1e-10, `${actual} != ${expected}`)
}

function firstLeader (input) {
  return buildPeerRadar(input).candidates.find(candidate => candidate.coin.baseCurrencyId === "TARGET")?.leaders[0]
}

test("radar reuses peer impulses from OHLCV alone without main features or selection", () => {
  const input = createInput()
  setReaction(input, "TARGET", 101)
  input.coinData[0].studies = { fundingRate: { periods: [] } }
  input.coinData[0].features = { movementLifecycle: { late_pump: true }, social: null }
  input.shortlist = { candidates: [] }
  const before = structuredClone(input)
  const scan = buildPeerRadar(input)
  const [candidate] = scan.candidates
  const [leader] = candidate.leaders

  assert.equal(scan.schemaVersion, 1)
  assert.equal(scan.timeframe, "1h")
  assert.equal(scan.loadedCoinCount, 5)
  assert.equal(scan.universeCoinCount, 5)
  assert.equal(scan.candidateCount, 1)
  assert.equal(Date.parse(scan.snapshotClosedAt) - Date.parse(scan.asOf), 3_600_000)
  assert.deepEqual(scan.coverage, {
    available: 2, partial: 0, no_peers: 3, insufficient_data: 0, not_covered: 0, unreviewed: 0, unavailable: 0,
  })
  assert.equal(candidate.coin.baseCurrencyId, "TARGET")
  assert.equal(candidate.peerStatus, "available")
  assert.equal(leader.symbol, "LEADER")
  assert.equal(leader.coinReaction, "flat")
  assertClose(leader.return4hPct, 6)
  assertClose(leader.returnSinceStartPct, 6)
  assertClose(leader.moveSinceStartAtr, 3)
  assertClose(leader.coinReturnSinceStartPct, 1)
  assertClose(leader.coinMoveSinceStartAtr, 0.5)
  assertClose(leader.gapAtr, 2.5)
  assertClose(leader.responseRatio, 1 / 6)
  assert.equal(leader.retainedPct, 100)
  assert.equal(Date.parse(leader.detectedAt) + leader.ageHours * 3_600_000, Date.parse(scan.snapshotClosedAt))
  assert.doesNotMatch(JSON.stringify(scan), /"features"|"fundingRate"|"shortlist"|"rank"|"social"/)
  assert.deepEqual(input, before)
  assert.deepEqual(JSON.parse(JSON.stringify(scan)), scan)
})

test("substantially weaker means at most half the current normalized reaction and at least one ATR gap", () => {
  for (const [reaction, expected] of [[103, true], [103.0001, false], [104, false], [108, false], [99, true]]) {
    const input = createInput(800)
    setReaction(input, "TARGET", reaction)
    assert.equal(Boolean(firstLeader(input)), expected, `candidate close ${reaction}`)
  }

  const exactGap = createInput(801)
  Object.assign(exactGap.coinData[1].chart.periods.at(-1), { close: 104, max: 105, min: 103 })
  setReaction(exactGap, "TARGET", 102)
  assertClose(firstLeader(exactGap).gapAtr, 1)
  assertClose(firstLeader(exactGap).responseRatio, 0.5)

  Object.assign(exactGap.coinData[1].chart.periods.at(-1), { close: 103.9, max: 104.9, min: 102.9 })
  setReaction(exactGap, "TARGET", 101.95)
  assert.equal(firstLeader(exactGap), undefined)
})

test("lag comparison uses the leader current response, not its frozen trigger", () => {
  const extended = createInput(801)
  Object.assign(extended.coinData[1].chart.periods.at(-1), { close: 108, max: 109, min: 107 })
  setReaction(extended, "TARGET", 103.5)
  const leader = firstLeader(extended)
  assertClose(leader.move4hAtr, 3)
  assertClose(leader.moveSinceStartAtr, 4)
  assertClose(leader.coinMoveSinceStartAtr, 1.75)
  assertClose(leader.responseRatio, 0.4375)

  const retraced = createInput(801)
  Object.assign(retraced.coinData[1].chart.periods.at(-1), { close: 104, max: 105, min: 103 })
  setReaction(retraced, "TARGET", 102.2)
  assert.equal(firstLeader(retraced), undefined)
})

test("flat, rising and falling describe the candidate in its own original ATR", () => {
  for (const [price, reaction] of [[101, "flat"], [99, "flat"], [101.01, "rising"], [98.99, "falling"]]) {
    const input = createInput(800)
    setReaction(input, "TARGET", price)
    input.coinData[0].chart.periods.at(-1).max = 200
    assert.equal(firstLeader(input).coinReaction, reaction)
    assertClose(firstLeader(input).coinMoveSinceStartAtr, (price - 100) / 2)
  }
})

test("fresh and fading observations are separate and expired or collapsed episodes are absent", () => {
  for (const [last, status] of [[804, "fresh"], [805, "fading"], [812, "fading"], [813, undefined]]) {
    const leader = firstLeader(createInput(last))
    assert.equal(leader?.status, status)
    if (leader) {
      assert.equal(leader.ageHours, last - 800)
    }
  }
  const collapsed = createInput(801)
  Object.assign(collapsed.coinData[1].chart.periods.at(-1), { close: 102, max: 103, min: 101 })
  assert.equal(firstLeader(collapsed), undefined)
})

test("missing candidate reaction is not a flat reaction", () => {
  for (const field of ["close", "max"]) {
    const input = createInput(800)
    input.coinData[0].chart.periods[790][field] = null
    assert.equal(firstLeader(input), undefined)
  }
})

test("partial, unknown and absent registry coverage remain explicit", () => {
  const input = createInput()
  input.coinPeers.universe.coins.push({ baseCurrencyId: "ABSENT", reviewStatus: "reviewed" })
  input.coinPeers.relations.push({ ...input.coinPeers.relations[0], coinIds: ["TARGET", "ABSENT"] })
  const partial = buildPeerRadar(input)
  assert.equal(partial.candidates[0].peerStatus, "partial")
  assert.equal(partial.candidates[0].peerCount, 2)
  assert.equal(partial.candidates[0].availablePeerCount, 1)

  input.coinPeers.universe.coins = input.coinPeers.universe.coins.filter(coin => coin.baseCurrencyId !== "MARKET1")
  input.coinPeers.universe.coins.find(coin => coin.baseCurrencyId === "MARKET2").reviewStatus = "not_reviewed"
  const unknown = buildPeerRadar(input)
  assert.equal(unknown.coverage.not_covered, 1)
  assert.equal(unknown.coverage.unreviewed, 1)
  assert.equal(unknown.coverage.partial, 1)

  input.coinPeers = null
  const absent = buildPeerRadar(input)
  assert.equal(absent.registryGeneratedAt, null)
  assert.equal(absent.coverage.unavailable, 5)
  assert.equal(absent.candidateCount, 0)
  assert.deepEqual(absent.candidates, [])
})

test("a registry with no observed impulses does not invent candidates", () => {
  const input = createInput()
  setReaction(input, "LEADER", 100)
  assert.equal(buildPeerRadar(input).candidateCount, 0)
  assert.equal(buildPeerRadar(input).coverage.available, 2)
})

test("several direct leaders share one candidate row and indirect leaders are not added", () => {
  const input = createInput()
  const extra = structuredClone(input.coinData[1])
  extra.coin = { baseCurrencyId: "LEADER2", marketSymbol: "BINANCE:LEADER2USDT.P" }
  input.coinData.push(extra)
  input.sourceUniverse.coins.push({ ...input.sourceUniverse.coins[1], baseCurrencyId: "LEADER2", symbol: "LEADER2", market: { tradingViewSymbol: extra.coin.marketSymbol } })
  input.coinPeers.universe.coins.push({ baseCurrencyId: "LEADER2", reviewStatus: "reviewed" })
  input.coinPeers.relations.push({ ...input.coinPeers.relations[0], coinIds: ["TARGET", "LEADER2"] })
  assert.equal(buildPeerRadar(input).candidates[0].leaders.length, 2)

  input.coinPeers.relations.at(-1).coinIds = ["LEADER", "LEADER2"]
  assert.deepEqual(buildPeerRadar(input).candidates.find(candidate => candidate.coin.symbol === "TARGET").leaders.map(leader => leader.symbol), ["LEADER"])
})

test("candidate ordering is deterministic and not a main-agent ranking", () => {
  const input = createInput()
  input.coinPeers.relations.push({ ...input.coinPeers.relations[0], coinIds: ["MARKET1", "LEADER"] })
  const first = buildPeerRadar(input)
  input.coinData.reverse()
  input.sourceUniverse.coins.forEach((coin) => {
    coin.rank = 100 - coin.rank
  })
  const second = buildPeerRadar(input)
  assert.deepEqual(first.candidates.map(candidate => candidate.coin.symbol), ["MARKET1", "TARGET"])
  assert.deepEqual(first.candidates, second.candidates)
})

test("radar rejects inconsistent grids, duplicated IDs, markets and missing inputs", () => {
  for (const mutate of [
    (input) => {
      input.coinData = []
    },
    (input) => {
      input.sourceUniverse = null
    },
    (input) => {
      input.coinData.push(input.coinData[0])
    },
    (input) => {
      input.coinData[0].chart.periods.pop()
    },
    (input) => {
      input.coinData[0].chart.periods[10].time += 1
    },
    (input) => {
      input.coinData[0].coin.marketSymbol = "BINANCE:WRONGUSDT.P"
    },
  ]) {
    const input = createInput()
    mutate(input)
    assert.throws(() => buildPeerRadar(input), /requires|universe|grid|market/)
  }
})

test("CLI 11 → 12 works with only steps 1–2 and the registry, leaving main outputs untouched", { timeout: 30_000 }, async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "peer-radar-pipeline-"))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  const input = createInput()
  const writeJson = async (filename, data) => {
    const filePath = path.join(directory, filename)
    await fs.mkdir(path.dirname(filePath), { recursive: true })
    await fs.writeFile(filePath, JSON.stringify(data))
  }
  const readJson = async filename => JSON.parse(await fs.readFile(path.join(directory, filename), "utf8"))
  await Promise.all([
    ["tmp/step1-crypto-universe.json", input.sourceUniverse],
    ["tmp/step2-data-bootstrap.json", { coinCount: input.coinData.length }],
    ["data/coin-peers.json", input.coinPeers],
    ["tmp/step7-agent-analysis.json", { untouched: true, topCandidates: [] }],
    ...input.coinData.map(data => [`tmp/step2-data-bootstrap/${data.coin.baseCurrencyId}/data.json`, data]),
  ].map(([filename, data]) => writeJson(filename, data)))
  await fs.mkdir(path.join(directory, "reports"))
  await fs.writeFile(path.join(directory, "reports", "main.html"), "Unchanged main report")
  const run = promisify(execFile)
  await run(process.execPath, [fileURLToPath(new URL("../src/step11-peer-radar.js", import.meta.url))], { cwd: directory, timeout: 10_000 })
  const scan = await readJson("tmp/step11-peer-radar.json")
  assert.deepEqual(scan.candidates, buildPeerRadar(input).candidates)
  await run(process.execPath, ["--input-type=module", "--eval", `
    import { runPeerRadarAnalysisStep } from ${JSON.stringify(new URL("../src/step12-peer-radar-analysis.js", import.meta.url).href)}
    await runPeerRadarAnalysisStep({ callAgent: async (prompt, message) => {
      const input = JSON.parse(message)
      return JSON.stringify({ schemaVersion: 1, asOf: input.asOf, observations: input.candidates.map(candidate => ({
        baseCurrencyId: candidate.coin.baseCurrencyId, verdict: "watch", explanation: "Прямой сосед вырос при слабой реакции кандидата", caveats: ["Это наблюдение, не прогноз"]
      })) })
    } })
  `], { cwd: directory, timeout: 10_000 })
  const report = await readJson("tmp/step12-peer-radar-analysis.json")
  assert.equal(report.observationCount, 1)
  assert.equal(report.watchCount, 1)
  assert.deepEqual(report.observations[0].leaders, scan.candidates[0].leaders)
  assert.deepEqual(await readJson("tmp/step7-agent-analysis.json"), { untouched: true, topCandidates: [] })
  assert.equal(await fs.readFile(path.join(directory, "reports", "main.html"), "utf8"), "Unchanged main report")
  const jsonReports = (await fs.readdir(path.join(directory, "reports"))).filter(filename => filename.endsWith(".json"))
  assert.equal(jsonReports.length, 1)
  assert.match(jsonReports[0], /^peer-radar-.*_GMT\+3\.json$/)
  assert.deepEqual(await readJson(`reports/${jsonReports[0]}`), report)

  await fs.rm(path.join(directory, "data", "coin-peers.json"))
  await run(process.execPath, [fileURLToPath(new URL("../src/step11-peer-radar.js", import.meta.url))], { cwd: directory, timeout: 10_000 })
  await run(process.execPath, [fileURLToPath(new URL("../src/step12-peer-radar-analysis.js", import.meta.url))], { cwd: directory, timeout: 10_000 })
  const empty = await readJson("tmp/step12-peer-radar-analysis.json")
  assert.equal(empty.analysisStatus, "skipped_no_candidates")
  assert.equal(empty.analysis.callCount, 0)
  assert.equal(empty.coverage.unavailable, 5)
  assert.deepEqual(empty.observations, [])

  await writeJson("tmp/step2-data-bootstrap.json", { coinCount: 6 })
  await assert.rejects(run(process.execPath, [fileURLToPath(new URL("../src/step11-peer-radar.js", import.meta.url))], { cwd: directory, timeout: 10_000 }), /declares 6 coins/)
})
