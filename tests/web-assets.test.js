import assert from "node:assert/strict"
import fs from "node:fs/promises"
import test from "node:test"
import vm from "node:vm"

import { renderReportHtml, renderReportPage } from "../src/reports/render-report-html.js"
import { readWebAsset } from "../src/web/read-web-asset.js"

function scripts (html) {
  return [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)]
    .map(([, attributes, content]) => ({ attributes, content }))
}

test("web assets use an explicit allowlist, text MIME types and executable native browser scripts", async () => {
  for (const [name, type] of [
    ["index.html", "text/html"], ["report.css", "text/css"], ["web.css", "text/css"],
    ["browser-helpers.js", "text/javascript"], ["reports-list.js", "text/javascript"],
    ["report-loader.js", "text/javascript"], ["report.js", "text/javascript"],
    ["lightweight-charts.js", "text/javascript"], ["chart-license.txt", "text/plain"],
  ]) {
    const asset = await readWebAsset(name)
    assert.equal(asset.contentType, `${type}; charset=utf-8`)
    assert.ok(asset.content.length > 0)
    if (type === "text/javascript") {
      assert.doesNotThrow(() => new vm.Script(asset.content, { filename: name }))
      assert.doesNotMatch(asset.content, /\[native code\]/)
    }
  }
  for (const name of [
    null, undefined, "", "../report.js", "./report.js", "/report.js", "..\\report.js", "%2e%2e%2freport.js",
    "report.js?x=1", "report.js#x", "REPORT.JS", "report.js\0", "toString", "__proto__", "constructor",
    "read-web-asset.js", "report.html", "report-navigation.html", "chart-update.js", "package.json",
    "../../package.json", "node_modules/lightweight-charts/package.json", "https://example.com/report.js",
  ]) {
    assert.equal(await readWebAsset(name), null, String(name))
  }
})

test("both website pages reference only allowlisted same-origin assets in dependency order", async () => {
  const index = (await readWebAsset("index.html")).content
  const report = await renderReportPage()
  for (const html of [index, report]) {
    assert.match(html, /^<!doctype html>/i)
    assert.match(html, /<html lang="ru">/)
    assert.match(html, /<meta name="viewport"/)
    assert.match(html, /<noscript>/)
    assert.doesNotMatch(html, /REPORT_[A-Z]+/)
    for (const [, url] of html.matchAll(/<(?:link|script)\b[^>]*(?:href|src)="([^"]+)"/g)) {
      assert.ok(url.startsWith("/assets/"), url)
      assert.ok(await readWebAsset(url.slice("/assets/".length)), url)
    }
    for (const { attributes, content } of scripts(html)) {
      if (attributes.includes("src=")) {
        assert.match(attributes, /\bdefer\b/)
        assert.equal(content, "")
      } else {
        assert.match(attributes, /type="application\/json"/)
      }
    }
  }
  assert.deepEqual(scripts(index).map(item => item.attributes.match(/src="([^"]+)"/)[1]), [
    "/assets/browser-helpers.js", "/assets/reports-list.js",
  ])
  assert.deepEqual(scripts(report).filter(item => item.attributes.includes("src=")).map(item => item.attributes.match(/src="([^"]+)"/)[1]), [
    "/assets/lightweight-charts.js", "/assets/browser-helpers.js", "/assets/report.js", "/assets/report-loader.js",
  ])
  assert.match(index, /UTC\+3 · неделя с понедельника · новые сверху/)
  assert.match(report, /<a href="\/">← Все отчёты<\/a>/)
  assert.match(report, /id="report-download"[^>]*hidden[^>]*download/)
  assert.match(report, /id="report-load-message"[^>]*role="status"/)
  assert.match(report, /<main id="report-shell" class="shell" hidden>/)
  assert.equal(JSON.parse(scripts(report)[0].content), null)
})

test("download and website share the report shell, renderer, updater, chart vendor and license", async () => {
  const report = {
    asOf: "2026-09-25T12:00:00.000Z", coins: [],
    marketBrief: {
      schemaVersion: 2, asOf: "2026-09-25T13:00:00.000Z", from: "2026-09-25T07:00:00.000Z",
      status: "partial", warning: "Stored technical warning",
      paragraphs: [{ text: "Короткая сводка рынка.", sourceIds: ["news"] }],
      sources: [{ id: "news", channel: "tradingview", url: "https://news.example/market", title: "Исходная публикация", publisher: "News desk", publishedAt: "2026-09-25T12:15:00.000Z" }],
      coverage: [{ source: "tradingview", status: "partial", fetchedCount: 1, error: null }],
      analysis: { model: "gemini-3.7-flash" },
    },
  }
  const [offline, online, renderer, charts, license, styles, rawScript] = await Promise.all([
    renderReportHtml(report), renderReportPage(), readWebAsset("report.js"),
    readWebAsset("lightweight-charts.js"), readWebAsset("chart-license.txt"), readWebAsset("report.css"),
    fs.readFile(new URL("../src/web/report.js", import.meta.url), "utf8"),
  ])
  assert.equal(offline.match(/<main[^>]*>([\s\S]*?)<\/main>/)[1], online.match(/<main[^>]*>([\s\S]*?)<\/main>/)[1])
  assert.deepEqual(JSON.parse(scripts(offline)[0].content), report)
  for (const html of [offline, online]) {
    const brief = html.match(/<section id="market-brief"[\s\S]*?<\/section>/)[0]
    assert.match(brief, /aria-label="Краткая сводка рынка"/)
    assert.match(brief, /id="market-brief-paragraphs"/)
    assert.doesNotMatch(brief, /<h[1-6]\b|aria-labelledby|market-brief-(?:events|status|coverage|window|warning)/)
  }
  assert.ok(offline.includes(styles.content))
  assert.ok(offline.includes(license.content.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")))
  assert.equal(scripts(offline)[1].content, charts.content)
  assert.equal(scripts(offline)[2].content, `${renderer.content}\nglobalThis.renderReport()`)
  assert.ok(renderer.content.includes(rawScript))
  assert.match(rawScript, /\(\(\) => \{/)
  assert.match(renderer.content, /createChartUpdater/)
  assert.doesNotMatch(offline, /<(?:script|link|img|iframe)\b[^>]*(?:src|href)\s*=/i)
  assert.doesNotMatch(offline, /@import|url\(\s*["']?https?:|\/assets\/|\/api\/reports|requestJson/)
  assert.match(renderer.content, /https:\/\/fapi\.binance\.com/)
  assert.doesNotMatch(renderer.content, /\b(?:WebSocket|XMLHttpRequest|setInterval|eval)\s*\(/)
})

test("serialized browser type helpers retain strict shared semantics without loading Node modules", async () => {
  const context = vm.createContext({})
  new vm.Script((await readWebAsset("browser-helpers.js")).content).runInContext(context)
  assert.equal(vm.runInContext("webHelpers.isFinite(null)", context), false)
  assert.equal(vm.runInContext("webHelpers.isFinite('2')", context), false)
  assert.equal(vm.runInContext("webHelpers.isFinite(2)", context), true)
  assert.equal(vm.runInContext("webHelpers.isSafeInteger(2.5)", context), false)
  assert.equal(vm.runInContext("webHelpers.isArray([])", context), true)
  assert.equal(vm.runInContext("webHelpers.isObject({})", context), true)
  assert.equal(vm.runInContext("webHelpers.isObject([])", context), false)
  assert.equal(vm.runInContext("webHelpers.isString('x')", context), true)
  assert.equal(vm.runInContext("webHelpers.isReportId('../x')", context), false)
})
