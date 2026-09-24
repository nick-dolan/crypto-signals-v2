import assert from "node:assert/strict"
import vm from "node:vm"
import test from "node:test"

import { renderReportHtml } from "../src/steps/step13-report/render-report-html.js"

function scripts (html) {
  return [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)]
    .map(([, attributes, content]) => ({ attributes, content }))
}

test("report embeds its data, styles, executable browser scripts and chart license without external assets", async () => {
  const report = { asOf: "2026-09-15T09:00:00.000Z", reportCreatedAt: "2026-09-15T11:05:12.345Z", coins: [] }
  const html = await renderReportHtml(report)
  const embedded = scripts(html)
  const text = html.replace(/\s+/g, " ")

  assert.match(html, /^<!doctype html>/i)
  assert.match(html, /<html lang="ru">/)
  assert.match(html, /<meta name="viewport"/)
  assert.match(html, /ШАГ 13/)
  const sortOptions = html.match(/<select id="sort">([\s\S]*?)<\/select>/)[1]
  assert.deepEqual([...sortOptions.matchAll(/<option value="([^"]+)"/g)].map(([, value]) => value), [
    "probability", "top", "confidence",
  ])
  assert.match(sortOptions, /<option value="top" selected>/)
  assert.doesNotMatch(sortOptions, /По алфавиту/)
  const candidateTable = html.match(/<table class="candidate-table">([\s\S]*?)<\/table>/)[1]
  assert.match(candidateTable, /<caption class="sr-only">Кандидаты с вероятностью сильного движения<\/caption>/)
  assert.deepEqual([...candidateTable.matchAll(/<th scope="col">([^<]+)<\/th>/g)].map(([, label]) => label), [
    "Монета", "P движения",
  ])
  assert.doesNotMatch(html, /directionBias|Уклон|предполагаемым направлением|Направление неясно|Нет оценки направления/)
  assert.match(html, /Вероятность — оценка агента, не статистически откалиброванный прогноз\. Это не торговая рекомендация\./)
  assert.match(html, /id="information-panel"/)
  assert.match(html, /id="news-details"/)
  assert.match(html, /id="twitter-details"/)
  assert.match(html, /id="update-chart"/)
  assert.match(html, /id="chart-update-status"/)
  assert.match(html, /id="report-time-note"/)
  assert.match(html, /id="coingecko-badge"[^>]*hidden/)
  assert.match(html, /id="coingecko-context"[^>]*aria-labelledby="coingecko-heading"[^>]*hidden/)
  assert.match(html, /Трендовые категории CoinGecko/)
  assert.match(html, /id="coingecko-categories"/)
  assert.match(html, /id="coingecko-category-status"/)
  assert.match(html, /\.coingecko-badge\s*\{/)
  assert.match(html, /Поисковое внимание, не сигнал роста/)
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
  assert.match(text, /более 55%.*менее 45%/)
  assert.match(text, /Это простое правило для текущего среза, не прогноз и не оценка вероятности\./)
  assert.ok(html.indexOf("id=\"alt-market-background\"") < html.indexOf("id=\"market-summary\""))
  assert.match(html, /\.alt-market-background\[data-status="up"\]/)
  assert.match(html, /\.alt-market-background\[data-status="down"\]/)
  assert.match(html, /id="report-tabs"[^>]*role="tablist"[^>]*aria-label="Разделы отчёта"/)
  assert.match(html, /id="main-tab"[^>]*role="tab"[^>]*aria-controls="main-panel"[^>]*aria-selected="true"[^>]*tabindex="0"/)
  assert.match(html, /id="peer-radar-tab"[^>]*role="tab"[^>]*aria-controls="peer-radar"[^>]*aria-selected="false"[^>]*tabindex="-1"/)
  assert.match(html, /id="main-panel"[^>]*role="tabpanel"[^>]*aria-labelledby="main-tab"[^>]*tabindex="0">/)
  assert.match(html, /id="peer-radar"[^>]*role="tabpanel"[^>]*aria-labelledby="peer-radar-tab"[^>]*tabindex="0"[^>]*hidden/)
  assert.match(html, /Основной анализ/)
  assert.match(html, /\.report-tabs button\[aria-selected="true"\]/)
  assert.deepEqual([...html.matchAll(/data-peer-days="(\d+)" aria-pressed="(true|false)"/g)].map(([, days, pressed]) => [days, pressed]), [
    ["1", "true"], ["3", "false"], ["7", "false"],
  ])
  assert.match(text, /изменение цены закрытия в процентах, не сигнал в ATR/)
  assert.match(text, /фактическое закрытие часовой свечи, UTC/)
  assert.match(text, /пропуски часов не соединяются/)
  assert.match(text, /Только сохранённые данные, без сетевых запросов и обновлений/)
  assert.match(text, /Радар соседей/)
  assert.match(text, /Независимый анализ · шаг 12/)
  assert.match(text, /Для ручного наблюдения, не прогноз и не вероятность движения/)
  assert.match(text, /не меняется при выборе монеты или Update chart/)
  assert.match(text, /собственном ATR каждой монеты.*не обязательно означает меньший рост в процентах/)
  assert.match(text, /flat.*±0,5 своего ATR, а не строго 0%/)
  assert.match(text, /Несколько лидеров.*независимость подтверждений не гарантируется/)
  assert.match(text, /no_peers.*это не ошибка/)
  assert.match(text, /связи неизвестны, а не отсутствуют/)
  assert.match(html, /id="no-candidates"[^>]*>[^<]*<\/div>\s*<\/div>\s*<\/div>\s*<section id="peer-radar"/)
  assert.match(html, /id="peer-radar-observations"[^>]*><\/div>\s*<\/div>\s*<\/section>\s*<footer/)
  assert.match(html, /<details id="peer-radar-method" class="peer-radar-method">/)
  assert.match(html, /\.peer-observation\[data-verdict="watch"\]/)
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
      features: { coingeckoId: "coin", coingeckoTrending: true, coingeckoTrendingCategories: [unsafe] },
      information: {
        news: { status: "failed", error: unsafe, items: [{ title: unsafe, content: unsafe, shortDescription: unsafe }] },
        twitter: { status: "available", tweets: [{ text: unsafe, authorUsername: unsafe }] },
      },
    }],
    definitions: { unsafe },
    altMarketBackground: { status: "unavailable", change4hPct: null, breadth4h: null, warning: unsafe },
    peerRadar: {
      status: "available", warning: unsafe,
      histories: { coin: { baseCurrencyId: unsafe, symbol: unsafe, marketSymbol: unsafe, points: [{ time: 1, value: 2 }, { time: 2 }], warning: unsafe } },
      data: {
        criteria: { impulse: unsafe, lag: unsafe, reaction: unsafe },
        analysis: { source: unsafe, model: unsafe, reasoningEffort: unsafe },
        observations: [{
          coin: { name: unsafe, symbol: unsafe, marketSymbol: unsafe, tradingViewSymbol: unsafe },
          explanation: unsafe, caveats: [unsafe], leaders: [{ symbol: unsafe, basis: unsafe, caveat: unsafe }],
        }],
      },
    },
  }
  const html = await renderReportHtml(report)
  const embedded = scripts(html)

  assert.equal(embedded.length, 3)
  assert.doesNotMatch(embedded[0].content, /</)
  assert.deepEqual(JSON.parse(embedded[0].content), report)
  assert.doesNotMatch(html, /<img src=x|<script>globalThis\.injected/)
  assert.doesNotMatch(embedded[2].content, /\.(?:innerHTML|outerHTML)\s*=|insertAdjacentHTML|document\.write\(/)
  assert.match(embedded[2].content, /\.textContent = text/)
})
