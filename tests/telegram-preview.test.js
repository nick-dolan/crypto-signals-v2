import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import { createDemoReport } from "../src/reports/coin-card/create-demo-report.js"
import { buildTelegramRelease } from "../src/reports/telegram/build-telegram-release.js"
import { writeTelegramPreview } from "../src/reports/telegram/preview.js"
import { renderTelegramPreview } from "../src/reports/telegram/render-telegram-preview.js"

async function temporaryDirectory (t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "telegram-preview-"))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  return directory
}

function reportWithCoins (count = 14) {
  const report = createDemoReport()
  const coins = Array.from({ length: count }, (_, index) => {
    const coin = structuredClone(report.coins[0])
    const symbol = `DEMO-${String(index + 1).padStart(2, "0")}`
    return {
      ...coin,
      symbol,
      name: `Вымышленная монета ${index + 1}`,
      marketSymbol: `ПРИМЕР · ${symbol} / USDT`,
      topRank: index < 3 ? index + 1 : null,
      movementProbability: (78 - index * 2) / 100,
      explanation: `Пример для ${symbol}: объём и Open Interest растут. Все значения синтетические.`,
      drivers: ["Пример: сжатие волатильности"],
      counterSignals: ["Пример: всплеск объёма может оказаться кратковременным"],
      socialSignificant: index < 7,
      socialSentiment: index < 7 ? "positive" : null,
      socialReason: index < 7 ? "Вымышленный пример: тестовое обновление, не настоящая новость." : "Демо: инфоповод не задан.",
      features: {
        ...coin.features,
        coingeckoId: `demo-example-${index + 1}`,
        coingeckoTrending: index === 0 || index === 4 || index >= 7,
        coingeckoTrendingCategories: index === 0 || index === 4 || index >= 7 ? ["Пример: вымышленная категория"] : [],
      },
    }
  })
  return {
    ...report,
    demo: true,
    reportCreatedAt: "2026-10-01T10:05:00.000Z",
    candidateCount: count,
    universeCoinCount: count,
    coins,
    marketBrief: {
      schemaVersion: 2, marketAsOf: report.asOf,
      asOf: "2026-10-01T10:00:00.000Z", from: "2026-10-01T04:00:00.000Z", generatedAt: "2026-10-01T10:05:00.000Z",
      status: "available", warning: "ДЕМО: вымышленные примеры, не реальные новости.",
      coverage: [], sources: [],
      paragraphs: [{ text: "ДЕМО. Вымышленная сводка для проверки оформления, не описание реального рынка.", sourceIds: [] }],
    },
  }
}

test("writes ten unique real PNGs, SVGs, manifest and offline HTML; a one-photo rerun uses a fresh folder", async (t) => {
  const directory = await temporaryDirectory(t)
  const syntheticReport = reportWithCoins()
  const original = structuredClone(syntheticReport)
  const result = await writeTelegramPreview(syntheticReport, { directory, source: "Синтетический отчёт" })
  assert.deepEqual(syntheticReport, original)
  const json = await fs.readFile(result.manifestPath, "utf8")
  const manifest = JSON.parse(json)
  const html = await fs.readFile(result.previewPath, "utf8")
  assert.deepEqual(manifest, { ...buildTelegramRelease(original), source: "Синтетический отчёт" })
  assert.equal(result.candidateCount, 10)
  assert.equal(result.messageCount, manifest.messages.length)
  assert.equal(result.demo, true)
  assert.ok(manifest.eligibleCount > 10)
  assert.equal(manifest.omittedCount, manifest.eligibleCount - 10)
  assert.equal(new Set(manifest.candidates.map(item => item.symbol)).size, 10)
  assert.equal(new Set(manifest.candidates.map(item => item.image)).size, 10)
  assert.deepEqual(new Set(manifest.candidates.map(item => item.section)), new Set(["top", "positive", "coingecko"]))
  assert.equal(path.dirname(result.directory), directory)
  assert.match(path.basename(result.directory), /^release-/)
  assert.equal(result.previewPath, path.join(result.directory, "index.html"))
  assert.equal(result.manifestPath, path.join(result.directory, "release.json"))
  assert.deepEqual((await fs.readdir(result.directory)).sort(), ["cards", "index.html", "release.json"])
  assert.doesNotMatch(json, /"(?:coins|history|candles)"\s*:/)
  assert.match(html, /Локальное превью · Не отправлено/)
  assert.match(html, /ДЕМО · СИНТЕТИЧЕСКИЕ ДАННЫЕ/)
  assert.match(html, /Кандидаты: 10 \/ 10/)
  assert.ok(html.includes(`Не включено: ${manifest.omittedCount}`))
  assert.match(html, /не точная попиксельная имитация альбома Telegram/)
  assert.match(html, /Топ-кандидаты/)
  assert.match(html, /Позитивный инфоповод/)
  assert.match(html, /В тренде CoinGecko/)
  assert.match(html, /max-width: 720px/)
  assert.match(html, /grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/)
  assert.match(html, /@media[\s\S]*grid-template-columns: 1fr/)
  assert.doesNotMatch(html, /<script\b|@import|url\(/i)
  assert.doesNotMatch(html, /<(?:img|link)\b[^>]*(?:src|href)="(?:https?:)?\/\//i)

  for (const [index, item] of manifest.candidates.entries()) {
    assert.equal(item.number, index + 1)
    assert.match(item.image, /^cards\/\d{2}-[a-z\d_-]+\.png$/i)
    assert.ok(item.image.startsWith(`cards/${String(index + 1).padStart(2, "0")}-`))
    assert.ok(item.caption.length <= 1024)
    assert.equal(item.parse_mode, "HTML")
    assert.ok(html.includes(`<h3>#${item.number} · ${item.symbol}</h3>`))
    assert.ok(html.includes(`src="${item.image}"`))
    assert.ok(html.includes(`<div class="telegram-html">${item.caption}</div>`))
    const png = await fs.readFile(path.join(result.directory, item.image))
    assert.deepEqual(png.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    assert.equal(png.readUInt32BE(16), 1200)
    assert.equal(png.readUInt32BE(20), 1280)
    const svg = await fs.readFile(path.join(result.directory, item.image.replace(/\.png$/, ".svg")), "utf8")
    assert.match(svg, /^<svg\b/)
    assert.ok(svg.includes(item.symbol))
    assert.match(svg, /ДЕМО · СИНТЕТИЧЕСКИЕ ДАННЫЕ/)
  }
  for (const message of manifest.messages) {
    assert.ok(message.text.length <= 4096)
    assert.equal(message.parse_mode, "HTML")
    assert.deepEqual(message.link_preview_options, { is_disabled: true })
    assert.ok(html.includes(`<div class="telegram-html">${message.text}</div>`))
  }
  const report = reportWithCoins(1)
  const before = structuredClone(report)
  const next = await writeTelegramPreview(report, { directory, source: "local example" })
  const nextManifest = JSON.parse(await fs.readFile(next.manifestPath, "utf8"))
  assert.equal(next.candidateCount, 1)
  assert.notEqual(next.directory, result.directory)
  assert.deepEqual(report, before)
  assert.equal(nextManifest.source, "local example")
  assert.deepEqual((await fs.readdir(path.join(next.directory, "cards"))).sort(), [
    path.basename(nextManifest.candidates[0].image), path.basename(nextManifest.candidates[0].image.replace(/\.png$/, ".svg")),
  ].sort())
  assert.equal((await fs.readdir(path.join(result.directory, "cards"))).length, 20)
  assert.equal(await fs.readFile(result.manifestPath, "utf8"), json)
  assert.equal(await fs.readFile(result.previewPath, "utf8"), html)
})

test("zero candidates produces an explicit empty preview without invented photos", async (t) => {
  const result = await writeTelegramPreview(reportWithCoins(0), { directory: await temporaryDirectory(t) })
  const manifest = JSON.parse(await fs.readFile(result.manifestPath, "utf8"))
  assert.equal(result.candidateCount, 0)
  assert.deepEqual(manifest.candidates, [])
  assert.equal(manifest.source, null)
  assert.deepEqual(await fs.readdir(path.join(result.directory, "cards")), [])
  const html = await fs.readFile(result.previewPath, "utf8")
  assert.match(html, /Кандидаты: 0 \/ 10/)
  assert.match(html, /Подходящих кандидатов нет/)
  assert.doesNotMatch(html, /<img\b/)
})

test("renderer escapes all metadata while preserving trusted message and caption HTML", () => {
  const unsafe = "<img src=x onerror=alert(1)> & \"'"
  const manifest = {
    schemaVersion: 1, asOf: unsafe, closedAt: unsafe, demo: false,
    eligibleCount: unsafe, omittedCount: unsafe, source: `javascript:alert(1) ${unsafe}`,
    candidates: [{
      symbol: unsafe, section: unsafe, coinIndex: 0, number: unsafe, image: "cards/01-DEMO.png",
      caption: "<b>Подпись</b>\n<i>Оговорка</i> <a href=\"https://example.com\">Пример</a>", parse_mode: "HTML",
    }],
    messages: [{ text: "<b>Сводка</b>\n<i>Пример</i> <a href=\"https://example.com\">Источник</a>", parse_mode: "HTML", link_preview_options: { is_disabled: true } }],
  }
  const html = renderTelegramPreview(manifest)
  assert.ok(!html.includes(unsafe))
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt; &amp; &quot;&#39;/)
  assert.match(html, /Источник: <span>javascript:alert\(1\) &lt;img/)
  assert.ok(html.includes(manifest.messages[0].text))
  assert.ok(html.includes(manifest.candidates[0].caption))
  assert.doesNotMatch(html, /<script\b|<img src=x|href="javascript:/)
})

test("invalid reports and builder errors do not create a release directory", async (t) => {
  const directory = path.join(await temporaryDirectory(t), "not-created")
  for (const report of [null, [], {}, { coins: null }, { coins: [null] }, { coins: [[]] }]) {
    await assert.rejects(writeTelegramPreview(report, { directory }), /coins/)
  }
  await assert.rejects(writeTelegramPreview({ ...reportWithCoins(0), timeframe: "4h" }, { directory }), /asOf|timeframe|hour|час|1h/i)
  await assert.rejects(fs.stat(directory), { code: "ENOENT" })
})

test("a late artifact failure removes only the new folder and preserves earlier output", async (t) => {
  const directory = await temporaryDirectory(t)
  const previous = await writeTelegramPreview(reportWithCoins(1), { directory })
  const previousJson = await fs.readFile(previous.manifestPath, "utf8")
  const previousHtml = await fs.readFile(previous.previewPath, "utf8")
  const image = path.join(previous.directory, JSON.parse(previousJson).candidates[0].image)
  const previousPng = await fs.readFile(image)
  const previousSvg = await fs.readFile(image.replace(/\.png$/, ".svg"), "utf8")
  const entries = (await fs.readdir(directory)).sort()
  const writeFile = fs.writeFile.bind(fs)
  const written = []
  t.mock.method(fs, "writeFile", async (filename, ...args) => {
    if (path.basename(filename) === "index.html") {
      throw new Error("simulated disk failure")
    }
    await writeFile(filename, ...args)
    written.push(filename)
  })
  const report = reportWithCoins(1)
  const before = structuredClone(report)
  await assert.rejects(writeTelegramPreview(report, { directory }), /simulated disk failure/)
  assert.deepEqual(report, before)
  assert.ok(written.some(filename => filename.endsWith(".png")))
  assert.ok(written.some(filename => filename.endsWith(".svg")))
  assert.ok(written.some(filename => filename.endsWith("release.json")))
  assert.deepEqual((await fs.readdir(directory)).sort(), entries)
  assert.equal(await fs.readFile(previous.manifestPath, "utf8"), previousJson)
  assert.equal(await fs.readFile(previous.previewPath, "utf8"), previousHtml)
  assert.deepEqual(await fs.readFile(image), previousPng)
  assert.equal(await fs.readFile(image.replace(/\.png$/, ".svg"), "utf8"), previousSvg)
})
