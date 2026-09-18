import assert from "node:assert/strict"
import vm from "node:vm"
import test from "node:test"

import { renderReportHtml } from "../src/steps/step11-report/render-report-html.js"

function scripts (html) {
  return [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)]
    .map(([, attributes, content]) => ({ attributes, content }))
}

test("report embeds its data, styles, executable browser scripts and chart license without external assets", async () => {
  const report = { asOf: "2026-09-15T09:00:00.000Z", reportCreatedAt: "2026-09-15T11:05:12.345Z", coins: [] }
  const html = await renderReportHtml(report)
  const embedded = scripts(html)

  assert.match(html, /^<!doctype html>/i)
  assert.match(html, /<html lang="ru">/)
  assert.match(html, /<meta name="viewport"/)
  assert.match(html, /ШАГ 11/)
  const sortOptions = html.match(/<select id="sort">([\s\S]*?)<\/select>/)[1]
  assert.deepEqual([...sortOptions.matchAll(/<option value="([^"]+)"/g)].map(([, value]) => value), [
    "probability", "top", "confidence",
  ])
  assert.doesNotMatch(sortOptions, /По алфавиту/)
  assert.match(html, /id="information-panel"/)
  assert.match(html, /id="news-details"/)
  assert.match(html, /id="twitter-details"/)
  assert.match(html, /id="update-chart"/)
  assert.match(html, /id="chart-update-status"/)
  assert.match(html, /id="report-time-note"/)
  assert.match(html, /id="sustained-strength"/)
  assert.match(html, /aria-labelledby="sustained-strength-heading"/)
  assert.match(html, /Устойчивая сила/)
  assert.match(html, /id="sustained-strength-status"[^>]*role="status"/)
  assert.match(html, /id="sustained-strength-history"/)
  assert.match(html, /id="sustained-strength-current"/)
  assert.match(html, /Оценки 0–100 — не вероятность\s+движения и не сигнал входа/)
  assert.ok(html.indexOf("id=\"sustained-strength\"") < html.indexOf("aria-labelledby=\"analysis-heading\""))
  for (const status of ["persistent", "emerging", "fading"]) {
    assert.ok(html.includes(`.sustained-strength-panel[data-status="${status}"]`))
  }
  assert.match(html, /id="alt-market-background"/)
  assert.match(html, /aria-labelledby="alt-market-heading"/)
  assert.match(html, /Фон альтрынка · 4ч/)
  assert.match(html, /более 55%.*менее 45%/)
  assert.ok(html.indexOf("id=\"alt-market-background\"") < html.indexOf("id=\"market-summary\""))
  assert.match(html, /\.alt-market-background\[data-status="up"\]/)
  assert.match(html, /\.alt-market-background\[data-status="down"\]/)
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
  assert.match(embedded[2].content, /credentials: "omit"/)
  assert.match(embedded[2].content, /https:\/\/fapi\.binance\.com/)
  assert.match(embedded[2].content, /LightweightCharts\.createSeriesMarkers/)
  assert.doesNotMatch(embedded[2].content, /\b(?:XMLHttpRequest|WebSocket|setInterval|localStorage|sessionStorage|showSaveFilePicker)\b/)
  assert.doesNotMatch(embedded[2].content, /\[native code\]/)
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
    altMarketBackground: { status: "unavailable", change4hPct: null, breadth4h: null, warning: unsafe },
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
