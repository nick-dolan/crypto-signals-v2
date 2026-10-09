import assert from "node:assert/strict"
import vm from "node:vm"
import test from "node:test"

import { renderReportHtml, renderReportPage } from "../src/reports/render-report-html.js"

function scripts (html) {
  return [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)]
    .map(([, attributes, content]) => ({ attributes, content }))
}

for (const mode of ["download", "website"]) {
  test(`${mode} separates the radar header, news heading and agent focus outlook`, async () => {
    const html = mode === "download" ? await renderReportHtml({ coins: [] }) : await renderReportPage()
    const header = html.match(/<header class="page-header">([\s\S]*?)<\/header>/)[1].replace(/\s+/g, " ")
    const brief = html.match(/<section id="market-brief"[^>]*>([\s\S]*?)<\/section>/)[1]
    const focus = html.match(/<section class="top-section"[^>]*>([\s\S]*?)<\/section>/)[1]

    assert.match(html, /<title>Crypto Signals · Крипторадар<\/title>/)
    assert.match(header, /CRYPTO SIGNALS <span class="muted">\/ РАННИЕ ДВИЖЕНИЯ<\/span>/)
    assert.match(header, /<h1 id="report-title">Крипторадар<\/h1>/)
    assert.doesNotMatch(header, /ШАГ 13|Кандидаты|report-subtitle/)
    assert.match(brief, /<h2 id="market-brief-heading">Новости за последние 6 часов<\/h2>/)
    assert.doesNotMatch(brief, /Кандидаты|top-subtitle/)
    assert.match(focus, /<h2 id="top-heading">В фокусе агента<\/h2>\s*<p id="top-subtitle" class="subtitle"><\/p>/)
    assert.match(focus, /<span id="top-hint" class="muted" hidden>Нажмите на монету, чтобы изучить сигнал<\/span>/)
  })

  test(`${mode} exposes current-strength sorting and an empty detail-header indicator slot with local SVG references`, async () => {
    const html = mode === "download" ? await renderReportHtml({ coins: [] }) : await renderReportPage()
    const options = html.match(/<select id="sort">([\s\S]*?)<\/select>/)[1]
    assert.deepEqual([...options.matchAll(/<option\b([^>]*)>([^<]+)<\/option>/g)].map(([, attributes, label]) => [
      attributes.match(/value="([^"]+)"/)[1], label.trim(), /\bselected\b/.test(attributes),
    ]), [
      ["probability", "По вероятности движения", false], ["top", "Сначала топ агента", true],
      ["confidence", "По уверенности агента", false], ["strength", "По текущей силе", false],
    ])
    const header = html.match(/<header class="coin-header">([\s\S]*?)<\/header>/)[1]
    assert.match(header, /<h2 id="coin-symbol"><\/h2>/)
    assert.match(header, /<span\s+id="coin-indicators"\s+class="coin-indicators"\s+hidden\s*>\s*<\/span>/)
    assert.equal([...html.matchAll(/\bid="coin-indicators"/g)].length, 1)
    const references = [...html.matchAll(/<use\b[^>]*\bhref="([^"]+)"/g)].map(([, href]) => href)
    assert.ok(references.length > 0)
    assert.ok(references.every(href => /^#icon-[a-z-]+$/.test(href)))
  })
}

test("all three template timezone labels are fixed UTC+3", async () => {
  const html = await renderReportHtml({ coins: [] })
  const text = html.replace(/\s+/g, " ")

  assert.match(text, /Сохранённый срез · UTC\+3<\/span>/)
  assert.match(text, /\/ свечи 1h · UTC\+3<\/span>/)
  assert.match(text, /фактическое закрытие часовой свечи, UTC\+3\./)
})

test("report embeds its data, executable browser scripts and chart license without external assets", async () => {
  const report = { asOf: "2026-09-15T09:00:00.000Z", reportCreatedAt: "2026-09-15T11:05:12.345Z", coins: [] }
  const html = await renderReportHtml(report)
  const embedded = scripts(html)
  const text = html.replace(/\s+/g, " ")

  assert.match(html, /^<!doctype html>/i)
  assert.match(html, /<html lang="ru">/)
  assert.match(html, /<meta name="viewport"/)
  assert.deepEqual([...html.matchAll(/\bid="(report-time-note|release-time-note|chart-source)"/g)].map(([, id]) => id), [])
  assert.match(html, /<p id="chart-update-status"[^>]*class="chart-update-status"[^>]*role="status"[^>]*aria-live="polite"[^>]*hidden\s*>\s*<\/p>/)
  assert.match(html, /id="chart-update-error"[^>]*role="alert"[^>]*hidden/)
  assert.match(html, /id="history-warning"[^>]*role="status"[^>]*hidden/)

  const sortOptions = html.match(/<select id="sort">([\s\S]*?)<\/select>/)[1]
  assert.deepEqual([...sortOptions.matchAll(/<option\b[^>]*value="([^"]+)"/g)].map(([, value]) => value), [
    "probability", "top", "confidence", "strength",
  ])

  const candidateTable = html.match(/<table class="candidate-table">([\s\S]*?)<\/table>/)[1]
  assert.match(candidateTable, /<caption\b[^>]*>\s*Кандидаты\s+с\s+вероятностью\s+сильного\s+движения\s*<\/caption>/)
  assert.deepEqual([...candidateTable.matchAll(/<th\b[^>]*scope="col">([^<]+)<\/th>/g)].map(([, label]) => label), [
    "Монета", "P движения",
  ])
  assert.doesNotMatch(html, /Уклон|предполагаемым направлением|Направление неясно|Нет оценки направления/)
  assert.match(html, /Вероятность — оценка агента, не статистически откалиброванный прогноз\. Это не торговая рекомендация\./)

  assert.deepEqual([...html.matchAll(/data-days="(\d+)" aria-pressed="(true|false)"/g)].map(([, days, pressed]) => [days, pressed]), [
    ["1", "false"], ["3", "false"], ["7", "true"],
  ])

  assert.match(html, /id="coingecko-context"[^>]*aria-labelledby="coingecko-heading"[^>]*hidden/)
  assert.match(html, /Трендовые категории CoinGecko/)
  assert.match(html, /Поисковое внимание, не сигнал роста/)
  assert.doesNotMatch(html, /id="context-generated"|Инфофон подготовлен|Учтён в основной оценке роста/)
  const newsDetails = html.match(/<details id="news-details"[^>]*>([\s\S]*?)<\/details>/)[1]
  assert.match(newsDetails, /<p id="news-window" class="source-window"><\/p>\s*<p id="context-caveat" class="source-window" hidden><\/p>/)
  assert.equal([...html.matchAll(/\bid="context-caveat"/g)].length, 1)

  assert.match(html, /aria-labelledby="sustained-strength-heading"/)
  assert.match(html, /Устойчивая сила/)
  assert.match(html, /id="sustained-strength-status"[^>]*role="status"/)
  assert.match(html, /Оценки 0–100 — не вероятность\s+движения и не сигнал входа/)

  assert.match(html, /aria-labelledby="alt-market-heading"/)
  assert.match(html, /Фон альтрынка · 4ч/)
  assert.match(text, /более 55%.*менее 45%/)
  assert.match(text, /Это простое правило для текущего среза, не прогноз и не оценка вероятности\./)
  assert.match(html, /id="market-brief"[^>]*aria-labelledby="market-brief-heading"[^>]*hidden/)
  assert.match(html, /id="report-tabs"[^>]*role="tablist"[^>]*aria-label="Разделы отчёта"/)
  assert.match(html, /id="main-tab"[^>]*role="tab"[^>]*aria-controls="main-panel"[^>]*aria-selected="true"[^>]*tabindex="0"/)
  assert.match(html, /id="peer-radar-tab"[^>]*role="tab"[^>]*aria-controls="peer-radar"[^>]*aria-selected="false"[^>]*tabindex="-1"/)
  assert.match(html, /id="main-panel"[^>]*role="tabpanel"[^>]*aria-labelledby="main-tab"[^>]*tabindex="0">/)
  assert.match(html, /id="peer-radar"[^>]*role="tabpanel"[^>]*aria-labelledby="peer-radar-tab"[^>]*tabindex="0"[^>]*hidden/)
  assert.match(html, /Основной анализ/)

  assert.deepEqual([...html.matchAll(/data-peer-days="(\d+)" aria-pressed="(true|false)"/g)].map(([, days, pressed]) => [days, pressed]), [
    ["1", "true"], ["3", "false"], ["7", "false"],
  ])
  assert.match(text, /изменение цены закрытия в процентах, не сигнал в ATR/)
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

  assert.doesNotMatch(html, /<(?:script|link|img)\b[^>]*(?:src|href)\s*=/i)
  assert.doesNotMatch(html, /REPORT_(STYLES|SCRIPT|CHARTS|DATA|LICENSE)/)
  assert.equal(embedded.length, 3)
  assert.match(embedded[0].attributes, /type="application\/json"/)
  assert.deepEqual(JSON.parse(embedded[0].content), report)
  assert.match(embedded[1].content, /TradingView Lightweight Charts/)
  assert.match(html, /Apache License/)
  assert.match(html, /href="https:\/\/www\.tradingview\.com\/"/)
  assert.match(html, /attributionLogo: true/)
  assert.match(embedded[2].content, /credentials: "omit"/)
  assert.match(embedded[2].content, /https:\/\/fapi\.binance\.com/)
  assert.doesNotMatch(embedded[2].content, /\b(?:XMLHttpRequest|WebSocket|setInterval|localStorage|sessionStorage|showSaveFilePicker)\b/)
  for (const { content } of embedded.slice(1)) {
    assert.doesNotThrow(() => new vm.Script(content))
  }
})

test("saved continuation, quote and actual release time are embedded unchanged without text blocks above the chart", async () => {
  const report = {
    asOf: "2026-09-15T09:00:00.000Z", reportCreatedAt: "2026-09-15T11:37:42.123Z",
    coins: [{
      symbol: "COTI",
      history: { candles: [{ time: 1_789_462_800, open: 1, high: 2, low: 1, close: 2 }], volume: [], openInterest: [], warning: null },
      chartSnapshot: {
        data: {
          history: { candles: [{ time: 1_789_470_000, open: 2, high: 3, low: 2, close: 3 }], volume: [], openInterest: [], warning: null },
          updatedAt: "2026-09-15T11:30:00.000Z", formingTime: 1_789_470_000, currentOiAt: null,
          sourceFrom: 1_789_470_000, oiSourceFrom: null, limitReached: false,
        },
        quote: { price: 3.25, at: "2026-09-15T11:37:41.000Z" }, warning: "OI недоступен",
      },
    }],
  }
  const before = structuredClone(report)
  const html = await renderReportHtml(report)
  const embedded = scripts(html)
  assert.deepEqual(JSON.parse(embedded[0].content), before)
  assert.deepEqual(report, before)
  assert.deepEqual([...html.matchAll(/\bid="(report-time-note|release-time-note|chart-source)"/g)].map(([, id]) => id), [])
  assert.match(html, /<p id="chart-update-status"[^>]*class="chart-update-status"[^>]*role="status"[^>]*aria-live="polite"[^>]*hidden\s*>\s*<\/p>/)
  assert.match(html.replace(/\s+/g, " "), /после перезагрузки вернётся сохранённый график отчёта, включая продолжение/)
  for (const label of ["Срез анализа", "Отчёт готов", "Цена при выпуске"]) {
    assert.ok(embedded[2].content.includes(label), label)
  }
  assert.doesNotMatch(embedded[2].content, /report-time-note|release-time-note|chart-source|Сохранённое продолжение: снимок/)
  assert.match(embedded[2].content, /attachPrimitive/)
  assert.match(embedded[2].content, /createPriceLine/)
  assert.doesNotMatch(html, /<(?:script|link|img)\b[^>]*(?:src|href)\s*=/i)
  assert.doesNotThrow(() => new vm.Script(embedded[2].content))
})

test("agent text cannot escape embedded JSON, become executable HTML, or replace template slots", async () => {
  const unsafe = "</ScRiPt><script>globalThis.injected = true</script><img src=x onerror=alert(1)><!-- & \" {{charts}} $& $' $` \u2028\u2029"
  const report = {
    coins: [{
      symbol: unsafe, explanation: unsafe, drivers: [unsafe], history: { warning: unsafe },
      socialSignificant: true, socialReason: unsafe, socialSentiment: "negative",
      chartSnapshot: { data: null, quote: { price: 1, at: "2026-09-15T11:37:41.000Z" }, warning: unsafe },
      features: { coingeckoId: "coin", coingeckoTrending: true, coingeckoTrendingCategories: [unsafe] },
      information: {
        news: { status: "failed", error: unsafe, items: [{ title: unsafe, content: unsafe, shortDescription: unsafe }] },
        twitter: { status: "available", tweets: [{ text: unsafe, authorUsername: unsafe }] },
      },
    }],
    coinDescriptions: {
      unsafe: { description: unsafe, sources: [{ url: unsafe, checkedAt: unsafe }] },
    },
    definitions: { unsafe },
    altMarketBackground: { status: "unavailable", change4hPct: null, breadth4h: null, warning: unsafe },
    marketBrief: {
      schemaVersion: 5, marketAsOf: null, asOf: "2026-09-15T13:20:00.000Z", from: "2026-09-15T07:20:00.000Z",
      generatedAt: "2026-09-15T13:22:00.000Z", status: "partial", warning: unsafe,
      coverage: [{ source: "tradingview", status: "partial", fetchedCount: 1, error: unsafe }],
      sources: Array.from({ length: 10 }, (_, index) => ({
        id: `source-${index}`, channel: "tradingview", url: `https://news.example/${index}`,
        title: unsafe, text: unsafe, author: unsafe, publisher: unsafe, publishedAt: unsafe,
      })),
      items: Array.from({ length: 5 }, (_, index) => ({ title: unsafe, text: unsafe, sourceIds: [`source-${index * 2}`, `source-${index * 2 + 1}`] })),
      analysis: { model: "gemini-3.7-flash", warning: unsafe },
    },
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
  const before = structuredClone(report)
  const html = await renderReportHtml(report)
  const embedded = scripts(html)

  assert.equal(embedded.length, 3)
  assert.doesNotMatch(embedded[0].content, /[<\u2028\u2029]/)
  assert.deepEqual(JSON.parse(embedded[0].content), before)
  assert.deepEqual(report, before)
  assert.doesNotMatch(html, /<img src=x|<script>globalThis\.injected/)
  assert.doesNotMatch(embedded[2].content, /\.(?:innerHTML|outerHTML)\s*=|insertAdjacentHTML|document\.write\(/)
})
