import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { promisify } from "node:util"

import { createReportStore } from "../src/reports/store.js"
import { renderReportHtml } from "../src/reports/render-report-html.js"
import { buildMarketBrief } from "../src/steps/step12.1-market-brief/build-market-brief.js"

async function prepareInputs (t, empty = false) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "step13-report-save-"))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  const asOf = "2026-09-26T11:00:00.000Z"
  const coin = { symbol: "COTI", name: "Coti", baseCurrencyId: "XTVCCOTI", marketSymbol: "BINANCE:COTIUSDT.P" }
  const window = { from: "2026-09-25T11:00:00.000Z", asOf }
  const candidates = empty
    ? []
    : [{
        symbol: coin.symbol,
        explanation: "Техническое объяснение",
        news: { status: "available", items: [{ title: "Новость <script>", url: "https://example.com/news" }] },
        twitter: { status: "empty", tweets: [] },
      }]
  const inputs = {
    "step5-preliminary-filter.json": {
      asOf, timeframe: "1h", candidateCount: candidates.length, universeCoinCount: 250,
      candidates: empty ? [] : [{ coin }],
    },
    "step6-agent-payload.json": {
      schemaVersion: 10, asOf, timeframe: "1h", candidateCount: candidates.length,
      objective: "P(сильное движение в следующие 4–12 часов)",
      marketContext: { breadth4h: 0.5 }, marketDefinitions: { breadth4h: "Ширина" },
      schema: { volume: ["volumeZ"] }, definitions: { volumeZ: "Аномалия объёма" }, flagDefinitions: {},
      candidates: empty ? [] : [{ symbol: coin.symbol, name: coin.name, selectionRank: 1, volume: [2.5], flags: [] }],
    },
    "step7-agent-analysis.json": {
      asOf, candidateCount: candidates.length,
      topCandidates: empty ? [] : [{ symbol: coin.symbol, explanation: candidates[0].explanation }],
      assessments: empty
        ? []
        : [{
            symbol: coin.symbol, movementProbability: 0.7, estimateConfidence: "medium",
            drivers: ["Объём"], counterSignals: [], tradingViewUrl: "https://www.tradingview.com/",
          }],
    },
    "step9-twitter-enrichment.json": {
      asOf, newsEnrichment: window, twitterEnrichment: window, candidates,
    },
    "step10-context-enrichment.json": {
      asOf, generatedAt: "2026-09-26T12:00:00.000Z", newsEnrichment: window, twitterEnrichment: window,
      candidates: candidates.map(({ symbol, explanation }) => ({
        symbol, explanation, enrichedExplanation: "Объяснение и новости </script>",
        socialSignificant: true, socialReason: "Обновление проекта", socialSentiment: "positive",
      })),
    },
    "step2-data-bootstrap/COTI--XTVCCOTI/data.json": {
      coin, timeframe: "1h", chart: { periods: [{
        time: Date.parse(asOf) / 1_000, open: 1, max: 2, min: 0.5, close: 1.5, volume: 100,
      }] },
    },
  }
  for (const [name, value] of Object.entries(inputs)) {
    const filename = path.join(directory, "tmp", name)
    await fs.mkdir(path.dirname(filename), { recursive: true })
    await fs.writeFile(filename, JSON.stringify(value))
  }
  await fs.mkdir(path.join(directory, "data"))
  await fs.writeFile(path.join(directory, "data", "coin-descriptions.json"), JSON.stringify({
    coins: [{ ...coin, description: "Описание на момент отчёта", sources: [{ url: "https://example.com/about" }] }],
  }))
  return directory
}

function runStep (directory) {
  return promisify(execFile)(process.execPath, [
    new URL("../src/step13-report.js", import.meta.url).pathname,
  ], { cwd: directory, timeout: 20_000 })
}

function runInjected (directory, code) {
  return promisify(execFile)(process.execPath, ["--input-type=module", "--eval", `
    import assert from "node:assert/strict"
    import { runReportStep } from ${JSON.stringify(new URL("../src/step13-report.js", import.meta.url).href)}
    ${code}
  `], { cwd: directory, timeout: 20_000 })
}

for (const empty of [false, true]) {
  test(`step 13 archives ${empty ? "empty" : "complete"} data without HTML or independent radar files`, { timeout: 30_000 }, async (t) => {
    const directory = await prepareInputs(t, empty)
    const { stdout, stderr } = await runStep(directory)
    assert.match(stdout, /Parquet snapshot/)
    assert.match(stderr, /Результат шага 12 отсутствует/)
    const store = await createReportStore({ directory: path.join(directory, "reports") })
    try {
      const [metadata] = await store.list()
      assert.ok(metadata)
      assert.equal(metadata.candidateCount, empty ? 0 : 1)
      assert.equal(metadata.asOf, "2026-09-26T11:00:00.000Z")
      assert.deepEqual(await fs.readdir(path.join(directory, "reports")), [metadata.id])
      assert.deepEqual((await fs.readdir(path.join(directory, "reports", metadata.id))).sort(), [
        "coins.parquet", "history.parquet", "peer-radar.parquet", "report.parquet",
      ])
      const report = await store.read(metadata.id)
      assert.equal(report.peerRadar.status, "unavailable")
      assert.deepEqual(report.peerRadar.histories, {})
      if (!empty) {
        assert.equal(report.coins[0].features.volumeZ, 2.5)
        assert.equal(report.coins[0].movementProbability, 0.7)
        assert.equal(report.coins[0].explanation, "Объяснение и новости </script>")
        assert.equal(report.coins[0].socialSignificant, true)
        assert.equal(report.coins[0].information.news.items[0].title, "Новость <script>")
        assert.equal(report.coins[0].history.candles[0].close, 1.5)
        assert.deepEqual(report.coins[0].history.openInterest, [{ time: Date.parse(metadata.asOf) / 1_000 }])
        assert.equal(report.coinDescriptions.XTVCCOTI.description, "Описание на момент отчёта")
      }
      await fs.rm(path.join(directory, "tmp"), { recursive: true })
      await fs.rm(path.join(directory, "data"), { recursive: true })
      assert.deepEqual(await store.read(metadata.id), report)
    } finally {
      await store.close()
    }
  })
}

test("rebuilding step 13 creates another immutable snapshot and preserves legacy files", { timeout: 30_000 }, async (t) => {
  const directory = await prepareInputs(t)
  await fs.mkdir(path.join(directory, "reports"))
  await fs.writeFile(path.join(directory, "reports", "legacy.html"), "Legacy report")
  await runStep(directory)
  const store = await createReportStore({ directory: path.join(directory, "reports") })
  try {
    const [first] = await store.list()
    const before = await store.read(first.id)
    await runStep(directory)
    assert.equal((await store.list()).length, 2)
    assert.deepEqual(await store.read(first.id), before)
    assert.equal(await fs.readFile(path.join(directory, "reports", "legacy.html"), "utf8"), "Legacy report")
  } finally {
    await store.close()
  }
})

test("step 13 preserves the digest and source provenance in the immutable archive and downloadable HTML", async (t) => {
  const directory = await prepareInputs(t)
  const brief = await buildMarketBrief("Prompt", {
    marketAsOf: "2026-09-26T11:00:00.000Z",
    collectSources: async () => ({
      from: "2026-09-25T12:00:00.000Z", asOf: "2026-09-26T12:00:00.000Z", warnings: [],
      sources: [{
        id: "source-1", channel: "tradingview", title: "Событие <script>",
        text: "Сохранённая публикация </script>", url: "https://publisher.example/news",
        publishedAt: "2026-09-26T11:55:00.000Z", author: null, publisher: "Original publisher",
      }],
      coverage: ["tavily", "tradingview", "twitter"].map(source => ({
        source, status: source === "tradingview" ? "available" : "empty",
        fetchedCount: source === "tradingview" ? 1 : 0, error: null,
      })),
    }),
    callAgent: async () => JSON.stringify({
      schemaVersion: 1, asOf: "2026-09-26T12:00:00.000Z",
      events: [{
        title: "Главное событие", summary: "Короткая сводка </script>", whyItMatters: "Важный контекст",
        verification: "unconfirmed", sourceIds: ["source-1"],
      }],
    }),
  })
  await fs.writeFile(path.join(directory, "tmp", "step12.1-market-brief.json"), JSON.stringify(brief))
  await runStep(directory)
  const store = await createReportStore({ directory: path.join(directory, "reports") })
  try {
    const [metadata] = await store.list()
    const report = await store.read(metadata.id)
    assert.deepEqual(report.marketBrief, brief)
    assert.equal(report.coins[0].movementProbability, 0.7)
    assert.equal(report.asOf, brief.marketAsOf)
    assert.notEqual(report.asOf, report.marketBrief.asOf)
    await fs.rm(path.join(directory, "tmp"), { recursive: true })
    assert.deepEqual((await store.read(metadata.id)).marketBrief, brief)
    const html = await renderReportHtml(report)
    assert.match(html, /"marketBrief":/)
    assert.match(html, /"publisher":"Original publisher"/)
    assert.ok(html.includes("Сохранённая публикация \\u003c/script>"))
    assert.ok(html.includes("Короткая сводка \\u003c/script>"))
    assert.doesNotMatch(html, /Короткая сводка <\/script>/)
  } finally {
    await store.close()
  }
})

test("a failed archive save closes its store and propagates the error", async (t) => {
  const directory = await prepareInputs(t, true)
  await runInjected(directory, `
    let closed = 0
    await assert.rejects(runReportStep({
      createStore: async () => ({
        save: async () => { throw new Error("Disk full") },
        close: async () => { closed += 1 },
      }),
    }), /Disk full/)
    assert.equal(closed, 1)
  `)
  await assert.rejects(fs.access(path.join(directory, "reports")), { code: "ENOENT" })
})

test("inconsistent inputs fail before creating an archive", async (t) => {
  const directory = await prepareInputs(t, true)
  const filename = path.join(directory, "tmp", "step6-agent-payload.json")
  const payload = JSON.parse(await fs.readFile(filename, "utf8"))
  payload.asOf = "2026-09-26T10:00:00.000Z"
  await fs.writeFile(filename, JSON.stringify(payload))
  await assert.rejects(runStep(directory), error => error.code === 1 && /same closed hourly snapshot/.test(error.stderr))
  await assert.rejects(fs.access(path.join(directory, "reports")), { code: "ENOENT" })
})
