import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"

for (const [name, altMarketBackground] of [
  ["canonical metric keeps full precision", {
    status: "up",
    change4hPct: 0.000012345678901234,
    breadth4h: 0.55 + Number.EPSILON,
    warning: null,
  }],
  ["legacy missing metric becomes null", undefined],
]) {
  test(`CLI steps 5 → 6 → 13: ${name}, without raw step 3`, { timeout: 40_000 }, async (context) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "alt-market-background-pipeline-"))
    context.after(() => fs.rm(directory, { recursive: true, force: true }))
    await fs.mkdir(path.join(directory, "tmp"))

    const writeJson = (filename, data) => fs.writeFile(path.join(directory, "tmp", filename), JSON.stringify(data))
    const readJson = async filename => JSON.parse(await fs.readFile(path.join(directory, "tmp", filename), "utf8"))
    const run = filename => promisify(execFile)(process.execPath, [
      fileURLToPath(new URL(`../src/${filename}`, import.meta.url)),
    ], { cwd: directory, timeout: 10_000, killSignal: "SIGKILL" })
    const featureMetrics = {
      generatedAt: "2026-09-16T09:10:00.000Z",
      asOf: "2026-09-16T08:00:00.000Z",
      source: "tradingview",
      timeframe: "1h",
      marketContext: {
        breadth: 0.55 + Number.EPSILON,
        segmentRotation: { btc: -0.002, eth: 0.001, alts: 0.002, stables: -0.001 },
        stablecapChange: 0.0123456,
        ...(altMarketBackground === undefined ? {} : { altMarketBackground }),
      },
      coinCount: 0,
      rejectedCoinCount: 0,
      profiles: [],
      rejected: [],
    }
    const expectedBackground = altMarketBackground ?? null
    await writeJson("step4-feature-metrics.json", featureMetrics)

    await run("step5-preliminary-filter.js")
    const shortlist = await readJson("step5-preliminary-filter.json")
    assert.equal(shortlist.asOf, featureMetrics.asOf)
    assert.equal(shortlist.candidateCount, 0)
    assert.deepEqual(shortlist.candidates, [])
    assert.deepEqual(shortlist.marketContext, featureMetrics.marketContext)

    await run("step6-agent-payload.js")
    const payloadText = await fs.readFile(path.join(directory, "tmp", "step6-agent-payload.json"), "utf8")
    const payload = JSON.parse(payloadText)
    assert.equal(payloadText, JSON.stringify(payload, null, 2))
    assert.equal(payload.asOf, featureMetrics.asOf)
    assert.equal(payload.candidateCount, 0)
    assert.deepEqual(payload.candidates, [])
    assert.equal(payload.marketContext.breadth4h, 0.55)
    assert.deepEqual(payload.marketContext.altMarketBackground, expectedBackground)

    const sourceWindow = { from: "2026-09-15T09:10:00.000Z", asOf: featureMetrics.generatedAt }
    const sources = {
      asOf: featureMetrics.asOf,
      candidateCount: 0,
      candidates: [],
      newsEnrichment: sourceWindow,
      twitterEnrichment: sourceWindow,
    }
    await Promise.all([
      writeJson("step7-agent-analysis.json", {
        asOf: featureMetrics.asOf, candidateCount: 0, assessments: [], topCandidates: [],
      }),
      writeJson("step9-twitter-enrichment.json", sources),
      writeJson("step10-context-enrichment.json", { ...sources, generatedAt: featureMetrics.generatedAt }),
    ])
    await assert.rejects(fs.access(path.join(directory, "tmp", "step3-market-context.json")), { code: "ENOENT" })

    await run("step13-report.js")
    const reports = await fs.readdir(path.join(directory, "reports"))
    assert.equal(reports.length, 1)
    assert.match(reports[0], /^report-.*\.html$/)
    const html = await fs.readFile(path.join(directory, "reports", reports[0]), "utf8")
    const embedded = html.match(/<script id="report-data" type="application\/json">([\s\S]*?)<\/script>/)
    assert.ok(embedded, "Step 13 must embed report JSON")
    const report = JSON.parse(embedded[1])

    assert.equal(report.asOf, featureMetrics.asOf)
    assert.equal(report.candidateCount, 0)
    assert.deepEqual(report.coins, [])
    assert.deepEqual(report.marketContext, payload.marketContext)
    assert.deepEqual(report.altMarketBackground, expectedBackground)
    assert.deepEqual(await readJson("step4-feature-metrics.json"), featureMetrics)
    await assert.rejects(fs.access(path.join(directory, "tmp", "step3-market-context.json")), { code: "ENOENT" })
  })
}
