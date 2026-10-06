import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"

import { renderReportHtml } from "../src/reports/render-report-html.js"
import { createReportStore } from "../src/reports/store.js"

for (const [name, altMarketBackground] of [
  ["canonical metric keeps full precision", {
    status: "up",
    change4hPct: 0.000012345678901234,
    breadth4h: 0.55 + Number.EPSILON,
    warning: null,
  }],
  ["legacy missing metric becomes null", undefined],
]) {
  test(`CLI steps 5 → 9 → 13: ${name}, without raw step 3`, { timeout: 40_000 }, async (context) => {
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

    const sourceWindow = { from: "2026-09-15T09:10:00.000Z", asOf: featureMetrics.generatedAt }
    const sources = {
      asOf: featureMetrics.asOf,
      candidateCount: 0,
      candidates: [],
      newsEnrichment: sourceWindow,
      twitterEnrichment: sourceWindow,
    }
    await Promise.all([
      writeJson("step10-agent-analysis.json", {
        schemaVersion: 3,
        objective: "P(рост > 2.5 ATR в следующие 4–12 часов)",
        asOf: featureMetrics.asOf, candidateCount: 0, assessments: [], topCandidates: [],
      }),
      writeJson("step7-twitter-enrichment.json", sources),
      writeJson("step8-context-enrichment.json", { ...sources, generatedAt: featureMetrics.generatedAt }),
    ])
    await run("step9-agent-payload.js")
    const payload = await readJson("step9-agent-payload.json")
    assert.equal(payload.asOf, featureMetrics.asOf)
    assert.equal(payload.candidateCount, 0)
    assert.deepEqual(payload.candidates, [])
    assert.equal(Object.hasOwn(payload.marketContext, "breadth4h"), false)
    assert.deepEqual(payload.marketContext.altMarketBackground, expectedBackground)
    assert.equal(payload.objective, "P(рост > 2.5 ATR в следующие 4–12 часов)")

    await assert.rejects(fs.access(path.join(directory, "tmp", "step3-market-context.json")), { code: "ENOENT" })

    await run("step13-report.js")
    const store = await createReportStore({ directory: path.join(directory, "reports") })
    context.after(() => store.close())
    const reports = await store.list()
    assert.equal(reports.length, 1)
    const report = await store.read(reports[0].id)
    assert.ok(report, "Step 13 must publish a readable report snapshot")
    const html = await renderReportHtml(report)
    const embedded = html.match(/<script id="report-data" type="application\/json">([\s\S]*?)<\/script>/)
    assert.ok(embedded, "Report export must embed report JSON")
    assert.deepEqual(JSON.parse(embedded[1]), report)

    assert.equal(report.asOf, featureMetrics.asOf)
    assert.equal(report.candidateCount, 0)
    assert.deepEqual(report.coins, [])
    assert.deepEqual(report.marketContext, payload.marketContext)
    assert.deepEqual(report.altMarketBackground, expectedBackground)
    assert.deepEqual(await readJson("step4-feature-metrics.json"), featureMetrics)
    await assert.rejects(fs.access(path.join(directory, "tmp", "step3-market-context.json")), { code: "ENOENT" })
  })
}
