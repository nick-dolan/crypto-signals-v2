import assert from "node:assert/strict"
import vm from "node:vm"
import test from "node:test"

import { renderReportHtml } from "../src/steps/step11-report/render-report-html.js"

function scripts (html) {
  return [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)]
    .map(([, attributes, content]) => ({ attributes, content }))
}

test("report embeds its data, styles, executable browser scripts and chart license without external assets", async () => {
  const report = { asOf: "2026-09-15T09:00:00.000Z", coins: [] }
  const html = await renderReportHtml(report)
  const embedded = scripts(html)

  assert.match(html, /^<!doctype html>/i)
  assert.match(html, /<html lang="ru">/)
  assert.match(html, /<meta name="viewport"/)
  assert.match(html, /ШАГ 11/)
  assert.match(html, /id="information-panel"/)
  assert.match(html, /id="news-details"/)
  assert.match(html, /id="twitter-details"/)
  assert.doesNotMatch(html, /ШАГ 7\.1|публикации последующих шагов сюда не входят/)
  assert.match(html, /<style>\s*:root/)
  assert.doesNotMatch(html, /<(?:script|link|img)\b[^>]*(?:src|href)\s*=/i)
  assert.doesNotMatch(html, /REPORT_(STYLES|SCRIPT|CHARTS|DATA|LICENSE)/)
  assert.equal(embedded.length, 3)
  assert.match(embedded[0].attributes, /type="application\/json"/)
  assert.deepEqual(JSON.parse(embedded[0].content), report)
  assert.match(embedded[1].content, /TradingView Lightweight Charts/)
  assert.match(html, /Apache License/)
  assert.match(html, /href="https:\/\/www\.tradingview\.com\/"/)
  assert.match(html, /attributionLogo: true/)
  assert.match(embedded[2].content, /LightweightCharts\.CandlestickSeries/)
  assert.match(embedded[2].content, /LightweightCharts\.HistogramSeries/)
  assert.match(embedded[2].content, /LightweightCharts\.LineSeries/)
  assert.doesNotMatch(embedded[2].content, /\b(?:fetch|XMLHttpRequest|WebSocket)\s*\(/)
  for (const { content } of embedded.slice(1)) {
    assert.doesNotThrow(() => new vm.Script(content))
  }
})

test("agent text cannot escape embedded JSON, become executable HTML, or replace template slots", async () => {
  const unsafe = "</ScRiPt><script>globalThis.injected = true</script><img src=x onerror=alert(1)><!-- & \" {{charts}} $& $' $` \u2028\u2029"
  const report = {
    coins: [{
      symbol: unsafe, explanation: unsafe, drivers: [unsafe], history: { warning: unsafe },
      information: {
        news: { status: "failed", error: unsafe, items: [{ title: unsafe, content: unsafe, shortDescription: unsafe }] },
        twitter: { status: "available", tweets: [{ text: unsafe, authorUsername: unsafe }] },
      },
    }],
    definitions: { unsafe },
  }
  const html = await renderReportHtml(report)
  const embedded = scripts(html)

  assert.equal(embedded.length, 3)
  assert.doesNotMatch(embedded[0].content, /</)
  assert.deepEqual(JSON.parse(embedded[0].content), report)
  assert.doesNotMatch(html, /<img src=x|<script>globalThis\.injected/)
  assert.doesNotMatch(embedded[2].content, /\.innerHTML\s*=/)
  assert.match(embedded[2].content, /\.textContent = text/)
})
