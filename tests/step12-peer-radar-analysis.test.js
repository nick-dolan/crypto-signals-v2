import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { promisify } from "node:util"

import modelsInUse from "../models-in-use.json" with { type: "json" }
import { getModelSettings } from "../src/helpers/model-helper.js"
import { isArray, isFinite, isObject } from "../src/helpers/utils.typed.js"
import { analyzePeerRadar } from "../src/steps/step12-peer-radar-analysis/analyze-peer-radar.js"
import {
  InvalidPeerRadarAnalysisError,
  parsePeerRadarAnalysis,
} from "../src/steps/step12-peer-radar-analysis/parse-peer-radar-analysis.js"

function createScan (count = 2) {
  return {
    schemaVersion: 1,
    generatedAt: "2026-09-24T09:03:04.123Z",
    asOf: "2026-09-24T08:00:00.000Z",
    snapshotClosedAt: "2026-09-24T09:00:00.000Z",
    timeframe: "1h",
    registryGeneratedAt: null,
    universeCoinCount: count + 20,
    loadedCoinCount: count + 6,
    coverage: {
      available: Math.ceil(count / 2),
      partial: Math.floor(count / 2),
      no_peers: 1,
      insufficient_data: 1,
      not_covered: 1,
      unreviewed: 1,
      unavailable: 2,
    },
    criteria: {
      impulse: "Frozen peer impulse, retained at least half.",
      lag: "Signed responseRatio <= 0.5 and gapAtr >= 1 from the same start.",
      reaction: "Use flat/rising/falling from the scan, not a new filter.",
    },
    candidateCount: count,
    candidates: Array.from({ length: count }, (_, index) => ({
      coin: {
        baseCurrencyId: `coin-${index}`,
        symbol: `COIN${index}`,
        name: `Монета ${index}`,
        tradingViewSymbol: `CRYPTO:COIN${index}USD`,
        marketSymbol: `BINANCE:COIN${index}USDT`,
      },
      peerStatus: index % 2 ? "partial" : "available",
      peerCount: index % 2 ? 3 : 2,
      availablePeerCount: 2,
      benchmarkCoinCount: 10,
      leaders: Array.from({ length: 2 }, (_, leaderIndex) => {
        const candidateMove = [0.5, 1.25, -0.75][(index + leaderIndex) % 3]
        return {
          baseCurrencyId: `leader-${leaderIndex}`,
          symbol: `LEADER${leaderIndex}`,
          type: leaderIndex ? "adjacent" : "competitor",
          basis: "Прямая связь: общий сценарий использования, не транзитивный кластер.",
          caveat: "Различаются спрос и токеномика; \"общая тема\" не обещает догоняющего роста.\nНужна ручная проверка.",
          detectedAt: leaderIndex ? "2026-09-24T00:00:00.000Z" : "2026-09-24T05:00:00.000Z",
          windowStartedAt: leaderIndex ? "2026-09-23T20:00:00.000Z" : "2026-09-24T01:00:00.000Z",
          ageHours: leaderIndex ? 9 : 4,
          status: leaderIndex ? "fading" : "fresh",
          return4hPct: 5.123456789012345,
          move4hAtr: 4.125,
          marketExcess4hAtr: 2.375,
          relativeVolume4h: 2.625,
          retainedPct: 75.75757575757575,
          returnSinceStartPct: 3.912345678901234,
          moveSinceStartAtr: 3.125,
          coinReturnSinceStartPct: candidateMove * 0.2,
          coinMoveSinceStartAtr: candidateMove,
          responseRatio: candidateMove / 3.125,
          gapAtr: 3.125 - candidateMove,
          coinReaction: ["flat", "rising", "falling"][(index + leaderIndex) % 3],
        }
      }),
    })),
  }
}

function createResponse (scan) {
  return {
    schemaVersion: 1,
    asOf: scan.asOf,
    observations: scan.candidates.map((candidate, index) => ({
      baseCurrencyId: candidate.coin.baseCurrencyId,
      verdict: index % 2 ? "limited" : "watch",
      explanation: "Прямые соседи выросли сильнее; реакцию кандидата стоит оценить вручную.",
      caveats: ["Отставание само по себе не отличает слабость от подготовки."],
    })),
  }
}

function freezeFacts (value) {
  if (isArray(value) || isObject(value)) {
    Object.values(value).forEach(freezeFacts)
    Object.freeze(value)
  }
  return value
}

async function prepareStepDirectory (context, scan) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "step12-peer-radar-analysis-"))
  context.after(() => fs.rm(directory, { recursive: true, force: true }))
  await fs.mkdir(path.join(directory, "tmp"))
  await fs.writeFile(path.join(directory, "tmp", "step11-peer-radar.json"), JSON.stringify(scan))
  return directory
}

function runInjectedStep (directory, body) {
  return promisify(execFile)(process.execPath, ["--input-type=module", "--eval", `
    import assert from "node:assert/strict"
    import { runPeerRadarAnalysisStep } from ${JSON.stringify(new URL("../src/step12-peer-radar-analysis.js", import.meta.url).href)}
    ${body}
  `], { cwd: directory, timeout: 10_000 })
}

test("empty peer scan skips the agent and retains complete coverage metadata", async () => {
  const settings = getModelSettings("peerRadarAnalysis")
  const scan = createScan(0)
  const report = await analyzePeerRadar(scan, "Peer-only prompt", {
    callAgent: async () => assert.fail("An empty peer scan must not call an agent"),
  })

  assert.equal(report.analysisStatus, "skipped_no_candidates")
  assert.equal(report.candidateCount, 0)
  assert.equal(report.observationCount, 0)
  assert.equal(report.watchCount, 0)
  assert.deepEqual(report.observations, [])
  assert.deepEqual(report.coverage, scan.coverage)
  assert.deepEqual(report.criteria, scan.criteria)
  assert.equal(report.loadedCoinCount, scan.loadedCoinCount)
  assert.equal(report.universeCoinCount, scan.universeCoinCount)
  assert.equal(report.registryGeneratedAt, null)
  assert.equal(report.scanGeneratedAt, scan.generatedAt)
  assert.equal(report.asOf, scan.asOf)
  assert.equal(report.snapshotClosedAt, scan.snapshotClosedAt)
  assert.equal(report.timeframe, "1h")
  assert.deepEqual(report.analysis, {
    source: "openai-unofficial",
    model: settings.model,
    reasoningEffort: settings.reasoningEffort,
    callCount: 0,
  })
  assert.ok(isFinite(Date.parse(report.generatedAt)))
  assert.equal(Object.hasOwn(report, "candidates"), false)
})

test("one registry-selected call receives only whitelisted peer facts and no tools", async () => {
  const settings = getModelSettings("peerRadarAnalysis")
  const expected = createScan()
  expected.registryGeneratedAt = "2026-09-23T07:00:00.000Z"
  const scan = structuredClone(expected)
  Object.assign(scan, {
    features: { volume: "OUTSIDE_SCOPE" },
    rank: 1,
    assessment: { movementProbability: 0.99 },
    news: ["OUTSIDE_SCOPE"],
    mainPrompt: "OUTSIDE_SCOPE",
  })
  scan.coverage.extra = { features: "OUTSIDE_SCOPE" }
  scan.criteria.extra = "OUTSIDE_SCOPE"
  for (const candidate of scan.candidates) {
    Object.assign(candidate, {
      features: { volume: "OUTSIDE_SCOPE" },
      selectionRank: 1,
      assessment: "OUTSIDE_SCOPE",
      news: ["OUTSIDE_SCOPE"],
      volume: 123,
      OI: 456,
      funding: 0.1,
      setup: "OUTSIDE_SCOPE",
    })
    candidate.coin.extra = "OUTSIDE_SCOPE"
    candidate.leaders.forEach((leader) => {
      leader.extra = { news: "OUTSIDE_SCOPE" }
    })
  }
  const calls = []
  const response = createResponse(expected)
  const report = await analyzePeerRadar(scan, "Peer-only prompt", {
    callAgent: async (prompt, message, options) => {
      calls.push({ prompt, payload: JSON.parse(message), options })
      assert.doesNotMatch(message, /OUTSIDE_SCOPE/)
      return JSON.stringify(response)
    },
  })

  assert.equal(calls.length, 1)
  assert.equal(calls[0].prompt, "Peer-only prompt")
  assert.deepEqual(calls[0].options, settings)
  assert.equal(Object.hasOwn(calls[0].options, "tools"), false)
  const payload = calls[0].payload
  assert.deepEqual(Object.keys(payload), ["schemaVersion", "asOf", "timeframe", "schema", "candidates"])
  assert.equal(payload.schemaVersion, 2)
  assert.equal(payload.asOf, expected.asOf)
  assert.equal(payload.timeframe, "1h")
  assert.deepEqual(payload.schema, {
    coin: ["baseCurrencyId", "symbol", "name"],
    coverage: ["peerStatus", "peerCount", "availablePeerCount", "benchmarkCoinCount"],
    leader: [
      "symbol", "type", "basis", "caveat", "ageHours", "status", "move4hAtr",
      "marketExcess4hAtr", "relativeVolume4h", "retainedPct", "returnSinceStartPct",
      "moveSinceStartAtr", "coinReturnSinceStartPct", "coinMoveSinceStartAtr", "coinReaction",
    ],
  })
  assert.deepEqual(payload.candidates.map(candidate => candidate.coin), [
    ["coin-0", "COIN0", "Монета 0"],
    ["coin-1", "COIN1", "Монета 1"],
  ])
  assert.deepEqual(payload.candidates.map(candidate => candidate.coverage), [
    ["available", 2, 2, 10], ["partial", 3, 2, 10],
  ])
  assert.deepEqual(payload.candidates[0].leaders[0], [
    "LEADER0", "competitor", expected.candidates[0].leaders[0].basis, expected.candidates[0].leaders[0].caveat,
    4, "fresh", 4.125, 2.375, 2.625, 75.758, 3.912, 3.125, 0.1, 0.5, "flat",
  ])
  assert.deepEqual(payload.candidates[0].leaders[1], [
    "LEADER1", "adjacent", expected.candidates[0].leaders[1].basis, expected.candidates[0].leaders[1].caveat,
    9, "fading", 4.125, 2.375, 2.625, 75.758, 3.912, 3.125, 0.25, 1.25, "rising",
  ])
  for (const candidate of payload.candidates) {
    assert.deepEqual(Object.keys(candidate), ["coin", "coverage", "leaders"])
    assert.equal(candidate.leaders.length, 2)
    assert.ok(candidate.leaders.every(leader => isArray(leader) && leader.length === payload.schema.leader.length))
  }
  const serialized = JSON.stringify(payload)
  for (const omitted of [
    "generatedAt", "snapshotClosedAt", "registryGeneratedAt", "criteria", "candidateCount",
    "universeCoinCount", "loadedCoinCount", "tradingViewSymbol", "marketSymbol", "detectedAt",
    "windowStartedAt", "return4hPct", "responseRatio", "gapAtr",
  ]) {
    assert.equal(serialized.includes(`"${omitted}"`), false, omitted)
  }
  assert.doesNotMatch(serialized, /CRYPTO:|BINANCE:|leader-0|leader-1/)
  assert.deepEqual(report, {
    schemaVersion: expected.schemaVersion,
    asOf: expected.asOf,
    snapshotClosedAt: expected.snapshotClosedAt,
    timeframe: expected.timeframe,
    registryGeneratedAt: expected.registryGeneratedAt,
    universeCoinCount: expected.universeCoinCount,
    loadedCoinCount: expected.loadedCoinCount,
    coverage: expected.coverage,
    criteria: expected.criteria,
    candidateCount: expected.candidateCount,
    scanGeneratedAt: expected.generatedAt,
    generatedAt: report.generatedAt,
    analysisStatus: "complete",
    analysis: {
      source: "openai-unofficial",
      model: settings.model,
      reasoningEffort: settings.reasoningEffort,
      callCount: 1,
    },
    observationCount: expected.candidateCount,
    watchCount: 1,
    observations: expected.candidates.map((candidate, index) => ({
      ...candidate,
      ...response.observations[index],
    })),
  })
})

for (const [provider, source] of [
  ["copilot-sdk", "github-copilot-sdk"],
  ["copilot-unofficial", "github-copilot-unofficial"],
  ["openai-unofficial", "openai-unofficial"],
]) {
  test(`peer radar follows ${provider} registry edits with reasoning disabled`, async (t) => {
    const original = modelsInUse.peerRadarAnalysis
    t.after(() => {
      modelsInUse.peerRadarAnalysis = original
    })
    modelsInUse.peerRadarAnalysis = {
      ...original,
      provider,
      model: "configured-peer-model",
      reasoningEffort: null,
    }
    const settings = getModelSettings("peerRadarAnalysis")
    const scan = createScan(1)
    const callAgent = t.mock.fn(async () => JSON.stringify(createResponse(scan)))
    const report = await analyzePeerRadar(scan, "Peer-only prompt", { callAgent })

    assert.equal(callAgent.mock.callCount(), 1)
    assert.deepEqual(callAgent.mock.calls[0].arguments[2], settings)
    assert.equal(report.analysisStatus, "complete")
    assert.deepEqual(report.analysis, {
      source,
      model: settings.model,
      reasoningEffort: settings.reasoningEffort,
      callCount: 1,
    })
  })
}

test("all candidates are analyzed once with watch first and stable scan order within verdicts", async () => {
  const scan = createScan(8)
  const response = createResponse(scan)
  let calls = 0
  const report = await analyzePeerRadar(scan, "Peer-only prompt", {
    callAgent: async () => {
      calls += 1
      return JSON.stringify({ ...response, observations: [...response.observations].reverse() })
    },
  })

  assert.equal(calls, 1)
  assert.equal(report.observationCount, 8)
  assert.equal(report.watchCount, 4)
  assert.deepEqual(report.observations, [0, 2, 4, 6, 1, 3, 5, 7].map(index => ({
    ...scan.candidates[index],
    ...response.observations[index],
  })))
})

for (const verdict of ["watch", "limited"]) {
  test(`all candidates may be ${verdict} without a quota or forced watch`, async () => {
    const scan = createScan(7)
    const response = createResponse(scan)
    response.observations.forEach((observation) => {
      observation.verdict = verdict
    })
    const report = await analyzePeerRadar(scan, "Peer-only prompt", {
      callAgent: async () => JSON.stringify({ ...response, observations: [...response.observations].reverse() }),
    })

    assert.equal(report.analysisStatus, "complete")
    assert.equal(report.observationCount, 7)
    assert.equal(report.watchCount, verdict === "watch" ? 7 : 0)
    assert.deepEqual(report.observations.map(observation => observation.baseCurrencyId),
      scan.candidates.map(candidate => candidate.coin.baseCurrencyId))
  })
}

test("exact source facts survive JSON, remain detached and are never recomputed by the agent", async () => {
  const scan = freezeFacts(JSON.parse(JSON.stringify(createScan(3))))
  const before = JSON.stringify(scan)
  const response = createResponse(scan)
  const report = await analyzePeerRadar(scan, "Peer-only prompt", {
    callAgent: async (_, message) => {
      const received = JSON.parse(message)
      assert.equal(received.schemaVersion, 2)
      assert.equal(received.candidates[0].leaders[0][received.schema.leader.indexOf("retainedPct")], 75.758)
      received.candidates[0].coverage[received.schema.coverage.indexOf("availablePeerCount")] = 999
      received.candidates[0].coin[received.schema.coin.indexOf("name")] = "Agent cannot replace facts"
      received.candidates[0].leaders[0][received.schema.leader.indexOf("moveSinceStartAtr")] = 999
      received.candidates[0].leaders[0][received.schema.leader.indexOf("status")] = "fading"
      return JSON.stringify(response)
    },
  })
  const saved = JSON.parse(JSON.stringify(report))

  assert.equal(JSON.stringify(scan), before)
  assert.deepEqual(saved.coverage, scan.coverage)
  assert.deepEqual(saved.observations, [0, 2, 1].map(index => ({
    ...scan.candidates[index],
    ...response.observations[index],
  })))
  assert.notEqual(report.coverage, scan.coverage)
  assert.notEqual(report.criteria, scan.criteria)
  assert.notEqual(report.observations[0].coin, scan.candidates[0].coin)
  assert.notEqual(report.observations[0].leaders, scan.candidates[0].leaders)
  assert.notEqual(report.observations[0].leaders[0], scan.candidates[0].leaders[0])
  assert.equal(report.observations[0].leaders[0].status, "fresh")
  assert.equal(report.observations[0].leaders[0].coinReaction, "flat")
  assert.equal(report.observations[0].leaders[1].coinReaction, "rising")
  assert.equal(report.observations.find(observation => observation.baseCurrencyId === "coin-1").leaders[1].responseRatio, -0.24)

  report.observations[0].leaders[0].gapAtr = 0
  report.observations[0].coin.name = "Report edit"
  report.coverage.available = 0
  report.criteria.lag = "Report edit"
  assert.equal(JSON.stringify(scan), before)
})

test("rounded peer values preserve authoritative boundary states and full report precision", async () => {
  const scan = createScan(1)
  Object.assign(scan.candidates[0].leaders[0], {
    ageHours: 4.000001,
    status: "fading",
    retainedPct: 50.000001,
    coinReturnSinceStartPct: -0.000001,
    coinMoveSinceStartAtr: 0.500001,
    coinReaction: "rising",
  })
  Object.assign(scan.candidates[0].leaders[1], {
    coinMoveSinceStartAtr: -0.500001,
    coinReaction: "falling",
  })
  const before = structuredClone(scan)
  const report = await analyzePeerRadar(scan, "Peer-only prompt", {
    callAgent: async (_, message) => {
      const payload = JSON.parse(message)
      const [first, second] = payload.candidates[0].leaders
        .map(values => Object.fromEntries(payload.schema.leader.map((field, index) => [field, values[index]])))
      assert.equal(first.ageHours, 4)
      assert.equal(first.status, "fading")
      assert.equal(first.retainedPct, 50)
      assert.equal(first.coinMoveSinceStartAtr, 0.5)
      assert.equal(first.coinReaction, "rising")
      assert.equal(second.coinMoveSinceStartAtr, -0.5)
      assert.equal(second.coinReaction, "falling")
      assert.equal(first.coinReturnSinceStartPct, 0)
      assert.equal(Object.is(first.coinReturnSinceStartPct, -0), false)
      return JSON.stringify(createResponse(scan))
    },
  })

  assert.deepEqual(report.observations[0].leaders, before.candidates[0].leaders)
  assert.deepEqual(scan, before)
})

test("repeated leader symbols retain separate pair benchmarks, episodes and candidate reactions", async () => {
  const scan = createScan(3)
  Object.assign(scan.candidates[1].leaders[0], {
    marketExcess4hAtr: 2.87654321,
    coinMoveSinceStartAtr: -0.987654321,
    coinReaction: "falling",
  })
  Object.assign(scan.candidates[2].leaders[0], {
    detectedAt: "2026-09-24T08:00:00.000Z",
    windowStartedAt: "2026-09-24T04:00:00.000Z",
    ageHours: 1,
    move4hAtr: 2.654321,
    moveSinceStartAtr: 3.987654321,
  })
  const report = await analyzePeerRadar(scan, "Peer-only prompt", {
    callAgent: async (_, message) => {
      const payload = JSON.parse(message)
      assert.deepEqual(payload.candidates.map(candidate => candidate.coin[payload.schema.coin.indexOf("baseCurrencyId")]), [
        "coin-0", "coin-1", "coin-2",
      ])
      assert.deepEqual(payload.candidates.map(candidate => candidate.leaders.length), [2, 2, 2])
      const leaders = payload.candidates.map(candidate => Object.fromEntries(
        payload.schema.leader.map((field, index) => [field, candidate.leaders[0][index]]),
      ))
      assert.deepEqual(leaders.map(leader => leader.symbol), ["LEADER0", "LEADER0", "LEADER0"])
      assert.deepEqual(leaders.map(leader => leader.ageHours), [4, 4, 1])
      assert.deepEqual(leaders.map(leader => leader.marketExcess4hAtr), [2.375, 2.877, 2.375])
      assert.deepEqual(leaders.map(leader => leader.coinMoveSinceStartAtr), [0.5, -0.988, -0.75])
      assert.deepEqual(leaders.map(leader => leader.move4hAtr), [4.125, 4.125, 2.654])
      assert.deepEqual(leaders.map(leader => leader.moveSinceStartAtr), [3.125, 3.125, 3.988])
      return JSON.stringify(createResponse(scan))
    },
  })

  assert.deepEqual(report.observations.map(observation => observation.leaders), [0, 2, 1].map(index => scan.candidates[index].leaders))
})

test("invalid response is preserved on the error without fallback or retry", async () => {
  let calls = 0
  await assert.rejects(analyzePeerRadar(createScan(), "Peer-only prompt", {
    callAgent: async () => {
      calls += 1
      return "not JSON"
    },
  }), (error) => {
    assert.ok(error instanceof InvalidPeerRadarAnalysisError)
    assert.equal(error.response, "not JSON")
    return true
  })
  assert.equal(calls, 1)
})

test("transport errors propagate without retry or success report", async () => {
  let calls = 0
  const failure = new Error("Agent unavailable")
  await assert.rejects(analyzePeerRadar(createScan(), "Peer-only prompt", {
    callAgent: async () => {
      calls += 1
      throw failure
    },
  }), error => error === failure)
  assert.equal(calls, 1)
})

for (const [name, change] of [
  ["schema", scan => scan.schemaVersion = 2],
  ["timeframe", scan => scan.timeframe = "4h"],
  ["timestamp", scan => scan.asOf = "invalid"],
  ["registry timestamp", scan => scan.registryGeneratedAt = undefined],
  ["candidate count", scan => scan.candidateCount += 1],
  ["duplicate candidate ID", scan => scan.candidates[1].coin.baseCurrencyId = scan.candidates[0].coin.baseCurrencyId],
  ["empty ID", scan => scan.candidates[0].coin.baseCurrencyId = " "],
  ["missing coin", scan => delete scan.candidates[0].coin],
  ["missing candidates", scan => delete scan.candidates],
  ["empty leaders", scan => scan.candidates[0].leaders = []],
  ["missing coverage", scan => delete scan.coverage],
  ["incomplete loaded coverage", scan => scan.coverage.available += 1],
  ["invalid peer status", scan => scan.candidates[0].peerStatus = "unavailable"],
  ["invalid leader status", scan => scan.candidates[0].leaders[0].status = "expired"],
  ["invalid reaction", scan => scan.candidates[0].leaders[0].coinReaction = "buy"],
  ["invalid relation", scan => scan.candidates[0].leaders[0].type = "transitive"],
  ["non-finite metric", scan => scan.candidates[0].leaders[0].moveSinceStartAtr = Infinity],
  ["non-numeric metric", scan => scan.candidates[0].leaders[0].responseRatio = "0.1"],
  ["missing frozen trigger", scan => delete scan.candidates[0].leaders[0].relativeVolume4h],
]) {
  test(`invalid scan ${name} is rejected before the agent call`, async () => {
    const scan = createScan()
    change(scan)
    let calls = 0
    await assert.rejects(analyzePeerRadar(scan, "Peer-only prompt", {
      callAgent: async () => {
        calls += 1
        return JSON.stringify(createResponse(scan))
      },
    }), /Step 11/)
    assert.equal(calls, 0)
  })
}

test("analysis validates its prompt and injected agent", async () => {
  await assert.rejects(analyzePeerRadar(createScan(), " ", {
    callAgent: async () => assert.fail("Invalid prompt must stop before calling"),
  }), /system prompt is required/)
  await assert.rejects(analyzePeerRadar(createScan(), "Peer-only prompt", {
    callAgent: null,
  }), /agent must be a function/)
})

test("parser accepts complete observations in any order and an empty caveats array", () => {
  const scan = createScan(7)
  const response = createResponse(scan)
  response.observations.reverse()
  response.observations[0].caveats = []
  assert.deepEqual(parsePeerRadarAnalysis(JSON.stringify(response), scan), response)
  assert.deepEqual(parsePeerRadarAnalysis(JSON.stringify(createResponse(createScan(0))), createScan(0)).observations, [])
})

for (const content of [undefined, null, {}, "", " ", "not JSON", "null", "[]", "1", "{}", "```json\n{}\n```", "{} trailing"]) {
  test(`parser rejects non-contract JSON: ${JSON.stringify(content)}`, () => {
    assert.throws(() => parsePeerRadarAnalysis(content, createScan()), InvalidPeerRadarAnalysisError)
  })
}

for (const [name, change, error] of [
  ["wrong schema", response => response.schemaVersion = 2, /schemaVersion/],
  ["string schema", response => response.schemaVersion = "1", /schemaVersion/],
  ["null schema", response => response.schemaVersion = null, /schemaVersion/],
  ["missing schema", response => delete response.schemaVersion, /structure/],
  ["asOf uses close instead of open", response => response.asOf = "2026-09-24T09:00:00.000Z", /asOf/],
  ["null asOf", response => response.asOf = null, /asOf/],
  ["missing observations", response => delete response.observations, /structure/],
  ["null observations", response => response.observations = null, /every candidate/],
  ["missing candidate", response => response.observations.pop(), /every candidate/],
  ["extra candidate", response => response.observations.push(response.observations[0]), /every candidate/],
  ["unknown ID", response => response.observations[0].baseCurrencyId = "unknown", /unknown candidate ID/],
  ["case-changed ID", response => response.observations[0].baseCurrencyId = "COIN-0", /unknown candidate ID/],
  ["duplicate ID", response => response.observations[1].baseCurrencyId = "coin-0", /duplicate candidate ID/],
  ["empty ID", response => response.observations[0].baseCurrencyId = " ", /non-empty string/],
  ["numeric ID", response => response.observations[0].baseCurrencyId = 0, /non-empty string/],
  ["null observation", response => response.observations[0] = null, /must be an object/],
  ["missing verdict", response => delete response.observations[0].verdict, /structure/],
  ["buy verdict", response => response.observations[0].verdict = "buy", /invalid verdict/],
  ["null verdict", response => response.observations[0].verdict = null, /invalid verdict/],
  ["empty explanation", response => response.observations[0].explanation = "", /explanation/],
  ["whitespace explanation", response => response.observations[0].explanation = " \n ", /explanation/],
  ["numeric explanation", response => response.observations[0].explanation = 7, /explanation/],
  ["missing caveats", response => delete response.observations[0].caveats, /structure/],
  ["non-array caveats", response => response.observations[0].caveats = "None", /caveats/],
  ["empty caveat", response => response.observations[0].caveats = [""], /caveats/],
  ["whitespace caveat", response => response.observations[0].caveats = [" \n"], /caveats/],
  ["null caveat", response => response.observations[0].caveats = [null], /caveats/],
  ["object caveat", response => response.observations[0].caveats = [{ text: "x" }], /caveats/],
]) {
  test(`parser rejects ${name}`, () => {
    const scan = createScan()
    const response = createResponse(scan)
    change(response)
    assert.throws(() => parsePeerRadarAnalysis(JSON.stringify(response), scan), error)
  })
}

for (const field of ["extra", "movementProbability", "leaders"]) {
  test(`parser rejects the extra ${field} field at both response levels`, () => {
    const scan = createScan()
    for (const location of ["root", "observation"]) {
      const response = createResponse(scan)
      const target = location === "root" ? response : response.observations[0]
      target[field] = 0.9
      assert.throws(() => parsePeerRadarAnalysis(JSON.stringify(response), scan), /unexpected structure/)
    }
  })
}

test("standalone empty step prepares tmp data without archiving or touching other pipeline files", async (context) => {
  const scan = createScan(0)
  const directory = await prepareStepDirectory(context, scan)
  await fs.writeFile(path.join(directory, "tmp", "step10-agent-analysis.json"), "main analysis sentinel")
  await fs.mkdir(path.join(directory, "reports"))
  await fs.writeFile(path.join(directory, "reports", "main-report.html"), "main report sentinel")

  await promisify(execFile)(process.execPath, [
    new URL("../src/step12-peer-radar-analysis.js", import.meta.url).pathname,
  ], { cwd: directory, timeout: 10_000 })

  const output = JSON.parse(await fs.readFile(path.join(directory, "tmp", "step12-peer-radar-analysis.json"), "utf8"))
  const names = await fs.readdir(path.join(directory, "reports"))
  assert.deepEqual(names, ["main-report.html"])
  assert.equal(output.analysisStatus, "skipped_no_candidates")
  assert.equal(output.analysis.callCount, 0)

  assert.equal(await fs.readFile(path.join(directory, "tmp", "step10-agent-analysis.json"), "utf8"), "main analysis sentinel")
  assert.equal(await fs.readFile(path.join(directory, "reports", "main-report.html"), "utf8"), "main report sentinel")
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(directory, "tmp", "step11-peer-radar.json"), "utf8")), scan)
})

test("injected step prepares the complete radar with exact facts in tmp only", async (context) => {
  const scan = createScan(7)
  const directory = await prepareStepDirectory(context, scan)
  const response = createResponse(scan)
  const systemPrompt = await fs.readFile(new URL("../src/prompts/peer-radar-analysis.md", import.meta.url), "utf8")
  await runInjectedStep(directory, `
    let calls = 0
    const result = await runPeerRadarAnalysisStep({
      callAgent: async (prompt, message, options) => {
        calls += 1
        assert.equal(prompt, ${JSON.stringify(systemPrompt)})
        const payload = JSON.parse(message)
        assert.equal(payload.schemaVersion, 2)
        assert.equal(payload.asOf, ${JSON.stringify(scan.asOf)})
        assert.deepEqual(payload.candidates.map(candidate => candidate.coin[payload.schema.coin.indexOf("baseCurrencyId")]),
          ${JSON.stringify(scan.candidates.map(candidate => candidate.coin.baseCurrencyId))})
        assert.equal(payload.candidates[0].leaders[0][payload.schema.leader.indexOf("retainedPct")], 75.758)
        assert.equal(Object.hasOwn(payload, "criteria"), false)
        assert.deepEqual(options, ${JSON.stringify(getModelSettings("peerRadarAnalysis"))})
        return ${JSON.stringify(JSON.stringify(response))}
      },
    })
    assert.equal(calls, 1)
    assert.equal(result.report.analysisStatus, "complete")
    assert.ok(result.outputPath.endsWith("step12-peer-radar-analysis.json"))
    assert.equal(Object.hasOwn(result, "reportPath"), false)
  `)

  const output = JSON.parse(await fs.readFile(path.join(directory, "tmp", "step12-peer-radar-analysis.json"), "utf8"))
  await assert.rejects(fs.access(path.join(directory, "reports")), { code: "ENOENT" })
  assert.deepEqual(output.observations, [0, 2, 4, 6, 1, 3, 5].map(index => ({
    ...scan.candidates[index],
    ...response.observations[index],
  })))
  assert.equal(Object.hasOwn(output, "candidates"), false)
  assert.deepEqual(await fs.readdir(directory), ["tmp"])
})

test("invalid agent JSON is archived and the step rejects without creating success outputs", async (context) => {
  const scan = createScan()
  const directory = await prepareStepDirectory(context, scan)
  await runInjectedStep(directory, `
    let calls = 0
    await assert.rejects(runPeerRadarAnalysisStep({
      callAgent: async () => { calls += 1; return "not JSON" },
    }), /not valid JSON/)
    assert.equal(calls, 1)
  `)

  const invalid = JSON.parse(await fs.readFile(path.join(directory, "tmp", "step12-peer-radar-analysis.invalid.json"), "utf8"))
  assert.equal(invalid.asOf, scan.asOf)
  assert.equal(invalid.response, "not JSON")
  assert.match(invalid.error, /Invalid peer radar analysis/)
  await assert.rejects(fs.access(path.join(directory, "tmp", "step12-peer-radar-analysis.json")), { code: "ENOENT" })
  await assert.rejects(fs.access(path.join(directory, "reports")), { code: "ENOENT" })
})

test("a failed later analysis does not replace any previous successful report", async (context) => {
  const scan = createScan()
  const directory = await prepareStepDirectory(context, scan)
  const response = createResponse(scan)
  await runInjectedStep(directory, `
    await runPeerRadarAnalysisStep({ callAgent: async () => ${JSON.stringify(JSON.stringify(response))} })
  `)
  const tmpPath = path.join(directory, "tmp", "step12-peer-radar-analysis.json")
  const before = await fs.readFile(tmpPath, "utf8")
  await assert.rejects(fs.access(path.join(directory, "reports")), { code: "ENOENT" })
  await runInjectedStep(directory, `
    await assert.rejects(runPeerRadarAnalysisStep({ callAgent: async () => "{}" }), /unexpected structure/)
  `)

  assert.equal(await fs.readFile(tmpPath, "utf8"), before)
  await assert.rejects(fs.access(path.join(directory, "reports")), { code: "ENOENT" })
})
