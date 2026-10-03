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

async function temporaryDirectory (t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "telegram-preview-"))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  return directory
}

test("writes preview, manifest and matching PNG/SVG cards without mutating the report", async (t) => {
  const report = createDemoReport()
  report.coins.push({ ...report.coins[0], symbol: "SECOND", name: "Вторая монета", topRank: 2 })
  const before = structuredClone(report)
  const directory = await temporaryDirectory(t)
  const result = await writeTelegramPreview(report, { directory, source: "Локальный тест" })
  const manifest = JSON.parse(await fs.readFile(result.manifestPath, "utf8"))
  const html = await fs.readFile(result.previewPath, "utf8")
  assert.equal(path.dirname(result.directory), directory)
  assert.equal(result.previewPath, path.join(result.directory, "index.html"))
  assert.equal(result.manifestPath, path.join(result.directory, "release.json"))
  assert.deepEqual((await fs.readdir(result.directory)).sort(), ["cards", "index.html", "release.json"])
  assert.deepEqual(manifest, { ...buildTelegramRelease(before), source: "Локальный тест" })
  assert.equal(result.candidateCount, manifest.candidates.length)
  assert.equal(result.messageCount, 1)
  assert.ok(manifest.candidates.length > 0)
  assert.deepEqual([...html.matchAll(/<img\b[^>]*src="([^"]+)"/gu)].map(([, image]) => image), manifest.candidates.map(item => item.image))
  assert.doesNotMatch(html, /tg-collage|tg:\/\/photo|attach:\/\//u)
  for (const item of manifest.candidates) {
    const png = await fs.readFile(path.join(result.directory, item.image))
    assert.deepEqual(png.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    assert.ok(png.readUInt32BE(16) > 0)
    assert.ok(png.readUInt32BE(20) > 0)
    const svg = await fs.readFile(path.join(result.directory, item.image.replace(/\.png$/u, ".svg")), "utf8")
    assert.match(svg, /^<svg\b/u)
    assert.ok(svg.includes(item.symbol))
    assert.ok(html.includes(item.symbol))
  }
  assert.deepEqual((await fs.readdir(path.join(result.directory, "cards"))).sort(), manifest.candidates
    .flatMap(item => [path.basename(item.image), path.basename(item.image.replace(/\.png$/u, ".svg"))]).sort())
  assert.deepEqual(report, before)
})

test("reruns create a separate release and preserve every previous artifact", async (t) => {
  const directory = await temporaryDirectory(t)
  const previous = await writeTelegramPreview(createDemoReport(), { directory })
  const files = [
    "index.html", "release.json",
    ...(await fs.readdir(path.join(previous.directory, "cards"))).map(file => `cards/${file}`),
  ]
  const before = await Promise.all(files.map(file => fs.readFile(path.join(previous.directory, file))))
  const next = await writeTelegramPreview(createDemoReport(), { directory })
  assert.notEqual(next.directory, previous.directory)
  assert.deepEqual((await fs.readdir(directory)).sort(), [path.basename(previous.directory), path.basename(next.directory)].sort())
  for (const file of files) {
    assert.ok((await fs.stat(path.join(next.directory, file))).isFile())
  }
  assert.deepEqual(await Promise.all(files.map(file => fs.readFile(path.join(previous.directory, file)))), before)
})

test("an empty report writes a usable preview and manifest without images", async (t) => {
  const report = { ...createDemoReport(), coins: [] }
  const result = await writeTelegramPreview(report, { directory: await temporaryDirectory(t) })
  const manifest = JSON.parse(await fs.readFile(result.manifestPath, "utf8"))
  const html = await fs.readFile(result.previewPath, "utf8")
  assert.equal(result.candidateCount, 0)
  assert.deepEqual(manifest.candidates, [])
  assert.deepEqual(manifest.richMessage.media, [])
  assert.equal(manifest.source, null)
  assert.deepEqual(await fs.readdir(path.join(result.directory, "cards")), [])
  assert.ok(html.includes(report.asOf))
  assert.doesNotMatch(html, /<img\b|tg-collage|tg:\/\/photo/iu)
})

test("renderer preserves text and links and resolves photos by media ID, not candidate order", () => {
  const text = "Сохранённый текст &amp; символы. ".repeat(200)
  const manifest = {
    asOf: "2026-10-01T09:00:00.000Z", closedAt: "2026-10-01T10:00:00.000Z", eligibleCount: 2, omittedCount: 0,
    candidates: [
      { mediaId: "card_2", image: "cards/02-SECOND.png", symbol: "SECOND", number: 2 },
      { mediaId: "card_1", image: "cards/01-FIRST.png", symbol: "FIRST", number: 1 },
    ],
    richMessage: { html: [
      `<p>${text}</p>`,
      "<tg-collage><img src=\"tg://photo?id=card_1\"/><img src=\"tg://photo?id=card_2\"/></tg-collage>",
      "<p><a href=\"https://news.example/?x=1&amp;y=2\">Сохранённый источник</a> Конец текста.</p>",
    ].join("\n") },
  }
  const before = structuredClone(manifest)
  const html = renderTelegramPreview(manifest)
  assert.ok(html.includes(text))
  assert.ok(html.includes("Сохранённый источник"))
  assert.ok(html.includes("Конец текста."))
  assert.deepEqual([...html.matchAll(/<a\b[^>]*href="([^"]+)"/gu)].map(([, href]) => href), ["https://news.example/?x=1&amp;y=2"])
  assert.deepEqual([...html.matchAll(/<img\b[^>]*src="([^"]+)"/gu)].map(([, image]) => image), ["cards/01-FIRST.png", "cards/02-SECOND.png"])
  assert.doesNotMatch(html, /tg-collage|tg:\/\/photo|attach:\/\//u)
  assert.deepEqual(manifest, before)
})

test("renderer escapes every metadata field and image attribute without enabling active HTML or remote resources", () => {
  const unsafe = "<img src=x onerror=alert(1)> & \"'"
  const escaped = "&lt;img src=x onerror=alert(1)&gt; &amp; &quot;&#39;"
  const manifest = {
    asOf: `asOf ${unsafe}`, closedAt: `closedAt ${unsafe}`, source: `source ${unsafe} javascript:alert(1)`,
    eligibleCount: `eligibleCount ${unsafe}`, omittedCount: `omittedCount ${unsafe}`,
    candidates: [{ mediaId: "card_1", image: "cards/01-DEMO.png", symbol: `symbol ${unsafe}`, number: `number ${unsafe}` }],
    richMessage: { html: "<img src=\"tg://photo?id=card_1\"/>" },
  }
  const before = structuredClone(manifest)
  const html = renderTelegramPreview(manifest)
  for (const field of ["asOf", "closedAt", "source", "eligibleCount", "omittedCount", "symbol", "number"]) {
    assert.ok(html.includes(`${field} ${escaped}`), `Missing escaped metadata: ${field}`)
  }
  assert.ok(!html.includes(unsafe))
  assert.doesNotMatch(html, /<script\b|<(?:iframe|object|embed|audio|video|source)\b|<img src=x|href="javascript:/iu)
  assert.doesNotMatch(html, /<(?:img|link)\b[^>]*(?:src|href)="(?:https?:)?\/\//iu)
  assert.match(html, /http-equiv="Content-Security-Policy"[^>]*default-src 'none'; img-src 'self'/u)
  assert.deepEqual(manifest, before)
})

test("renderer rejects missing photo mappings, non-local paths, traversal and attribute injection", () => {
  for (const image of [
    "https://remote.example/card.png", "//remote.example/card.png", "file:///tmp/card.png", "/tmp/card.png",
    "cards/../../card.png", "cards/x.png\" onerror=\"alert(1)",
  ]) {
    const manifest = buildTelegramRelease(createDemoReport())
    manifest.candidates[0].image = image
    assert.throws(() => renderTelegramPreview(manifest), /Нет локальной карточки/u)
  }
  const manifest = buildTelegramRelease(createDemoReport())
  manifest.candidates[0].mediaId = "card_2"
  assert.throws(() => renderTelegramPreview(manifest), /Нет локальной карточки.*card_1/u)
})

test("invalid reports and builder errors do not create an output directory", async (t) => {
  const directory = path.join(await temporaryDirectory(t), "not-created")
  for (const report of [null, [], {}, { coins: null }, { coins: [null] }, { coins: [[]] }]) {
    await assert.rejects(writeTelegramPreview(report, { directory }), /coins/u)
  }
  await assert.rejects(writeTelegramPreview({ ...createDemoReport(), timeframe: "4h" }, { directory }), /часовой отчёт/u)
  await assert.rejects(fs.stat(directory), { code: "ENOENT" })
})

test("a late write failure removes the unfinished release and preserves all previous files", async (t) => {
  const directory = await temporaryDirectory(t)
  const previous = await writeTelegramPreview(createDemoReport(), { directory })
  const files = [
    "index.html", "release.json",
    ...(await fs.readdir(path.join(previous.directory, "cards"))).map(file => `cards/${file}`),
  ]
  const before = await Promise.all(files.map(file => fs.readFile(path.join(previous.directory, file))))
  const writeFile = fs.writeFile.bind(fs)
  const written = []
  t.mock.method(fs, "writeFile", async (filename, ...args) => {
    if (path.basename(filename) === "index.html") {
      throw new Error("simulated disk failure")
    }
    await writeFile(filename, ...args)
    written.push(filename)
  })
  const report = createDemoReport()
  const original = structuredClone(report)
  await assert.rejects(writeTelegramPreview(report, { directory }), /simulated disk failure/u)
  assert.ok(written.some(filename => filename.endsWith(".png")))
  assert.ok(written.some(filename => filename.endsWith(".svg")))
  assert.ok(written.some(filename => filename.endsWith("release.json")))
  assert.deepEqual(await fs.readdir(directory), [path.basename(previous.directory)])
  assert.deepEqual(await Promise.all(files.map(file => fs.readFile(path.join(previous.directory, file)))), before)
  assert.deepEqual(report, original)
})
