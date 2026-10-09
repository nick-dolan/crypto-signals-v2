import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { pathToFileURL } from "node:url"
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
    "step9-agent-payload.json": {
      schemaVersion: 10, asOf, timeframe: "1h", candidateCount: candidates.length,
      objective: "P(сильное движение в следующие 4–12 часов)",
      marketContext: { breadth4h: 0.5 }, marketDefinitions: { breadth4h: "Ширина" },
      schema: { volume: ["volumeZ"] }, definitions: { volumeZ: "Аномалия объёма" }, flagDefinitions: {},
      candidates: empty ? [] : [{ symbol: coin.symbol, name: coin.name, selectionRank: 1, volume: [2.5], flags: [] }],
    },
    "step10-agent-analysis.json": {
      schemaVersion: 3, asOf, candidateCount: candidates.length,
      objective: "P(рост > 2.5 ATR в следующие 4–12 часов)",
      topCandidates: empty ? [] : [{ symbol: coin.symbol, explanation: candidates[0].explanation }],
      assessments: empty
        ? []
        : [{
            symbol: coin.symbol, movementProbability: 0.7, estimateConfidence: "medium",
            technicalSummary: { observation: "Объём растёт при сжатии диапазона.", caveat: "Направление не подтверждено." },
            drivers: ["Объём"], counterSignals: [], tradingViewUrl: "https://www.tradingview.com/",
          }],
    },
    "step7-twitter-enrichment.json": {
      asOf, newsEnrichment: window, twitterEnrichment: window, candidates,
    },
    "step8-context-enrichment.json": {
      asOf, generatedAt: "2026-09-26T12:00:00.000Z", newsEnrichment: window, twitterEnrichment: window,
      candidates: candidates.map(({ symbol }) => ({
        symbol, newsStatus: "available", twitterStatus: "empty",
        newsSummary: "Команда объявила об обновлении проекта </script>.", twitterSummary: null, contextCaveat: null,
        socialSignificant: true, socialReason: "Обновление проекта", socialSentiment: "bullish",
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

function runStep (directory, filename = "step13-report.js", env = {}) {
  return promisify(execFile)(process.execPath, [
    ...(filename === "step13-report.js" ? ["--import", `data:text/javascript,${encodeURIComponent("globalThis.fetch = async () => { throw new Error(\"Offline chart snapshot fixture\") }")}`] : []),
    new URL(`../src/${filename}`, import.meta.url).pathname,
  ], { cwd: directory, timeout: 20_000, env: { ...process.env, ...env } })
}

function runInjected (directory, code) {
  return promisify(execFile)(process.execPath, ["--input-type=module", "--eval", `
    import assert from "node:assert/strict"
    import { runReportStep } from ${JSON.stringify(new URL("../src/step13-report.js", import.meta.url).href)}
    globalThis.fetch = async () => { throw new Error("Offline chart snapshot fixture") }
    ${code}
  `], { cwd: directory, timeout: 20_000 })
}

async function readReceipt (directory) {
  return JSON.parse(await fs.readFile(path.join(directory, "tmp", "step13-report.json"), "utf8"))
}

for (const empty of [false, true]) {
  test(`step 13 archives ${empty ? "empty" : "complete"} data without HTML or independent radar files`, { timeout: 30_000 }, async (t) => {
    const directory = await prepareInputs(t, empty)
    await runStep(directory)
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
      assert.deepEqual(await readReceipt(directory), { id: metadata.id, asOf: report.asOf })
      assert.equal(report.peerRadar.status, "unavailable")
      assert.deepEqual(report.peerRadar.histories, {})
      if (!empty) {
        assert.equal(report.coins[0].features.volumeZ, 2.5)
        assert.equal(report.coins[0].movementProbability, 0.7)
        assert.equal(report.coins[0].explanation, "Техническое объяснение")
        assert.equal(report.coins[0].newsSummary, "Команда объявила об обновлении проекта </script>.")
        assert.deepEqual(report.coins[0].technicalSummary, {
          observation: "Объём растёт при сжатии диапазона.", caveat: "Направление не подтверждено.",
        })
        assert.deepEqual(report.coins[0].summary, report.coins[0].technicalSummary)
        assert.equal(report.coins[0].socialSignificant, true)
        assert.equal(report.coins[0].information.news.items[0].title, "Новость <script>")
        assert.equal(report.coins[0].history.candles[0].close, 1.5)
        assert.equal(report.coins[0].chartSnapshot.data, null)
        assert.equal(report.coins[0].chartSnapshot.quote, null)
        assert.match(report.coins[0].chartSnapshot.warning, /График при выпуске не обновлён.*Цена при выпуске не получена/)
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

test("step 13 archives a separate forming chart and release quote without changing any analysis inputs", async (t) => {
  const directory = await prepareInputs(t)
  const filenames = [
    "step2-data-bootstrap/COTI--XTVCCOTI/data.json", "step5-preliminary-filter.json",
    "step9-agent-payload.json", "step10-agent-analysis.json",
  ].map(filename => path.join(directory, "tmp", filename))
  const before = await Promise.all(filenames.map(filename => fs.readFile(filename, "utf8")))
  await runInjected(directory, `
    import { buildReportChartSnapshots } from ${JSON.stringify(new URL("../src/steps/step13-report/build-report-chart-snapshots.js", import.meta.url).href)}
    let quoteFetchedAt
    const { report } = await runReportStep({
      buildChartSnapshots: (coins, asOf) => buildReportChartSnapshots(coins, asOf, {
        updateChartHistory: async coin => {
          const formingTime = Date.parse(asOf) / 1_000 + 3_600
          return {
            history: {
              candles: [...coin.history.candles, { time: formingTime, open: 1.5, high: 3, low: 1, close: 2.5 }],
              volume: [...coin.history.volume, { time: formingTime, value: 500 }],
              openInterest: [...coin.history.openInterest, { time: formingTime, value: 42 }],
              warning: null,
            },
            updatedAt: new Date().toISOString(), formingTime, currentOiAt: new Date().toISOString(),
            sourceFrom: formingTime, oiSourceFrom: formingTime, limitReached: false,
          }
        },
        fetchQuotes: async () => {
          quoteFetchedAt = Date.now()
          return [{ symbol: "COTIUSDT", price: "2.75", time: quoteFetchedAt - 123 }]
        },
      }),
    })
    assert.ok(Date.parse(report.reportCreatedAt) >= quoteFetchedAt)
    assert.equal(report.coins[0].chartSnapshot.quote.at, new Date(quoteFetchedAt - 123).toISOString())
  `)

  const receipt = await readReceipt(directory)
  const store = await createReportStore({ directory: path.join(directory, "reports") })
  t.after(() => store.close())
  const report = await store.read(receipt.id)
  const coin = report.coins[0]
  const hour = Date.parse(report.asOf) / 1_000
  assert.equal(coin.features.volumeZ, 2.5)
  assert.equal(coin.movementProbability, 0.7)
  assert.deepEqual(coin.history.candles, [{ time: hour, open: 1, high: 2, low: 0.5, close: 1.5 }])
  assert.equal(coin.chartSnapshot.warning, null)
  assert.equal(coin.chartSnapshot.data.formingTime, hour + 3_600)
  assert.deepEqual(coin.chartSnapshot.data.history.candles, [{ time: hour + 3_600, open: 1.5, high: 3, low: 1, close: 2.5 }])
  assert.deepEqual(coin.chartSnapshot.data.history.volume, [{ time: hour + 3_600, value: 500 }])
  assert.deepEqual(coin.chartSnapshot.data.history.openInterest, [{ time: hour + 3_600, value: 42 }])
  assert.equal(coin.chartSnapshot.quote.price, 2.75)
  const html = await renderReportHtml(report)
  assert.deepEqual(JSON.parse(html.match(/<script id="report-data" type="application\/json">([\s\S]*?)<\/script>/)[1]), report)
  assert.deepEqual(await Promise.all(filenames.map(filename => fs.readFile(filename, "utf8"))), before)
  await fs.rm(path.join(directory, "tmp"), { recursive: true })
  assert.deepEqual(await store.read(receipt.id), report)
})

test("rebuilding step 13 updates the receipt without changing the previous snapshot or legacy files", { timeout: 30_000 }, async (t) => {
  const directory = await prepareInputs(t)
  await fs.mkdir(path.join(directory, "reports"))
  await fs.writeFile(path.join(directory, "reports", "legacy.html"), "Legacy report")
  await runStep(directory)
  const store = await createReportStore({ directory: path.join(directory, "reports") })
  try {
    const [first] = await store.list()
    const before = await store.read(first.id)
    assert.deepEqual(await readReceipt(directory), { id: first.id, asOf: before.asOf })
    await runStep(directory)
    const snapshots = await store.list()
    assert.equal(snapshots.length, 2)
    const second = snapshots.find(snapshot => snapshot.id !== first.id)
    assert.ok(second)
    assert.deepEqual(await readReceipt(directory), { id: second.id, asOf: (await store.read(second.id)).asOf })
    assert.deepEqual(await store.read(first.id), before)
    assert.equal(await fs.readFile(path.join(directory, "reports", "legacy.html"), "utf8"), "Legacy report")
  } finally {
    await store.close()
  }
})

test("step 13 preserves five v5 news items, sources and structured coin summaries in the archive and downloadable HTML", async (t) => {
  const directory = await prepareInputs(t)
  const brief = await buildMarketBrief("Prompt", {
    marketAsOf: "2026-09-26T11:00:00.000Z",
    collectSources: async () => ({
      from: "2026-09-26T06:00:00.000Z", asOf: "2026-09-26T12:00:00.000Z", warnings: [],
      sources: Array.from({ length: 5 }, (_, index) => ({
        id: `source-${index + 1}`, channel: "tradingview", title: `Событие ${index + 1} <script>`,
        text: "Сохранённая публикация </script>", url: `https://publisher.example/news/${index + 1}`,
        publishedAt: "2026-09-26T11:55:00.000Z", author: null, publisher: "Original publisher",
      })),
      coverage: ["tradingview", "twitter"].map(source => ({
        source, status: source === "tradingview" ? "available" : "empty",
        fetchedCount: source === "tradingview" ? 5 : 0, error: null,
      })),
    }),
    callAgent: async () => JSON.stringify({
      schemaVersion: 5, asOf: "2026-09-26T12:00:00.000Z",
      items: Array.from({ length: 5 }, (_, index) => ({
        title: `Событие ${index + 1} — обновление`,
        text: `Короткая сводка ${index + 1}`, sentiment: ["bullish", "neutral", "bearish"][index % 3],
        sourceIds: [`source-${index + 1}`],
      })),
    }),
  })
  assert.equal(brief.status, "available")
  assert.equal(brief.schemaVersion, 5)
  assert.equal(brief.items.length, 5)
  assert.deepEqual(brief.items.map(item => item.title), Array.from({ length: 5 }, (_, index) => `Событие ${index + 1} — обновление`))
  assert.deepEqual(brief.items.map(item => item.sentiment), ["bullish", "neutral", "bearish", "bullish", "neutral"])
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
    const archived = await store.read(metadata.id)
    assert.deepEqual(archived, report)
    assert.deepEqual(archived.marketBrief, brief)
    assert.deepEqual(archived.coins[0].technicalSummary, {
      observation: "Объём растёт при сжатии диапазона.", caveat: "Направление не подтверждено.",
    })
    assert.deepEqual(archived.coins[0].summary, archived.coins[0].technicalSummary)
    const html = await renderReportHtml(archived)
    assert.ok(html.includes("Сохранённая публикация \\u003c/script>"))
    assert.ok(html.includes("Событие 1 \\u003cscript>"))
    assert.doesNotMatch(html, /Сохранённая публикация <\/script>|Событие \d+ <script>/)
    const embedded = JSON.parse(html.match(/<script[^>]*id="report-data"[^>]*>([\s\S]*?)<\/script>/)[1])
    assert.deepEqual(embedded, report)
  } finally {
    await store.close()
  }
})

test("a failed archive save clears the previous receipt, closes its store and propagates the error", async (t) => {
  const directory = await prepareInputs(t, true)
  await runStep(directory)
  const previous = await readReceipt(directory)
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
  await assert.rejects(fs.access(path.join(directory, "tmp", "step13-report.json")), { code: "ENOENT" })
  assert.deepEqual(await fs.readdir(path.join(directory, "reports")), [previous.id])
})

test("inconsistent inputs clear the previous receipt before creating another archive", async (t) => {
  const directory = await prepareInputs(t, true)
  await runStep(directory)
  const previous = await readReceipt(directory)
  const filename = path.join(directory, "tmp", "step9-agent-payload.json")
  const payload = JSON.parse(await fs.readFile(filename, "utf8"))
  payload.asOf = "2026-09-26T10:00:00.000Z"
  await fs.writeFile(filename, JSON.stringify(payload))
  await assert.rejects(runStep(directory), error => error.code === 1 && /same closed hourly snapshot/.test(error.stderr))
  await assert.rejects(fs.access(path.join(directory, "tmp", "step13-report.json")), { code: "ENOENT" })
  assert.deepEqual(await fs.readdir(path.join(directory, "reports")), [previous.id])
})

for (const empty of [false, true]) {
  test(`step 13 -> 14 CLI sends the saved ${empty ? "empty" : "COTI"} snapshot as one post instead of a newer archive`, { timeout: 30_000 }, async (t) => {
    const directory = await prepareInputs(t, empty)
    await runStep(directory)
    const receipt = await readReceipt(directory)
    const store = await createReportStore({ directory: path.join(directory, "reports") })
    try {
      const report = await store.read(receipt.id)
      const newer = await store.save({
        ...report,
        reportCreatedAt: "2030-01-01T00:00:00.000Z",
        coins: report.coins.map(coin => ({ ...coin, symbol: "NEWER" })),
      })
      assert.notEqual(newer.id, receipt.id)
      assert.equal((await store.list())[0].id, newer.id)
    } finally {
      await store.close()
    }

    const preload = path.join(directory, "telegram-request-fixture.mjs")
    await fs.writeFile(preload, `
      import assert from "node:assert/strict"
      import fs from "node:fs/promises"
      globalThis.fetch = async (url, options) => {
        assert.equal(url, "https://api.telegram.org/bot123456:test-token/sendRichMessage")
        assert.equal(options.method, "POST")
        assert.equal(options.body.get("chat_id"), "-100123")
        const rich = JSON.parse(options.body.get("rich_message"))
        assert.equal(rich.media.length, ${empty ? 0 : 1})
        assert.ok(!rich.html.includes("NEWER"))
        for (const item of rich.media) {
          const file = options.body.get(item.id)
          assert.equal(file.type, "image/png")
          const png = Buffer.from(await file.arrayBuffer())
          assert.deepEqual(png.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
        }
        await fs.appendFile("telegram-requests.jsonl", JSON.stringify(rich) + "\\n")
        return new Response(JSON.stringify({ ok: true, result: { message_id: 77, chat: { id: -100123 } } }))
      }
    `)
    const env = {
      TELEGRAM_BOT_TOKEN: "123456:test-token", TELEGRAM_CHAT_ID: "-100123",
      NODE_OPTIONS: `--import ${pathToFileURL(preload).href}`,
    }
    await runStep(directory, "step14-telegram.js", env)
    const output = path.join(directory, "output", "telegram-preview")
    const releases = await fs.readdir(output)
    assert.equal(releases.length, 1)
    const release = path.join(output, releases[0])
    const manifest = JSON.parse(await fs.readFile(path.join(release, "release.json"), "utf8"))
    assert.equal(manifest.source, `reports/${receipt.id}`)
    assert.equal(manifest.asOf, receipt.asOf)
    assert.equal(manifest.demo, false)
    assert.deepEqual(manifest.candidates.map(candidate => candidate.symbol), empty ? [] : ["COTI"])
    assert.deepEqual((await fs.readdir(path.join(release, "cards"))).sort(), manifest.candidates.flatMap(({ image }) => [
      path.basename(image), path.basename(image.replace(/\.png$/, ".svg")),
    ]).sort())
    await fs.access(path.join(release, "index.html"))
    assert.deepEqual(await readReceipt(directory), receipt)
    const delivered = JSON.parse(await fs.readFile(path.join(directory, "output", "telegram-delivery", `${receipt.id}.json`), "utf8"))
    assert.equal(delivered.status, "sent")
    assert.equal(delivered.reportId, receipt.id)
    assert.equal(delivered.messageId, 77)
    await runStep(directory, "step14-telegram.js", env)
    const requests = (await fs.readFile(path.join(directory, "telegram-requests.jsonl"), "utf8")).trim().split("\n")
    assert.equal(requests.length, 2)
    assert.deepEqual(requests.map(request => JSON.parse(request)), [manifest.richMessage, manifest.richMessage])
  })
}

test("missing Telegram configuration fails step 14 but preserves its local preview and step 13 archive", async (t) => {
  const directory = await prepareInputs(t, true)
  await runStep(directory)
  const receipt = await readReceipt(directory)
  await assert.rejects(runStep(directory, "step14-telegram.js", { TELEGRAM_BOT_TOKEN: "", TELEGRAM_CHAT_ID: "" }), (error) => {
    assert.equal(error.code, 1)
    assert.match(error.stderr, /Telegram bot token is required/)
    assert.doesNotMatch(error.stdout, /Telegram post sent/)
    return true
  })
  assert.deepEqual(await readReceipt(directory), receipt)
  assert.deepEqual(await fs.readdir(path.join(directory, "reports")), [receipt.id])
  const output = path.join(directory, "output", "telegram-preview")
  const [folder] = await fs.readdir(output)
  await fs.access(path.join(output, folder, "index.html"))
  await fs.access(path.join(output, folder, "release.json"))
  await assert.rejects(fs.access(path.join(directory, "output", "telegram-delivery")), { code: "ENOENT" })
})
