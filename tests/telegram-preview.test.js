import assert from "node:assert/strict"
import fs from "node:fs/promises"
import http from "node:http"
import https from "node:https"
import os from "node:os"
import path from "node:path"
import test, { beforeEach } from "node:test"

import { createDemoReport } from "../src/reports/coin-card/create-demo-report.js"
import { buildTelegramRelease } from "../src/reports/telegram/build-telegram-release.js"
import { writeTelegramPreview } from "../src/reports/telegram/preview.js"
import { renderTelegramPreview } from "../src/reports/telegram/render-telegram-preview.js"

beforeEach((t) => {
  const requests = [[globalThis, "fetch"], [http, "request"], [http, "get"], [https, "request"], [https, "get"]]
    .map(([target, method]) => t.mock.method(target, method, () => assert.fail("Unexpected network request")))
  t.after(() => requests.forEach(request => assert.equal(request.mock.callCount(), 0)))
})

function assertPreviewPost (html, manifest) {
  assert.equal([...html.matchAll(/<article\b/gu)].length, 1)
  const match = html.match(/<article class="bubble" aria-label="Один пост">\s*<div class="telegram-html">([\s\S]*?)<\/div>\s*<\/article>/u)
  assert.ok(match, "One rich post must be displayed in a single bubble")
  const post = match[1]
  assert.deepEqual([...post.matchAll(/<img src="([^"]+)"/gu)].map(([, image]) => image), manifest.candidates.map(item => item.image))
  if (manifest.candidates.length > 1) {
    assert.ok(post.startsWith("<div class=\"photo-grid\"><img "))
    assert.equal([...post.matchAll(/class="photo-grid"/gu)].length, 1)
    assert.ok(post.indexOf("</div>") < post.indexOf("<p>"))
  } else {
    assert.ok(post.startsWith(manifest.candidates.length ? "<img " : "<p>"))
    assert.doesNotMatch(post, /class="photo-grid"/u)
  }
  const body = post.slice(post.indexOf("<p>"))
  assert.equal(body, manifest.richMessage.html.slice(manifest.richMessage.html.indexOf("<p>")), "Preview must preserve all trusted text HTML exactly")
  assert.doesNotMatch(body, /<img\b/u, "Every photo must precede the explanatory text")
  assert.doesNotMatch(post, /tg-collage|tg:\/\/photo|attach:\/\//u)
  assert.doesNotMatch(html, /<script\b|@import|url\(|<(?:iframe|object|embed|audio|video|source)\b/iu)
  assert.doesNotMatch(html, /<(?:img|link)\b[^>]*(?:src|href)="(?:https?:)?\/\//iu)
  assert.match(html, /default-src 'none'; img-src 'self'/u)
}

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
      technicalExplanation: `Пример для ${symbol}: объём и Open Interest растут. Все значения синтетические.`,
      explanation: index < 3
        ? `Пример для ${symbol}: объём и Open Interest растут. Вымышленный инфоповод уточняет оценку.`
        : index < 7 ? `Вымышленный инфоповод для ${symbol}, без технического сигнала.` : `PRIVATE-ENRICHED-${symbol}`,
      drivers: ["Пример: сжатие волатильности"],
      counterSignals: ["Пример: всплеск объёма может оказаться кратковременным"],
      socialSignificant: index < 7,
      socialSentiment: index < 7 ? index % 2 ? "negative" : "positive" : null,
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

test("fourteen input coins produce seven qualifying PNGs and SVGs, no CoinGecko-only images, and an offline preview; reruns use fresh folders", async (t) => {
  const directory = await temporaryDirectory(t)
  const syntheticReport = reportWithCoins()
  const original = structuredClone(syntheticReport)
  const result = await writeTelegramPreview(syntheticReport, { directory, source: "Синтетический отчёт" })
  assert.deepEqual(syntheticReport, original)
  const json = await fs.readFile(result.manifestPath, "utf8")
  const manifest = JSON.parse(json)
  const html = await fs.readFile(result.previewPath, "utf8")
  assert.deepEqual(manifest, { ...buildTelegramRelease(original), source: "Синтетический отчёт" })
  assert.equal(original.coins.length, 14)
  assert.equal(result.candidateCount, 7)
  assert.equal(result.messageCount, 1)
  assert.equal(manifest.schemaVersion, 2)
  assert.equal(manifest.richMessage.media.length, 7)
  assert.equal(Object.hasOwn(manifest, "messages"), false)
  assert.equal(result.asOf, original.asOf)
  assert.equal(result.omittedCount, manifest.omittedCount)
  assert.equal(result.demo, true)
  assert.equal(manifest.eligibleCount, 7)
  assert.equal(manifest.omittedCount, 0)
  assert.equal(new Set(manifest.candidates.map(item => item.symbol)).size, 7)
  assert.equal(new Set(manifest.candidates.map(item => item.image)).size, 7)
  assert.deepEqual(manifest.candidates.map(item => item.coinIndex), [0, 1, 2, 3, 4, 5, 6])
  assert.deepEqual(manifest.candidates.map(item => item.symbol), original.coins.slice(0, 7).map(coin => coin.symbol))
  assert.deepEqual(manifest.candidates.map(item => item.section), ["top", "top", "top", "news", "news", "news", "news"])
  assert.deepEqual(manifest.candidates.slice(3).map(item => original.coins[item.coinIndex].socialSentiment), ["negative", "positive", "negative", "positive"])
  assert.equal(path.dirname(result.directory), directory)
  assert.match(path.basename(result.directory), /^release-/)
  assert.equal(result.previewPath, path.join(result.directory, "index.html"))
  assert.equal(result.manifestPath, path.join(result.directory, "release.json"))
  assert.deepEqual((await fs.readdir(result.directory)).sort(), ["cards", "index.html", "release.json"])
  assert.doesNotMatch(json, /"(?:coins|history|candles)"\s*:/)
  assert.match(html, /Локальное превью · Один пост/)
  assert.match(html, /Сообщения: 1/)
  assert.doesNotMatch(html, /Не отправлено|Подпись к фото|Фото и подписи/u)
  assert.match(html, /ДЕМО · СИНТЕТИЧЕСКИЕ ДАННЫЕ/)
  assert.match(html, /Кандидаты: 7<\/span>/)
  assert.doesNotMatch(html, /Кандидаты: \d+ \/ 10/)
  assert.ok(html.includes(`Не включено: ${manifest.omittedCount}`))
  assert.match(html, /Точное отображение в клиентах Telegram не гарантируется/)
  assert.match(html, /<p><b>Новостная сводка за последние 6 часов<\/b><\/p>\n<p><br><\/p>\n<p>• ДЕМО\./u)
  assert.match(html, /<p><b>Топ агента<\/b><\/p>/u)
  assert.match(html, /<p><b>📰 Значимые инфоповоды<\/b><\/p>/u)
  assert.doesNotMatch(html, /· · ·|<p>- <code>|[🟩⬜🟥]|<b>(?:📰 Новостная сводка|⭐ Топ агента)/u)
  assert.doesNotMatch(html, /CoinGecko Trending|🟢 Позитивные инфоповоды|PRIVATE-ENRICHED|P движения|уверенность|Категории:|<a /u)
  assert.deepEqual([...manifest.richMessage.html.matchAll(/<p>(• <code>[\s\S]*?)<\/p>/gu)].map(([, text]) => text), original.coins.slice(0, 7)
    .map(coin => `• <code>${coin.symbol}</code> ${coin.name} — ${coin.explanation}`))
  assert.equal(manifest.richMessage.html.slice(manifest.richMessage.html.indexOf("<p><b>Топ агента</b></p>")), [
    "<p><b>Топ агента</b></p>", "<p><br></p>",
    original.coins.slice(0, 3).map(coin => `<p>• <code>${coin.symbol}</code> ${coin.name} — ${coin.explanation}</p>`).join("\n<p><br></p>\n"),
    "<p><br></p>", "<p><b>📰 Значимые инфоповоды</b></p>",
    original.coins.slice(3, 7).map(coin => `<p>• <code>${coin.symbol}</code> ${coin.name} — ${coin.explanation}</p>`).join("\n<p><br></p>\n"),
  ].join("\n"))
  assert.match(html, /max-width: 720px/)
  assert.match(html, /grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/)
  assert.match(html, /@media[\s\S]*grid-template-columns: 1fr/)
  assert.doesNotMatch(html, /<script\b|@import|url\(/i)
  assert.doesNotMatch(html, /<(?:img|link)\b[^>]*(?:src|href)="(?:https?:)?\/\//i)

  for (const [index, item] of manifest.candidates.entries()) {
    assert.equal(item.number, index + 1)
    assert.match(item.image, /^cards\/\d{2}-[a-z\d_-]+\.png$/i)
    assert.ok(item.image.startsWith(`cards/${String(index + 1).padStart(2, "0")}-`))
    assert.equal(item.mediaId, `card_${index + 1}`)
    assert.deepEqual(manifest.richMessage.media[index], { id: item.mediaId, media: { type: "photo", media: `attach://${item.mediaId}` } })
    assert.equal(Object.hasOwn(item, "caption"), false)
    assert.equal(Object.hasOwn(item, "parse_mode"), false)
    assert.ok(html.includes(`alt="Карточка #${item.number} · ${item.symbol}"`))
    assert.ok(html.includes(`src="${item.image}"`))
    const png = await fs.readFile(path.join(result.directory, item.image))
    assert.deepEqual(png.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    assert.equal(png.readUInt32BE(16), 1200)
    assert.equal(png.readUInt32BE(20), 1280)
    const svg = await fs.readFile(path.join(result.directory, item.image.replace(/\.png$/, ".svg")), "utf8")
    assert.match(svg, /^<svg\b/)
    assert.ok(svg.includes(item.symbol))
    assert.match(svg, /ДЕМО · СИНТЕТИЧЕСКИЕ ДАННЫЕ/)
  }
  assertPreviewPost(html, manifest)
  const artifacts = (await fs.readdir(path.join(result.directory, "cards"))).sort()
  assert.deepEqual(artifacts, manifest.candidates.flatMap(item => [path.basename(item.image), path.basename(item.image.replace(/\.png$/, ".svg"))]).sort())
  for (const coin of original.coins.slice(7)) {
    assert.equal(coin.features.coingeckoTrending, true)
    assert.equal(coin.socialSignificant, false)
    assert.ok(!json.includes(coin.symbol))
    assert.ok(!html.includes(coin.symbol))
    assert.ok(artifacts.every(filename => !filename.includes(coin.symbol)))
  }
  const report = reportWithCoins(1)
  const before = structuredClone(report)
  const next = await writeTelegramPreview(report, { directory, source: "local example" })
  const nextManifest = JSON.parse(await fs.readFile(next.manifestPath, "utf8"))
  assert.equal(next.candidateCount, 1)
  assert.equal(next.messageCount, 1)
  assert.equal(nextManifest.richMessage.html.slice(nextManifest.richMessage.html.indexOf("<p><b>Топ агента</b></p>")), [
    "<p><b>Топ агента</b></p>", "<p><br></p>",
    `<p>• <code>DEMO-01</code> Вымышленная монета 1 — ${report.coins[0].explanation}</p>`,
  ].join("\n"))
  assert.doesNotMatch(nextManifest.richMessage.html, /Значимые инфоповоды|В выпуске нет дополнительных монет|· · ·/u)
  assertPreviewPost(await fs.readFile(next.previewPath, "utf8"), nextManifest)
  assert.notEqual(next.directory, result.directory)
  assert.deepEqual(report, before)
  assert.equal(nextManifest.source, "local example")
  assert.deepEqual((await fs.readdir(path.join(next.directory, "cards"))).sort(), [
    path.basename(nextManifest.candidates[0].image), path.basename(nextManifest.candidates[0].image.replace(/\.png$/, ".svg")),
  ].sort())
  assert.equal((await fs.readdir(path.join(result.directory, "cards"))).length, 14)
  assert.equal(await fs.readFile(result.manifestPath, "utf8"), json)
  assert.equal(await fs.readFile(result.previewPath, "utf8"), html)
})

test("preview preserves uniform news bullets, blank lines and only the significant-events heading emoji", () => {
  const report = reportWithCoins(4)
  report.marketBrief = {
    ...report.marketBrief, schemaVersion: 4,
    items: ["bullish", "neutral", "bearish"].map((sentiment, index) => ({ text: `Новость ${index + 1}.`, sentiment, sourceIds: ["s"] })),
    sources: [{ id: "s", url: "https://news.example/s" }],
  }
  const before = structuredClone(report)
  const manifest = buildTelegramRelease(report)
  const beforeManifest = structuredClone(manifest)
  const html = renderTelegramPreview(manifest)
  assertPreviewPost(html, manifest)
  assert.ok(html.includes([
    "<p><b>Новостная сводка за последние 6 часов</b></p>", "<p><br></p>",
    [1, 2, 3].map(number => `<p>• Новость ${number}. <a href="https://news.example/s">[1]</a></p>`).join("\n<p><br></p>\n"),
    "<p>⚠ ДЕМО: вымышленные примеры, не реальные новости.</p>", "<p><br></p>",
    "<p><b>Топ агента</b></p>", "<p><br></p>", "<p>• <code>DEMO-01</code>",
  ].join("\n")))
  assert.ok(html.includes("<p><br></p>\n<p><b>📰 Значимые инфоповоды</b></p>\n<p>• <code>DEMO-04</code>"))
  assert.doesNotMatch(html, /· · ·|<p>- <code>|[🟩⬜🟥]|• •|<b>(?:📰 Новостная сводка|⭐ Топ агента)/u)
  assert.deepEqual(report, before)
  assert.deepEqual(manifest, beforeManifest)
})

test("zero candidates produces an explicit empty preview without invented photos", async (t) => {
  const result = await writeTelegramPreview(reportWithCoins(0), { directory: await temporaryDirectory(t) })
  const manifest = JSON.parse(await fs.readFile(result.manifestPath, "utf8"))
  assert.equal(result.candidateCount, 0)
  assert.equal(result.messageCount, 1)
  assert.deepEqual(manifest.candidates, [])
  assert.deepEqual(manifest.richMessage.media, [])
  assert.equal(manifest.source, null)
  assert.deepEqual(await fs.readdir(path.join(result.directory, "cards")), [])
  const html = await fs.readFile(result.previewPath, "utf8")
  assert.match(html, /Кандидаты: 0<\/span>/)
  assert.match(html, /Агент не выделил убедительных ранних кандидатов/)
  assert.equal(manifest.richMessage.html.slice(manifest.richMessage.html.indexOf("<p><b>Топ агента</b></p>")), "<p><b>Топ агента</b></p>\n<p><br></p>\n<p>Агент не выделил убедительных ранних кандидатов.</p>")
  assert.doesNotMatch(html, /<img\b|CoinGecko Trending|🟢 Позитивные инфоповоды|Значимые инфоповоды|В выпуске нет дополнительных монет|· · ·/u)
  assertPreviewPost(html, manifest)
})

test("a single news candidate follows the empty top with one preceding blank line and no gap after the news heading", () => {
  const report = reportWithCoins(1)
  Object.assign(report.coins[0], { topRank: null, explanation: "Готовый инфоповод." })
  const before = structuredClone(report)
  const manifest = buildTelegramRelease(report)
  const html = renderTelegramPreview(manifest)
  assertPreviewPost(html, manifest)
  assert.deepEqual(manifest.candidates.map(item => item.section), ["news"])
  assert.equal(manifest.richMessage.html.slice(manifest.richMessage.html.indexOf("<p><b>Топ агента</b></p>")), [
    "<p><b>Топ агента</b></p>", "<p><br></p>", "<p>Агент не выделил убедительных ранних кандидатов.</p>",
    "<p><br></p>", "<p><b>📰 Значимые инфоповоды</b></p>",
    "<p>• <code>DEMO-01</code> Вымышленная монета 1 — Готовый инфоповод.</p>",
  ].join("\n"))
  assert.doesNotMatch(html, /· · ·|В выпуске нет дополнительных монет/u)
  assert.deepEqual(report, before)
})

test("preview omits the entire news section and its spacing after symbol and canonical ID deduplication", () => {
  const report = reportWithCoins(3)
  Object.assign(report.coins[0], { baseCurrencyId: "DEMO-ID", explanation: "Готовое объяснение." })
  Object.assign(report.coins[1], { topRank: null, symbol: " demo-01 ", baseCurrencyId: "OTHER-ID" })
  Object.assign(report.coins[2], { topRank: null, symbol: "ALIAS", baseCurrencyId: " DEMO-ID " })
  const before = structuredClone(report)
  const manifest = buildTelegramRelease(report)
  const html = renderTelegramPreview(manifest)
  assertPreviewPost(html, manifest)
  assert.deepEqual(manifest.candidates.map(({ coinIndex, section }) => [coinIndex, section]), [[0, "top"]])
  assert.equal(manifest.richMessage.html.slice(manifest.richMessage.html.indexOf("<p><b>Топ агента</b></p>")), [
    "<p><b>Топ агента</b></p>", "<p><br></p>",
    "<p>• <code>DEMO-01</code> Вымышленная монета 1 — Готовое объяснение.</p>",
  ].join("\n"))
  assert.equal(html, renderTelegramPreview(buildTelegramRelease({ ...report, coins: [report.coins[0]] })))
  assert.doesNotMatch(html, /Значимые инфоповоды|В выпуске нет дополнительных монет|· · ·/u)
  assert.deepEqual(report, before)
})

test("renderer escapes all metadata while preserving trusted rich text HTML without mutation", () => {
  const unsafe = "<img src=x onerror=alert(1)> & \"'"
  const text = "<p><b>Сводка</b><br><i>Пример</i> <a href=\"https://example.com\">Источник</a></p>\n<p>• <code>DEMO&lt;&amp;</code> &lt;code&gt;Имя&lt;/code&gt;</p>"
  const manifest = {
    schemaVersion: 2, asOf: unsafe, closedAt: unsafe, demo: false,
    eligibleCount: unsafe, omittedCount: unsafe, source: `javascript:alert(1) ${unsafe}`,
    candidates: [{
      symbol: unsafe, section: unsafe, coinIndex: 0, number: unsafe, image: "cards/01-DEMO.png", mediaId: "card_1",
    }],
    richMessage: {
      html: `<img src="tg://photo?id=card_1"/>${text}`,
      media: [{ id: "card_1", media: { type: "photo", media: "attach://card_1" } }],
    },
  }
  const before = structuredClone(manifest)
  const html = renderTelegramPreview(manifest)
  assert.deepEqual(manifest, before)
  assert.ok(!html.includes(unsafe))
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt; &amp; &quot;&#39;/)
  assert.match(html, /Источник: <span>javascript:alert\(1\) &lt;img/)
  assert.match(html, /alt="Карточка #&lt;img src=x onerror=alert\(1\)&gt;/u)
  assert.ok(html.includes(text))
  assert.doesNotMatch(html, /<script\b|<img src=x|href="javascript:/)
  assertPreviewPost(html, manifest)
})

test("preview preserves technical-only, enriched and legacy heading-only paragraphs with links only on names", () => {
  const report = reportWithCoins(3)
  report.demo = false
  Object.assign(report.coins[0], {
    socialSignificant: false, technicalExplanation: "Чистое техническое описание.",
    explanation: "Чистое техническое описание. PRIVATE-INSIGNIFICANT-SOCIAL", socialReason: "PRIVATE-SOCIAL",
  })
  Object.assign(report.coins[1], { socialSignificant: null, name: null, explanation: "PRIVATE-LEGACY-ENRICHED" })
  delete report.coins[1].technicalExplanation
  Object.assign(report.coins[2], {
    socialSignificant: true, socialSentiment: "mixed", technicalExplanation: "PRIVATE-TECHNICAL",
    explanation: "Готовая техника вместе со значимым смешанным фоном.", socialReason: "PRIVATE-DUPLICATED-SOCIAL",
  })
  const before = structuredClone(report)
  const manifest = buildTelegramRelease(report)
  const html = renderTelegramPreview(manifest)
  assertPreviewPost(html, manifest)
  assert.deepEqual([...manifest.richMessage.html.matchAll(/<p>(• <code>[\s\S]*?)<\/p>/gu)].map(([, text]) => text), [
    `• <code>DEMO-01</code> <a href="https://www.tradingview.com/chart/?symbol=${encodeURIComponent(report.coins[0].marketSymbol)}">Вымышленная монета 1</a> — Чистое техническое описание.`,
    "• <code>DEMO-02</code>",
    `• <code>DEMO-03</code> <a href="https://www.tradingview.com/chart/?symbol=${encodeURIComponent(report.coins[2].marketSymbol)}">Вымышленная монета 3</a> — Готовая техника вместе со значимым смешанным фоном.`,
  ])
  assert.doesNotMatch(html, /PRIVATE-|P движения|уверенность|CoinGecko Trending/u)
  assert.deepEqual(report, before)
})

test("preview resolves images by rich media ID and preserves the HTML photo order", () => {
  const manifest = buildTelegramRelease(reportWithCoins(2))
  const images = manifest.candidates.map(item => item.image)
  manifest.candidates.reverse()
  const before = structuredClone(manifest)
  const html = renderTelegramPreview(manifest)
  assert.deepEqual([...html.matchAll(/<img src="([^"]+)"/gu)].map(([, image]) => image), images)
  assert.deepEqual(manifest, before)
})

test("preview refuses missing photo mappings and non-local card paths", () => {
  for (const image of ["https://remote.example/card.png", "//remote.example/card.png", "file:///tmp/card.png", "/tmp/card.png", "cards/../../card.png", "cards/x.png\" onerror=\"alert(1)"]) {
    const manifest = buildTelegramRelease(reportWithCoins(1))
    manifest.candidates[0].image = image
    assert.throws(() => renderTelegramPreview(manifest), /Нет локальной карточки/u)
  }
  const manifest = buildTelegramRelease(reportWithCoins(1))
  manifest.candidates[0].mediaId = "card_2"
  assert.throws(() => renderTelegramPreview(manifest), /Нет локальной карточки.*card_1/u)
})

test("one-photo preview keeps a valid rich post above 1024 and 4096 characters without caption truncation", async (t) => {
  const report = reportWithCoins(1)
  const long = "Наблюдение за активностью без обещания направления. ".repeat(100)
  Object.assign(report.coins[0], {
    technicalExplanation: "PRIVATE-TECHNICAL", explanation: long, socialReason: "PRIVATE-SOCIAL", counterSignals: [long, long],
    features: { ...report.coins[0].features, coingeckoTrendingCategories: [long] },
  })
  report.marketBrief = {
    ...report.marketBrief, schemaVersion: 1,
    events: Array.from({ length: 3 }, () => ({ summary: long, verification: "confirmed", sourceIds: [] })),
  }
  const before = structuredClone(report)
  const result = await writeTelegramPreview(report, { directory: await temporaryDirectory(t) })
  const manifest = JSON.parse(await fs.readFile(result.manifestPath, "utf8"))
  const html = await fs.readFile(result.previewPath, "utf8")
  const visible = manifest.richMessage.html.replace(/<[^>]*>/gu, "")
  assert.ok([...visible].length > 4_096)
  assert.ok([...visible].length <= 32_768)
  assert.equal(result.messageCount, 1)
  assert.equal(result.candidateCount, 1)
  assert.doesNotMatch(manifest.richMessage.html, /PRIVATE-TECHNICAL|PRIVATE-SOCIAL/u)
  assertPreviewPost(html, manifest)
  assert.deepEqual(report, before)
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
