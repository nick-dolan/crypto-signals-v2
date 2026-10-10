import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"

import { isSafeInteger, isString } from "../src/helpers/utils.typed.js"

async function writeJson (directory, filename, value) {
  const destination = path.join(directory, "tmp", filename)
  await fs.mkdir(path.dirname(destination), { recursive: true })
  await fs.writeFile(destination, JSON.stringify(value))
}

async function readJson (directory, filename) {
  return JSON.parse(await fs.readFile(path.join(directory, "tmp", filename), "utf8"))
}

async function prepareInputs (t, { empty = false, history = true } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "step8.1-pattern-runner-"))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  const input = {
    asOf: "2026-10-09T13:00:00.000Z",
    timeframe: "1h",
    candidateCount: empty ? 0 : 1,
    candidates: empty
      ? []
      : [{
          coin: { symbol: "SOL", name: "Solana", baseCurrencyId: "XTVCSOL", marketSymbol: "BINANCE:SOLUSDT.P" },
          features: { derivatives: { oi_change_4h: 0.1 } },
          movementProbability: 0.99,
        }],
  }
  await writeJson(directory, "step5-preliminary-filter.json", input)
  await writeJson(directory, "step8.1-pattern-enrichment.json", { stale: true })
  await writeJson(directory, "unrelated/marker.json", { untouched: true })
  await fs.mkdir(path.join(directory, "tmp", "step8.1-pattern-data"))
  await fs.writeFile(path.join(directory, "tmp", "step8.1-pattern-data", "obsolete.txt"), "old pattern data")
  if (!empty && history) {
    await writeJson(directory, "step2-data-bootstrap/SOL--XTVCSOL/data.json", {
      coin: input.candidates[0].coin,
      timeframe: "1h",
      chart: {
        info: { fullName: input.candidates[0].coin.marketSymbol },
        periods: Array.from({ length: 200 }, (_, index) => ({
          time: Date.parse(input.asOf) / 1_000 - (198 - index) * 3_600,
          open: 100 + index, max: 102 + index, min: 99 + index, close: 101 + index, volume: 1_000 + index,
        })).reverse(),
      },
      studies: { openInterest: { periods: [{ time: Date.parse(input.asOf) / 1_000, close: 123 }] } },
    })
  }
  return directory
}

function runChild (directory, args) {
  return promisify(execFile)(process.execPath, [
    "--import", `data:text/javascript,${encodeURIComponent(`
      import assert from "node:assert/strict"
      import { mock } from "node:test"
      import { CopilotClient } from ${JSON.stringify(import.meta.resolve("@github/copilot-sdk"))}
      const start = mock.method(CopilotClient.prototype, "start", async () => assert.fail("Live SDK calls are forbidden"))
      const session = mock.method(CopilotClient.prototype, "createSession", async () => assert.fail("Live SDK sessions are forbidden"))
      const stop = mock.method(CopilotClient.prototype, "stop", async () => [])
      const fetch = mock.method(globalThis, "fetch", async () => assert.fail("Network calls are forbidden"))
      process.once("beforeExit", () => {
        assert.equal(start.mock.callCount(), 0, "No SDK starts expected")
        assert.equal(session.mock.callCount(), 0, "No SDK sessions expected")
        assert.equal(stop.mock.callCount(), 0, "No SDK cleanup expected")
        assert.equal(fetch.mock.callCount(), 0, "No network requests expected")
      })
    `)}`,
    ...args,
  ], {
    cwd: directory,
    timeout: 20_000,
    env: { ...process.env, NODE_OPTIONS: "", COPILOT_HOME: path.join(directory, ".copilot") },
  })
}

function runCli (directory) {
  return runChild(directory, [fileURLToPath(new URL("../src/step8.1-pattern-enrichment.js", import.meta.url))])
}

function runInjected (directory, code) {
  return runChild(directory, ["--input-type=module", "--eval", `
    import assert from "node:assert/strict"
    import fs from "node:fs/promises"
    import path from "node:path"
    import { mock } from "node:test"
    import { runPatternEnrichmentStep } from ${JSON.stringify(new URL("../src/step8.1-pattern-enrichment.js", import.meta.url).href)}
    import { enrichCandidatesWithPatterns } from ${JSON.stringify(new URL("../src/steps/step8.1-pattern-enrichment/enrich-candidates-with-patterns.js", import.meta.url).href)}
    ${code}
  `])
}

function assertReport (report, input, candidateCallCount) {
  assert.deepEqual(Object.keys(report).sort(), [
    "asOf", "candidateCount", "candidates", "generatedAt", "patternEnrichment", "schemaVersion", "timeframe",
  ])
  assert.equal(report.schemaVersion, 1)
  assert.equal(report.asOf, input.asOf)
  assert.equal(report.timeframe, input.timeframe)
  assert.equal(report.candidateCount, input.candidateCount)
  assert.equal(report.candidates.length, input.candidateCount)
  assert.equal(new Date(report.generatedAt).toISOString(), report.generatedAt)
  assert.deepEqual(report.patternEnrichment, {
    source: "github-copilot-sdk",
    model: "gpt-6-luna",
    reasoningEffort: "medium",
    lookbackHours: 168,
    from: new Date(Date.parse(input.asOf) - 167 * 3_600_000).toISOString(),
    to: new Date(Date.parse(input.asOf) + 3_600_000).toISOString(),
    candidateCallCount,
  })
}

function assertFinalManifest (manifest, report) {
  const { candidates, ...metadata } = manifest
  assert.deepEqual(metadata, {
    schemaVersion: 1,
    asOf: report.asOf,
    timeframe: report.timeframe,
    from: report.patternEnrichment.from,
    to: report.patternEnrichment.to,
    directory: "step8.1-pattern-data",
    candidateCount: report.candidateCount,
    generatedAt: report.generatedAt,
    patternEnrichment: report.patternEnrichment,
  })
  assert.deepEqual(candidates.map(({ symbol, status, summary, caveat }) => ({ symbol, status, summary, caveat })), report.candidates)
}

async function readPatternFiles (directory, candidate) {
  assert.equal(candidate.directory, "SOL--XTVCSOL")
  assert.deepEqual(candidate.files, {
    data: "tmp/step8.1-pattern-data/SOL--XTVCSOL/data.json",
    svg: "tmp/step8.1-pattern-data/SOL--XTVCSOL/chart.svg",
    png: "tmp/step8.1-pattern-data/SOL--XTVCSOL/chart.png",
  })
  const [data, svg, png] = await Promise.all([
    fs.readFile(path.join(directory, candidate.files.data), "utf8").then(JSON.parse),
    fs.readFile(path.join(directory, candidate.files.svg), "utf8"),
    fs.readFile(path.join(directory, candidate.files.png)),
  ])
  assert.match(svg, /^<svg\s/)
  assert.equal([...svg.matchAll(/class="candle"/g)].length, candidate.coverage.candles)
  assert.doesNotMatch(svg, /OPEN INTEREST|Оценка агента|Вероятность|ТОП /)
  assert.equal(png.toString("hex", 0, 8), "89504e470d0a1a0a")
  assert.equal(png.readUInt32BE(16), 1200)
  assert.equal(png.readUInt32BE(20), 1280)
  assert.deepEqual((await fs.readdir(path.join(directory, "tmp", "step8.1-pattern-data", candidate.directory))).sort(), [
    "analysis.json", "chart.png", "chart.svg", "data.json",
  ])
  return data
}

test("importing step 8.1 does not run the CLI or change existing files", { timeout: 30_000 }, async (t) => {
  const directory = await prepareInputs(t, { empty: true })
  await runInjected(directory, "")
  assert.deepEqual(await readJson(directory, "step8.1-pattern-enrichment.json"), { stale: true })
  assert.deepEqual(await readJson(directory, "unrelated/marker.json"), { untouched: true })
  assert.equal(await fs.readFile(path.join(directory, "tmp", "step8.1-pattern-data", "obsolete.txt"), "utf8"), "old pattern data")
})

test("step 8.1 real CLI writes an empty report and final manifest without starting an SDK session", { timeout: 30_000 }, async (t) => {
  const directory = await prepareInputs(t, { empty: true })
  const input = await readJson(directory, "step5-preliminary-filter.json")
  const { stdout } = await runCli(directory)
  assert.match(stdout, /Analyzed weekly patterns for 0\/0 candidates/)
  const report = await readJson(directory, "step8.1-pattern-enrichment.json")
  const manifest = await readJson(directory, "step8.1-pattern-data/manifest.json")
  assertReport(report, input, 0)
  assert.deepEqual(report.candidates, [])
  assertFinalManifest(manifest, report)
  assert.deepEqual(await fs.readdir(path.join(directory, "tmp", "step8.1-pattern-data")), ["manifest.json"])
  assert.deepEqual(await readJson(directory, "step5-preliminary-filter.json"), input)
  assert.deepEqual(await readJson(directory, "unrelated/marker.json"), { untouched: true })
})

test("step 8.1 runs real preparation and enrichment with one stubbed agent and an absolute PNG attachment", { timeout: 30_000 }, async (t) => {
  const directory = await prepareInputs(t)
  const input = await readJson(directory, "step5-preliminary-filter.json")
  const history = await readJson(directory, "step2-data-bootstrap/SOL--XTVCSOL/data.json")
  await runInjected(directory, `
    const callAgent = mock.fn(async (systemPrompt, message, options) => {
      assert.equal(systemPrompt, await fs.readFile(${JSON.stringify(fileURLToPath(new URL("../src/prompts/candidate-pattern-enrichment.md", import.meta.url)))}, "utf8"))
      assert.deepEqual(JSON.parse(message), {
        symbol: "SOL", name: "Solana", marketSymbol: "BINANCE:SOLUSDT.P", asOf: "2026-10-09T13:00:00.000Z",
        timeframe: "1h", from: "2026-10-02T14:00:00.000Z", to: "2026-10-09T14:00:00.000Z",
        coverage: { candles: 168, volume: 168 }, dataCaveat: null,
      })
      assert.deepEqual(options, {
        provider: "copilot-sdk", model: "gpt-6-luna", reasoningEffort: "medium",
        attachments: [{ type: "file", path: path.resolve("tmp/step8.1-pattern-data/SOL--XTVCSOL/chart.png"), displayName: "chart.png" }],
      })
      assert.ok(path.isAbsolute(options.attachments[0].path))
      const png = await fs.readFile(options.attachments[0].path)
      assert.equal(png.toString("hex", 0, 8), "89504e470d0a1a0a")
      return JSON.stringify({ symbol: "SOL", summary: " Возможный бычий флаг. ", caveat: " Выход не подтверждён. " })
    })
    const result = await runPatternEnrichmentStep({
      enrich: (prepared, systemPrompt) => enrichCandidatesWithPatterns(prepared, systemPrompt, { callAgent }),
    })
    assert.equal(callAgent.mock.callCount(), 1)
    assert.deepEqual(result, JSON.parse(await fs.readFile("tmp/step8.1-pattern-enrichment.json", "utf8")))
  `)
  const report = await readJson(directory, "step8.1-pattern-enrichment.json")
  const manifest = await readJson(directory, "step8.1-pattern-data/manifest.json")
  assertReport(report, input, 1)
  assert.deepEqual(report.candidates, [{
    symbol: "SOL", status: "available", summary: "Возможный бычий флаг.", caveat: "Выход не подтверждён.",
  }])
  assertFinalManifest(manifest, report)
  const [candidate] = manifest.candidates
  const data = await readPatternFiles(directory, candidate)
  assert.deepEqual(candidate, {
    symbol: "SOL", name: "Solana", marketSymbol: "BINANCE:SOLUSDT.P", directory: "SOL--XTVCSOL",
    files: {
      data: "tmp/step8.1-pattern-data/SOL--XTVCSOL/data.json",
      svg: "tmp/step8.1-pattern-data/SOL--XTVCSOL/chart.svg",
      png: "tmp/step8.1-pattern-data/SOL--XTVCSOL/chart.png",
    },
    coverage: { candles: 168, volume: 168 }, ready: true, ...report.candidates[0],
  })
  assert.deepEqual(data, {
    schemaVersion: 1,
    coin: input.candidates[0].coin,
    asOf: input.asOf,
    timeframe: input.timeframe,
    from: report.patternEnrichment.from,
    to: report.patternEnrichment.to,
    timeConvention: "time: Unix seconds UTC, candle open; asOf: open of the last closed candle; to: exclusive end",
    coverage: { candles: 168, volume: 168 },
    warnings: [],
    candles: history.chart.periods
      .filter(point => point.time >= Date.parse(data.from) / 1_000 && point.time <= Date.parse(input.asOf) / 1_000)
      .sort((first, second) => first.time - second.time)
      .map(({ time, open, max, min, close, volume }) => ({ time, open, high: max, low: min, close, volume })),
  })
  assert.equal(data.candles.length, 168)
  assert.ok(data.candles.every((point, index) => isSafeInteger(point.time) && point.time === Date.parse(data.from) / 1_000 + index * 3_600))
  assert.equal(data.candles.at(-1).time, Date.parse(input.asOf) / 1_000)
  assert.equal(Date.parse(data.to) / 1_000, data.candles.at(-1).time + 3_600)
  assert.deepEqual(await readJson(directory, "step8.1-pattern-data/SOL--XTVCSOL/analysis.json"), report.candidates[0])
  assert.deepEqual((await fs.readdir(path.join(directory, "tmp", "step8.1-pattern-data"))).sort(), ["SOL--XTVCSOL", "manifest.json"])
  assert.deepEqual(await readJson(directory, "step5-preliminary-filter.json"), input)
  assert.deepEqual(await readJson(directory, "step2-data-bootstrap/SOL--XTVCSOL/data.json"), history)
  assert.deepEqual(await readJson(directory, "unrelated/marker.json"), { untouched: true })
})

for (const [name, update, warning] of [
  ["missing history", null, /ENOENT/],
  ["a mismatched history timeframe", data => ({ ...data, timeframe: "15m" }), /интервал 1h/],
  ["millisecond history epochs", data => ({
    ...data, chart: { ...data.chart, periods: data.chart.periods.map(point => ({ ...point, time: point.time * 1_000 })) },
  }), /нет корректной свечи на asOf/],
  ["fractional-second history epochs", data => ({
    ...data, chart: { ...data.chart, periods: data.chart.periods.map(point => ({ ...point, time: point.time + 0.001 })) },
  }), /нет корректной свечи на asOf/],
]) {
  test(`step 8.1 reports ${name} as unavailable without calling an agent`, { timeout: 30_000 }, async (t) => {
    const directory = await prepareInputs(t, { history: update !== null })
    const input = await readJson(directory, "step5-preliminary-filter.json")
    if (update !== null) {
      await writeJson(directory, "step2-data-bootstrap/SOL--XTVCSOL/data.json", update(await readJson(directory, "step2-data-bootstrap/SOL--XTVCSOL/data.json")))
    }
    await runInjected(directory, `
      const callAgent = mock.fn(async () => assert.fail("No usable history"))
      await runPatternEnrichmentStep({
        enrich: (prepared, systemPrompt) => enrichCandidatesWithPatterns(prepared, systemPrompt, { callAgent }),
      })
      assert.equal(callAgent.mock.callCount(), 0)
    `)
    const report = await readJson(directory, "step8.1-pattern-enrichment.json")
    const manifest = await readJson(directory, "step8.1-pattern-data/manifest.json")
    assertReport(report, input, 0)
    assertFinalManifest(manifest, report)
    assert.equal(report.candidates[0].symbol, "SOL")
    assert.equal(report.candidates[0].status, "unavailable")
    assert.equal(report.candidates[0].summary, null)
    assert.match(report.candidates[0].caveat, warning)
    assert.equal(manifest.candidates[0].ready, false)
    const data = await readPatternFiles(directory, manifest.candidates[0])
    assert.equal(data.asOf, input.asOf)
    assert.equal(data.timeframe, input.timeframe)
    assert.equal(data.from, manifest.from)
    assert.equal(data.to, manifest.to)
    assert.deepEqual(data.coverage, { candles: 0, volume: 0 })
    assert.deepEqual(manifest.candidates[0].coverage, data.coverage)
    assert.equal(data.candles.length, 168)
    assert.ok(data.candles.every(point => [point.open, point.high, point.low, point.close, point.volume].every(value => value === null)))
    assert.equal(report.candidates[0].caveat, data.warnings.join(" "))
    assert.deepEqual(await readJson(directory, "step8.1-pattern-data/SOL--XTVCSOL/analysis.json"), report.candidates[0])
    assert.deepEqual(await readJson(directory, "unrelated/marker.json"), { untouched: true })
  })
}

for (const stage of ["readJson", "prepare", "enrich"]) {
  test(`step 8.1 clears the stale root report before a ${stage} failure and retains unrelated tmp files`, { timeout: 30_000 }, async (t) => {
    const directory = await prepareInputs(t, { empty: true })
    await runInjected(directory, `
      await assert.rejects(runPatternEnrichmentStep({
        ${stage}: async () => {
          await assert.rejects(fs.access("tmp/step8.1-pattern-enrichment.json"), { code: "ENOENT" })
          throw new Error("${stage} failed")
        },
        writeJson: async () => assert.fail("Failed runs must not publish a report"),
      }), { message: "${stage} failed" })
    `)
    await assert.rejects(fs.access(path.join(directory, "tmp", "step8.1-pattern-enrichment.json")), { code: "ENOENT" })
    assert.deepEqual(await readJson(directory, "unrelated/marker.json"), { untouched: true })
    assert.equal((await readJson(directory, "step5-preliminary-filter.json")).candidateCount, 0)
  })
}

test("step 8.1 leaves no root report when writing the final manifest fails", { timeout: 30_000 }, async (t) => {
  const directory = await prepareInputs(t, { empty: true })
  assert.deepEqual(await readJson(directory, "step8.1-pattern-enrichment.json"), { stale: true })
  await runInjected(directory, `
    import { writeTmpJson } from ${JSON.stringify(new URL("../src/helpers/fs-helper.js", import.meta.url).href)}
    const writeJson = mock.fn(async (filename, value) => {
      if (filename === path.join("step8.1-pattern-data", "manifest.json")) {
        await assert.rejects(fs.access("tmp/step8.1-pattern-enrichment.json"), { code: "ENOENT" })
        assert.equal(value.patternEnrichment.candidateCallCount, 0)
        throw new Error("Final manifest write failed")
      }
      return writeTmpJson(filename, value)
    })
    await assert.rejects(runPatternEnrichmentStep({ writeJson }), { message: "Final manifest write failed" })
    assert.deepEqual(writeJson.mock.calls.map(call => call.arguments[0]), [path.join("step8.1-pattern-data", "manifest.json")])
  `)
  await assert.rejects(fs.access(path.join(directory, "tmp", "step8.1-pattern-enrichment.json")), { code: "ENOENT" })
  assert.deepEqual(await readJson(directory, "unrelated/marker.json"), { untouched: true })
})

for (const [name, changes, message] of [
  ["a missing shortlist", null, /ENOENT/],
  ["malformed JSON", "{", /JSON/],
  ["a mismatched candidateCount", { candidateCount: 1 }, /matching candidateCount/],
  ["a non-hourly timeframe", { timeframe: "15m" }, /closed hourly snapshot/],
  ["a fractional-second snapshot", { asOf: "2026-10-09T13:00:00.001Z" }, /closed hourly snapshot/],
  ["an off-grid snapshot", { asOf: "2026-10-09T13:00:01.000Z" }, /closed hourly snapshot/],
]) {
  test(`step 8.1 real CLI exits 1 for ${name} and removes the stale report`, { timeout: 30_000 }, async (t) => {
    const directory = await prepareInputs(t, { empty: true })
    if (changes === null) {
      await fs.rm(path.join(directory, "tmp", "step5-preliminary-filter.json"))
    } else if (isString(changes)) {
      await fs.writeFile(path.join(directory, "tmp", "step5-preliminary-filter.json"), changes)
    } else {
      await writeJson(directory, "step5-preliminary-filter.json", { ...await readJson(directory, "step5-preliminary-filter.json"), ...changes })
    }
    await assert.rejects(runCli(directory), (error) => {
      assert.equal(error.code, 1)
      assert.match(error.stderr, /step8\.1-pattern-enrichment\.js/)
      assert.match(error.stderr, message)
      assert.doesNotMatch(error.stderr, /ERR_ASSERTION|forbidden/)
      return true
    })
    await assert.rejects(fs.access(path.join(directory, "tmp", "step8.1-pattern-enrichment.json")), { code: "ENOENT" })
    assert.deepEqual(await readJson(directory, "unrelated/marker.json"), { untouched: true })
  })
}
