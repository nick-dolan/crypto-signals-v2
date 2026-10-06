import assert from "node:assert/strict"
import vm from "node:vm"
import test from "node:test"

import { renderReportHtml } from "../src/reports/render-report-html.js"

function scripts (html) {
  return [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)]
    .map(([, attributes, content]) => ({ attributes, content }))
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

  const sortOptions = html.match(/<select id="sort">([\s\S]*?)<\/select>/)[1]
  assert.deepEqual([...sortOptions.matchAll(/<option\b[^>]*value="([^"]+)"/g)].map(([, value]) => value), [
    "probability", "top", "confidence",
  ])

  const candidateTable = html.match(/<table class="candidate-table">([\s\S]*?)<\/table>/)[1]
  assert.match(candidateTable, /<caption\b[^>]*>Кандидаты с вероятностью сильного движения<\/caption>/)
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
  assert.match(html, /id="market-brief"[^>]*aria-label="Краткая сводка рынка"[^>]*hidden/)
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

test("agent text cannot escape embedded JSON, become executable HTML, or replace template slots", async () => {
  const unsafe = "</ScRiPt><script>globalThis.injected = true</script><img src=x onerror=alert(1)><!-- & \" {{charts}} $& $' $` \u2028\u2029"
  const report = {
    coins: [{
      symbol: unsafe, explanation: unsafe, drivers: [unsafe], history: { warning: unsafe },
      socialSignificant: true, socialReason: unsafe, socialSentiment: "negative",
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
