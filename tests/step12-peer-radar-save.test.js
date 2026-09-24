import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { promisify } from "node:util"

import { savePeerRadarReport } from "../src/steps/step12-peer-radar-analysis/save-peer-radar-report.js"

async function temporaryDirectory (context) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "step12-peer-radar-save-"))
  context.after(() => fs.rm(directory, { recursive: true, force: true }))
  return directory
}

function createReport (generatedAt) {
  return {
    schemaVersion: 1,
    generatedAt,
    scanGeneratedAt: "2026-09-16T08:02:00.000Z",
    asOf: "2026-09-16T07:00:00.000Z",
    snapshotClosedAt: "2026-09-16T08:00:00.000Z",
    timeframe: "1h",
    registryGeneratedAt: null,
    universeCoinCount: 2,
    loadedCoinCount: 2,
    coverage: { available: 1, partial: 1, no_peers: 0, insufficient_data: 0, not_covered: 0, unreviewed: 0, unavailable: 0 },
    criteria: { impulse: "Импульс", lag: "Отставание", reaction: "Фактическая реакция" },
    candidateCount: 0,
    analysisStatus: "skipped_no_candidates",
    analysis: { source: "github-copilot-sdk", model: "GPT-6-Astra", reasoningEffort: "high", callCount: 0 },
    observationCount: 0,
    watchCount: 0,
    observations: [],
  }
}

for (const [generatedAt, filename] of [
  ["2026-09-16T13:30:40.123Z", "peer-radar-2026-09-16_16-30-40_GMT+3.json"],
  ["2026-09-16T21:05:06.789Z", "peer-radar-2026-09-17_00-05-06_GMT+3.json"],
  ["2026-12-31T22:59:59.999Z", "peer-radar-2027-01-01_01-59-59_GMT+3.json"],
  ["2026-01-15T00:00:00.000Z", "peer-radar-2026-01-15_03-00-00_GMT+3.json"],
  ["2026-07-15T00:00:00.000Z", "peer-radar-2026-07-15_03-00-00_GMT+3.json"],
  ["2026-09-16T16:30:40.123+03:00", "peer-radar-2026-09-16_16-30-40_GMT+3.json"],
]) {
  test(`saves peer JSON using its own generatedAt as ${filename}`, async (context) => {
    const directory = path.join(await temporaryDirectory(context), "reports")
    const report = createReport(generatedAt)
    const filePath = await savePeerRadarReport(report, directory)

    assert.equal(filePath, path.join(directory, filename))
    assert.deepEqual(JSON.parse(await fs.readFile(filePath, "utf8")), report)
    assert.deepEqual(await fs.readdir(directory), [filename])
  })
}

test("same-second peer reports keep the old file and add numbered suffixes", async (context) => {
  const directory = await temporaryDirectory(context)
  const reports = [
    createReport("2026-09-16T13:30:40.123Z"),
    createReport("2026-09-16T13:30:40.999Z"),
    createReport("2026-09-16T13:30:40.456Z"),
  ]
  const paths = []
  for (const report of reports) {
    paths.push(await savePeerRadarReport(report, directory))
  }

  assert.deepEqual(paths.map(filePath => path.basename(filePath)), [
    "peer-radar-2026-09-16_16-30-40_GMT+3.json",
    "peer-radar-2026-09-16_16-30-40_GMT+3-1.json",
    "peer-radar-2026-09-16_16-30-40_GMT+3-2.json",
  ])
  assert.deepEqual(await Promise.all(paths.map(async filePath => JSON.parse(await fs.readFile(filePath, "utf8")))), reports)
})

test("concurrent peer report writes use exclusive creation and never overwrite", async (context) => {
  const directory = await temporaryDirectory(context)
  const reports = ["123", "456", "789"].map(ms => createReport(`2026-09-16T13:30:40.${ms}Z`))
  const paths = await Promise.all(reports.map(report => savePeerRadarReport(report, directory)))

  assert.equal(new Set(paths).size, 3)
  assert.deepEqual(await Promise.all(paths.map(async filePath => JSON.parse(await fs.readFile(filePath, "utf8")))), reports)
  assert.deepEqual((await fs.readdir(directory)).sort(), [
    "peer-radar-2026-09-16_16-30-40_GMT+3-1.json",
    "peer-radar-2026-09-16_16-30-40_GMT+3-2.json",
    "peer-radar-2026-09-16_16-30-40_GMT+3.json",
  ])
})

test("save propagates non-collision filesystem errors without retry", async (context) => {
  const directory = await temporaryDirectory(context)
  const failure = Object.assign(new Error("Permission denied"), { code: "EACCES" })
  const write = context.mock.method(fs, "writeFile", async (_, content, options) => {
    assert.deepEqual(options, { encoding: "utf8", flag: "wx" })
    assert.equal(JSON.parse(content).schemaVersion, 1)
    throw failure
  })

  await assert.rejects(savePeerRadarReport(createReport("2026-09-16T13:30:40.123Z"), directory), failure)
  assert.equal(write.mock.callCount(), 1)
  assert.deepEqual(await fs.readdir(directory), [])
})

test("save rejects missing or invalid timestamps before creating a report", async (context) => {
  const directory = path.join(await temporaryDirectory(context), "reports")
  for (const generatedAt of [undefined, null, "", "not a timestamp"]) {
    await assert.rejects(savePeerRadarReport(createReport(generatedAt), directory), /generatedAt/)
  }
  await assert.rejects(fs.access(directory), { code: "ENOENT" })
})

for (const timezone of ["UTC", "America/Los_Angeles", "Asia/Tokyo"]) {
  test(`default lowercase reports persists after tmp cleanup with TZ=${timezone}`, async (context) => {
    const directory = await temporaryDirectory(context)
    const report = createReport("2026-12-31T21:05:06.789Z")
    const { stdout } = await promisify(execFile)(process.execPath, ["--input-type=module", "--eval", `
      import { savePeerRadarReport } from ${JSON.stringify(new URL("../src/steps/step12-peer-radar-analysis/save-peer-radar-report.js", import.meta.url).href)}
      import { resetTmpDirectory } from ${JSON.stringify(new URL("../src/helpers/fs-helper.js", import.meta.url).href)}
      const filePath = await savePeerRadarReport(${JSON.stringify(report)})
      await resetTmpDirectory()
      console.log(filePath)
    `], { cwd: directory, env: { ...process.env, TZ: timezone }, timeout: 10_000 })
    const expected = path.join(directory, "reports", "peer-radar-2027-01-01_00-05-06_GMT+3.json")

    assert.equal(await fs.realpath(stdout.trim()), await fs.realpath(expected))
    assert.deepEqual(JSON.parse(await fs.readFile(expected, "utf8")), report)
    assert.deepEqual(await fs.readdir(path.join(directory, "tmp")), [])
    assert.deepEqual((await fs.readdir(directory)).sort(), ["reports", "tmp"])
  })
}
