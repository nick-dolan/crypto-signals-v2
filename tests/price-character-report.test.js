import assert from "node:assert/strict"
import test from "node:test"
import vm from "node:vm"

import { renderPriceCharacterHtml, renderPriceCharacterMarkdown } from "../src/research/render-price-character-report.js"

function fixture (analysisDays = 90) {
  const endTime = Date.parse("2026-04-01T00:00:00Z") / 1000
  const startTime = endTime - analysisDays * 86400
  const firstWeekDays = analysisDays % 7 || 7
  function summary (label, days, start) {
    return {
      label, days, startTime: start, endTime: start + days * 86400, bars: days * 96, netReturnPct: 0,
      medianRangePct: 0.25, p99RangePct: 4, maxRangePct: null, rangeTailRatio: 16, rangeIqrOverMedian: null,
      medianAbsReturnPct: 0, p99AbsReturnPct: 2, spikeCount: 0, spikeRatePct: 0, spikeEvaluatedBars: days * 96,
      rangeOver3PctRatePct: 0, returnOver3PctRatePct: 0, longWickRatePct: 0, efficiency4hMedian: 0, efficiency12hMedian: null,
      top1PctMovementSharePct: 12.5, medianDailyTurnoverUsdt: 1234567, zeroReturnRatePct: 0, flatBarRatePct: null,
    }
  }
  const report = {
    schemaVersion: 1, generatedAt: "2026-04-01T03:15:00+03:00", source: "tradingview", symbol: "PROVE",
    marketSymbol: "BINANCE:PROVEUSDT.P", timeframe: "15m", startTime, endTime,
    coverage: { requestedDays: 90, analysisDays, analysisBars: analysisDays * 96, warmupBars: 96, totalBars: analysisDays * 96 + 96, intervalSeconds: 900, missingBars: 0 },
    warnings: analysisDays < 90 ? [`Запрошено 90 дней, доступно ${analysisDays} дней истории 15m.`] : [],
    methodology: ["Данные без прогноза направления."],
    windows: [7, 30, analysisDays].map(days => summary(`${days} дней${days === analysisDays && days < 90 ? " (доступно из 90)" : ""}`, days, endTime - days * 86400)),
    weeks: Array.from({ length: Math.ceil(analysisDays / 7) }, (_, index) => summary(`Неделя ${index + 1}`, index ? 7 : firstWeekDays, startTime + (index ? firstWeekDays + (index - 1) * 7 : 0) * 86400)),
    spikes: [endTime - 900, startTime, endTime - 30 * 86400].map((time, index) => ({
      time, open: 1, max: 1.2, min: 0.8, close: 1.1, returnPct: 0, rangePct: 2 - index * 0.5,
      baselineRangePct: 0.25, rangeMultiple: 8 - index * 2, longestWickPct: 75,
    })),
  }
  const candles = Array.from({ length: analysisDays * 96 }, (_, index) => ({ time: startTime + index * 900, open: 1, max: 1.2, min: 0.8, close: 1.1, volume: 42 }))
  return { report, candles }
}

function scripts (html) {
  return [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map(([, content]) => content)
}

function button (dataset) {
  return {
    dataset, attributes: {},
    addEventListener (event, listener) {
      this[event] = listener
    },
    setAttribute (name, value) {
      this.attributes[name] = value
    },
  }
}

test("Markdown: windows, chronological partial weeks, exclusive UTC boundaries, percentages and null vs zero", () => {
  const { report } = fixture()
  report.windows[0].netReturnPct = null
  report.windows[2].netReturnPct = -1.25
  delete report.coverage.requestedDays
  delete report.coverage.analysisDays
  const before = structuredClone(report)
  const markdown = renderPriceCharacterMarkdown(report).replace(/[\u00a0\u202f]/g, " ")
  assert.match(markdown, /\| Показатель \| 7 дней \| 30 дней \| 90 дней \|/)
  assert.match(markdown, /запрошено 90 дней; доступно для анализа 90 полных дней/)
  assert.match(markdown, /\| Изменение цены, % \| — \| 0 \| -1,25 \|/)
  assert.match(markdown, /TR: медиана \/ p99 \/ макс\., % \| 0,25 \/ 4 \/ —/)
  assert.match(markdown, /Efficiency 4ч \/ 12ч \(0–1\) \| 0 \/ —/)
  assert.match(markdown, /2026-01-01 00:00 → 2026-04-01 00:00/)
  assert.match(markdown, /Создан: 2026-04-01 00:15 UTC/)
  assert.match(markdown, /Свечей анализа: 8 640; прогрев: 96; всего: 8 736; пропусков: 0; шаг: 900 с/)
  assert.match(markdown, /Неделя 1 · 2026-01-01 00:00 → 2026-01-07 00:00 \| 6 \/ 576/)
  assert.match(markdown, /Неделя 2 · 2026-01-07 00:00 → 2026-01-14 00:00 \| 7 \/ 672/)
  assert.ok(markdown.indexOf("Неделя 2 ·") < markdown.indexOf("Неделя 13 ·"))
  assert.match(markdown, /2026-03-31 23:45 \| 0 \| 2 \| 0,25 \| 8 \| 75/)
  for (const explanation of ["конец не включён", "не откалиброваны", "предыдущих 96", "spikeEvaluatedBars", "не обещает предсказуемость", "не ликвидность стакана", "Данные без прогноза направления."]) {
    assert.ok(markdown.includes(explanation), explanation)
  }
  assert.deepEqual(report, before)
})

test("text escaping protects HTML, Markdown tables and inline JSON including U+2028/U+2029", async () => {
  const { report, candles } = fixture()
  const unsafe = "</ScRiPt><img src=x onerror=alert(1)>&\"'\u2028\u2029\n|[link](javascript:alert(1))"
  Object.assign(report, { symbol: unsafe, marketSymbol: unsafe, source: unsafe, methodology: [unsafe], warnings: [unsafe] })
  report.windows[0].label = unsafe
  report.weeks[0].label = unsafe
  const html = await renderPriceCharacterHtml(report, candles)
  const embedded = scripts(html)
  assert.equal(embedded.length, 3)
  assert.doesNotMatch(embedded[0], /[<\u2028\u2029]/)
  assert.match(embedded[0], /\\u003c\/ScRiPt>/)
  assert.match(embedded[0], /\\u2028\\u2029/)
  assert.deepEqual(JSON.parse(embedded[0]), { report, candles })
  assert.doesNotMatch(html, /<img src=x|<\/ScRiPt>/)
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;&amp;&quot;&#39;/)
  assert.match(html, /Предупреждение: &lt;\/ScRiPt&gt;/)
  const markdown = renderPriceCharacterMarkdown(report)
  assert.doesNotMatch(markdown, /<img|\n\|\[link\]/)
  assert.ok(markdown.includes("\\|\\[link\\]"))
  assert.match(markdown, /Предупреждение: &lt;\/ScRiPt&gt;/)
})

for (const analysisDays of [90, 58]) {
  test(`offline HTML: ${analysisDays} days, dynamic windows and warnings, embedded candles and UTC controls`, async () => {
    const { report, candles } = fixture(analysisDays)
    const before = structuredClone({ report, candles })
    const html = await renderPriceCharacterHtml(report, candles)
    const embedded = scripts(html)
    const markdown = renderPriceCharacterMarkdown(report)
    for (const output of [html, markdown]) {
      assert.ok(output.includes(`Окна: 7 / 30 / ${analysisDays} дней`))
      assert.ok(output.includes(`запрошено 90 дней; доступно для анализа ${analysisDays} полных дней`))
      assert.equal(output.includes("Предупреждение:"), analysisDays < 90)
    }
    if (analysisDays === 58) {
      assert.ok(html.includes(report.warnings[0]) && markdown.includes(report.warnings[0]))
      assert.match(markdown, /\| Показатель \| 7 дней \| 30 дней \| 58 дней \(доступно из 90\) \|/)
      assert.match(markdown, /Неделя 1 · 2026-02-02 00:00 → 2026-02-04 00:00 \| 2 \/ 192/)
      assert.match(html, /Неделя 1 · 2026-02-02 00:00 → 2026-02-04 00:00<\/td>\s*<td\b[^>]*>2 \/ 192/)
      assert.doesNotMatch(html, /data-days="90"/)
    }
    assert.match(html, /^<!doctype html>/)
    assert.match(html, /<html lang="ru">/)
    assert.match(html, /<style>/)
    assert.doesNotMatch(html, /<(?:script|link|img)\b[^>]*(?:src|href)\s*=/i)
    assert.match(html, /default-src 'none'/)
    assert.match(html, /href="https:\/\/www\.tradingview\.com\/"/)
    assert.match(html, /Apache License/)
    assert.match(embedded[1], /TradingView Lightweight Charts/)
    assert.doesNotMatch(embedded[2], /\b(?:fetch|XMLHttpRequest|WebSocket|import)\b|innerHTML/)
    assert.deepEqual(JSON.parse(embedded[0]), before)
    embedded.slice(1).forEach(script => assert.doesNotThrow(() => new vm.Script(script)))
    const controls = [...html.matchAll(/data-days="(\d+)" aria-pressed="(true|false)">([^<]+)<\/button>/g)]
    assert.deepEqual(controls.map(([, days, pressed, label]) => [Number(days), pressed, label]), report.windows.map((window, index) => [window.days, String(index === report.windows.length - 1), window.label]))
    const buttons = controls.map(([, days]) => button({ days }))
    const events = report.spikes.map(spike => button({ time: String(spike.time) }))
    const ranges = []
    let chartOptions, seriesType, seriesData, scrolled = 0
    const document = {
      getElementById: id => id === "price-data" ? { textContent: embedded[0] } : { scrollIntoView: () => scrolled++ },
      querySelectorAll: selector => selector === "[data-days]" ? buttons : events,
    }
    const LightweightCharts = {
      CandlestickSeries: {},
      createChart (element, options) {
        chartOptions = options
        return {
          addSeries (type) {
            seriesType = type
            return { setData: (data) => {
              seriesData = data
            } }
          },
          timeScale: () => ({ setVisibleRange: range => ranges.push(JSON.parse(JSON.stringify(range))) }),
        }
      },
    }
    vm.runInNewContext(embedded[2], { window: { document, LightweightCharts }, document }, { timeout: 1000 })
    assert.equal(seriesType, LightweightCharts.CandlestickSeries)
    assert.equal(chartOptions.layout.attributionLogo, true)
    assert.equal(chartOptions.localization.timeFormatter(report.startTime), analysisDays === 90 ? "2026-01-01 00:00 UTC" : "2026-02-02 00:00 UTC")
    assert.deepEqual(JSON.parse(JSON.stringify(seriesData)), candles.map(({ time, open, max, min, close }) => ({ time, open, high: max, low: min, close })))
    assert.deepEqual(ranges.at(-1), { from: report.startTime, to: report.endTime - 900 })
    assert.deepEqual(buttons.map(control => control.attributes["aria-pressed"]), controls.map(([, , pressed]) => pressed))
    buttons.forEach((control, index) => {
      control.click()
      assert.deepEqual(ranges.at(-1), { from: report.windows[index].startTime, to: report.windows[index].endTime - 900 })
      assert.deepEqual(buttons.map(item => item.attributes["aria-pressed"]), buttons.map(item => String(item === control)))
    })
    events.forEach((control, index) => {
      control.click()
      assert.deepEqual(ranges.at(-1), { from: Math.max(report.startTime, report.spikes[index].time - 43200), to: Math.min(report.endTime, report.spikes[index].time + 43200) - 900 })
    })
    assert.equal(scrolled, 3)
    assert.ok(buttons.every(item => item.attributes["aria-pressed"] === "false"))
    assert.deepEqual({ report, candles }, before)
  })
}

test("an empty event list remains readable in both formats", async () => {
  const { report, candles } = fixture()
  report.spikes = []
  assert.match(renderPriceCharacterMarkdown(report), /## Крупнейшие вспышки\s+Нет событий \/ данных\./)
  const html = await renderPriceCharacterHtml(report, candles)
  assert.match(html, /Нет событий \/ данных\./)
  assert.doesNotMatch(html, /data-time="/)
})
