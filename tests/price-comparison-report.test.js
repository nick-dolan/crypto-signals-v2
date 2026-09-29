import assert from "node:assert/strict"
import test from "node:test"
import vm from "node:vm"

import { renderPriceComparisonHtml, renderPriceComparisonMarkdown } from "../src/research/render-price-comparison.js"

function fixture (analysisDays = 58) {
  const endTime = Date.parse("2026-04-01T00:00:00Z") / 1000
  const startTime = endTime - analysisDays * 86400
  function entry (baseCurrencyId, symbol, distance) {
    return {
      baseCurrencyId, symbol, name: `${symbol} coin`, marketSymbol: `BINANCE:${symbol}USDT.P`, rank: 10,
      eligible: distance !== null, exclusions: distance === null ? ["Низкий оборот"] : [], distance,
      distanceByWindow: Object.fromEntries([...new Set([7, 30, analysisDays])].map(days => [days, distance])),
      componentDistances: { bursts: distance, pace: distance, wicks: distance, path: distance, amplitude: distance, stability: distance },
      calmScore: 1, weeklySpikeP90Pct: 0.5, weeklyRangeVariation: 0.2, amplitudeRatio30d: 1, turnoverRatio30d: 1, calmerThanReference: false,
      profile: {
        timeframe: "15m", startTime, endTime,
        windows: [...new Set([7, 30, analysisDays])].map(days => ({
          label: `${days} дней`, days, startTime: endTime - days * 86400, endTime, bars: days * 96,
          spikeRatePct: 0, medianRangePct: 0.25, rangeTailRatio: 4, top1PctMovementSharePct: 12.5,
          maxRangePct: 11.99, rangeOver3PctRatePct: 0.25,
          longWickRatePct: 7, efficiency4hMedian: 0.25, efficiency12hMedian: null,
        })),
      },
    }
  }
  const report = {
    schemaVersion: 1, generatedAt: "2026-04-01T03:15:00+03:00", universeGeneratedAt: "2026-03-31T12:00:00Z",
    timeframe: "15m", analysisDays, startTime, endTime,
    coverage: { total: 7, loaded: 5, failed: 1, pending: 1, eligible: 3 },
    reference: entry("prove", "PROVE", 0), candidates: [entry("a", "AAA", 12.5), entry("b", "BBB", 15), entry("c", "CCC", 20), entry("d", "DDD", null)],
    closest: ["a", "b"], calmer: ["b", "c"],
    rejected: [{ coin: { baseCurrencyId: "failed", symbol: "FAIL", name: "Failure coin", marketSymbol: "BINANCE:FAILUSDT.P", rank: 11 }, reason: "Нет полной сетки 15m" }],
    pending: [{ baseCurrencyId: "pending", symbol: "WAIT", name: "Pending coin", marketSymbol: "BINANCE:WAITUSDT.P", rank: 12 }],
    warnings: analysisDays < 90 ? [`Доступно ${analysisDays} дней, а не 90.`] : [],
    methodology: ["Группы признаков сравниваются отдельно; пороги исследовательские."],
  }
  const charts = [report.reference, ...report.candidates].map((coin, coinIndex) => ({
    baseCurrencyId: coin.baseCurrencyId, symbol: coin.symbol, marketSymbol: coin.marketSymbol,
    previousClose: 80 * (coinIndex + 1),
    candles: Array.from({ length: analysisDays * 96 }, (_, index) => {
      const base = 100 * (coinIndex + 1)
      const open = base * (1 + index * 0.0001 * (coinIndex + 1))
      return { time: startTime + index * 900, open, max: open + base * 0.02, min: open - base * 0.01, close: open + base * 0.01, volume: 1000 }
    }),
  })).reverse()
  return { report, charts }
}

function scripts (html) {
  return [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map(([, content]) => content)
}

function element (dataset = {}) {
  return {
    dataset, attributes: {}, textContent: "", hidden: false,
    addEventListener (event, callback) {
      this[event] = callback
    },
    setAttribute (name, value) {
      this.attributes[name] = value
    },
  }
}

function mount (html) {
  const embedded = scripts(html)
  const payload = JSON.parse(embedded[0])
  const ids = ["candidate", "reference-chart", "candidate-chart", "candidate-title", "chart-status", "chart-period", "comparison-data"]
  const elements = Object.fromEntries(ids.map(id => [id, element()]))
  elements["comparison-data"].textContent = embedded[0]
  elements.candidate.value = html.match(/<option value="([^"]*)"/)[1]
  const buttons = [...html.matchAll(/data-days="(\d+)"/g)].map(([, days]) => element({ days }))
  const states = []
  const document = { getElementById: id => elements[id], querySelectorAll: () => buttons }
  const LightweightCharts = {
    CandlestickSeries: {},
    createChart (container, options) {
      const state = { container, options, range: null, rangeCalls: 0, callbacks: [] }
      const scale = {
        getVisibleLogicalRange: () => state.range,
        subscribeVisibleLogicalRangeChange: callback => state.callbacks.push(callback),
        setVisibleLogicalRange (range) {
          state.range = JSON.parse(JSON.stringify(range))
          state.rangeCalls++
          assert.ok(state.rangeCalls < 100, "range synchronization must not loop")
          state.callbacks.forEach(callback => callback(range))
        },
      }
      state.chart = {
        timeScale: () => scale,
        addSeries (type, seriesOptions) {
          assert.equal(type, LightweightCharts.CandlestickSeries)
          state.seriesOptions = seriesOptions
          return { setData: (data) => {
            state.data = JSON.parse(JSON.stringify(data))
          } }
        },
      }
      states.push(state)
      return state.chart
    },
  }
  vm.runInNewContext(embedded[2], { window: { document, LightweightCharts }, document }, { timeout: 2000 })
  return { payload, elements, buttons, states }
}

function closeTo (actual, expected) {
  assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`)
}

function checkPrices (state, source, days, report) {
  const index = source.candles.findIndex(candle => candle.time === report.endTime - days * 86400)
  const base = index ? source.candles[index - 1].close : source.previousClose
  assert.equal(state.data.length, days * 96)
  assert.equal(state.data[0].time, report.endTime - days * 86400)
  assert.equal(state.data.at(-1).time, report.endTime - 900)
  for (const position of [0, state.data.length - 1]) {
    for (const [output, input] of [["open", "open"], ["high", "max"], ["low", "min"], ["close", "close"]]) {
      closeTo(state.data[position][output], 100 * (source.candles[index + position][input] / base - 1))
    }
  }
}

function checkScale (states) {
  const ranges = states.map(state => JSON.parse(JSON.stringify(state.seriesOptions.autoscaleInfoProvider().priceRange)))
  assert.deepEqual(ranges[0], ranges[1])
  const bars = states.flatMap(state => state.data)
  const low = Math.min(0, ...bars.map(bar => bar.low))
  const high = Math.max(0, ...bars.map(bar => bar.high))
  const padding = (high - low) * 0.05 || 1
  closeTo(ranges[0].minValue, low - padding)
  closeTo(ranges[0].maxValue, high + padding)
  return ranges[0]
}

test("Markdown shows baseline, both lists, 7/30/full metrics, weekly stability and provisional results without rescaling percentages", () => {
  const { report } = fixture()
  report.candidates[0].profile.windows[0].spikeRatePct = null
  report.candidates[0].profile.windows[2].spikeRatePct = 1.25
  const before = structuredClone(report)
  const markdown = renderPriceComparisonMarkdown(report)
  assert.match(markdown, /Ближе по характеру · до 10/)
  assert.match(markdown, /Меньше выбросов · до 5/)
  assert.equal(markdown.match(/PROVE — эталон \| 0 \| 0 \/ 0 \/ 0/g).length, 2)
  assert.match(markdown, /AAA \| 12,5 \| 12,5 \/ 12,5 \/ 12,5 \| — \/ 0 \/ 1,25/)
  assert.match(markdown, /0,25 \/ 0,25 \/ 0,25 \| 4 \| 12,5 \| 7 \| 0,25 \/ — \| 0,5 \/ 0,2/)
  assert.match(markdown, /7 \/ 30 \/ 58 дней/)
  assert.match(markdown, /2026-02-02 00:00 → 2026-04-01 00:00/)
  assert.match(markdown, /Отчёт: 2026-04-01 00:15 UTC/)
  for (const text of ["конец не включён", "Предварительный результат", "Низкий оборот", "Нет полной сетки 15m", "Ожидает обработки; не оценена", "не процент сходства", "не прогноз", report.warnings[0], report.methodology[0]]) {
    assert.ok(markdown.includes(text), text)
  }
  assert.match(markdown, /DDD · DDD coin \| BINANCE:DDDUSDT.P \| Исключена \| —/)
  assert.deepEqual(report, before)
})

for (const analysisDays of [30, 58, 90]) {
  test(`rare strong candles ${analysisDays}d: unique union, original percentages, null vs zero and unchanged shortlists`, async () => {
    const { report, charts } = fixture(analysisDays)
    const at = (entry, days) => entry.profile.windows.find(window => window.days === days)
    Object.assign(at(report.candidates[0], 30), { maxRangePct: 0, rangeOver3PctRatePct: null })
    Object.assign(at(report.candidates[1], 30), { maxRangePct: null, rangeOver3PctRatePct: 0 })
    if (analysisDays !== 30) {
      at(report.candidates[0], analysisDays).maxRangePct = 21.36
      at(report.candidates[1], analysisDays).maxRangePct = 25.34
    }
    const before = structuredClone(report)
    const markdown = renderPriceComparisonMarkdown(report)
    const html = await renderPriceComparisonHtml(report, charts)
    const markdownSection = markdown.split("## Редкие сильные свечи\n")[1].split("\n## ")[0]
    const htmlSection = html.match(/<section><h2>Редкие сильные свечи<\/h2>([\s\S]*?)<\/section>/)[1]
    const markdownRows = markdownSection.split("\n").filter(line => /^\| (PROVE|AAA|BBB|CCC|DDD)/.test(line))
      .map(line => line.split("|").slice(1, -1).map(cell => cell.trim()))
    const htmlRows = [...htmlSection.matchAll(/<tr>([\s\S]*?)<\/tr>/g)].slice(1)
      .map(([, row]) => [...row.matchAll(/<td>([^<]*)<\/td>/g)].map(([, cell]) => cell))
    assert.deepEqual(markdownRows, [
      ["PROVE — эталон", "11,99", "11,99", "0,25"],
      ["AAA", "0", analysisDays === 30 ? "0" : "21,36", "—"],
      ["BBB", "—", analysisDays === 30 ? "—" : "25,34", "0"],
      ["CCC", "11,99", "11,99", "0,25"],
    ])
    assert.deepEqual(htmlRows, markdownRows)
    for (const section of [markdownSection, htmlSection]) {
      assert.ok(section.includes(`Максимум TR, ${analysisDays}д (весь период), %`))
      assert.ok(section.includes("Меньше относительных выбросов не исключает редкие сильные свечи"))
      assert.ok(section.includes("TR — диапазон с разрывами цены, не доходность между закрытиями (close-to-close)"))
      assert.ok(section.includes("p99 не отражает максимум"))
    }
    for (const output of [markdown, html]) {
      const positions = ["Ближе по характеру · до 10", "Меньше выбросов · до 5", "Редкие сильные свечи", "Все результаты"].map(title => output.indexOf(title))
      assert.ok(positions.every((position, index) => position >= 0 && (!index || position > positions[index - 1])))
    }
    assert.deepEqual(report, before)
  })
}

test("offline HTML embeds only reference plus the deduplicated shortlist union, with all result statistics and attribution", async () => {
  const { report, charts } = fixture()
  const before = structuredClone({ report, charts })
  const html = await renderPriceComparisonHtml(report, charts)
  const embedded = scripts(html)
  assert.equal(embedded.length, 3)
  const payload = JSON.parse(embedded[0])
  assert.deepEqual(payload.report, report)
  assert.deepEqual(payload.charts.map(chart => chart.baseCurrencyId), ["prove", "a", "b", "c"])
  assert.deepEqual(payload.charts, ["prove", "a", "b", "c"].map(id => charts.find(chart => chart.baseCurrencyId === id)))
  const select = html.match(/<select id="candidate"[^>]*>([\s\S]*?)<\/select>/)[1]
  assert.deepEqual([...select.matchAll(/<option value="([^"]*)"/g)].map(([, id]) => id), ["a", "b", "c"])
  assert.deepEqual([...html.matchAll(/data-days="(\d+)" aria-pressed="(true|false)"/g)].map(([, days, pressed]) => [days, pressed]), [["7", "true"], ["30", "false"], ["58", "false"]])
  assert.match(html, /^<!doctype html>/)
  assert.match(html, /<html lang="ru">/)
  assert.match(html, /<details><summary>Все результаты · 4/)
  assert.match(html, /<details><summary>Отказы загрузки · 1/)
  assert.match(html, /<details><summary>Ожидают обработки · pending · 1/)
  assert.match(html, /default-src 'none'/)
  assert.match(html, /href="https:\/\/www.tradingview.com\/"/)
  assert.match(html, /Apache License/)
  assert.match(embedded[1], /TradingView Lightweight Charts/)
  assert.doesNotMatch(html, /<(?:script|link|img)\b[^>]*(?:src|href)\s*=/i)
  assert.doesNotMatch(embedded[2], /\b(?:fetch|XMLHttpRequest|WebSocket|import)\b|innerHTML/)
  embedded.slice(1).forEach(script => assert.doesNotThrow(() => new vm.Script(script)))
  assert.deepEqual({ report, charts }, before)
})

for (const analysisDays of [58, 90, 30]) {
  test(`chart ${analysisDays}d: previous-close percentage OHLC, common scale and synchronized zoom, initially 7d`, async () => {
    const { report, charts } = fixture(analysisDays)
    const { states, elements, buttons } = mount(await renderPriceComparisonHtml(report, charts))
    assert.deepEqual(buttons.map(button => Number(button.dataset.days)), [...new Set([7, 30, analysisDays])])
    const reference = charts.find(chart => chart.baseCurrencyId === "prove")
    const candidate = charts.find(chart => chart.baseCurrencyId === "a")
    checkPrices(states[0], reference, 7, report)
    checkPrices(states[1], candidate, 7, report)
    checkScale(states)
    assert.equal(states[0].options.layout.attributionLogo, true)
    assert.equal(states[0].options.rightPriceScale.mode, 0)
    assert.equal(states[0].options.handleScale.axisPressedMouseMove.price, false)
    assert.equal(states[0].seriesOptions.priceFormat.formatter(1.25), "1,25%")
    assert.equal(states[0].options.localization.timeFormatter(report.endTime), "2026-04-01 00:00 UTC")
    assert.match(elements["chart-period"].textContent, /7 дней.*конец не включён/)
    for (const button of buttons) {
      button.click()
      const days = Number(button.dataset.days)
      checkPrices(states[0], reference, days, report)
      checkPrices(states[1], candidate, days, report)
      assert.deepEqual(states[0].range, { from: -0.5, to: days * 96 - 0.5 })
      assert.deepEqual(states[0].range, states[1].range)
      assert.deepEqual(buttons.map(control => control.attributes["aria-pressed"]), buttons.map(control => String(control === button)))
      checkScale(states)
    }
    closeTo(states[0].data[0].open, 25)
    elements.candidate.value = "c"
    elements.candidate.change()
    checkPrices(states[1], charts.find(chart => chart.baseCurrencyId === "c"), analysisDays, report)
    assert.match(elements["candidate-title"].textContent, /CCC · BINANCE:CCCUSDT.P/)
    const scaleBefore = checkScale(states)
    const firstPriceBefore = states[0].data[0].open
    states[0].chart.timeScale().setVisibleLogicalRange({ from: 100, to: 200 })
    assert.deepEqual(states[1].range, { from: 100, to: 200 })
    states[1].chart.timeScale().setVisibleLogicalRange({ from: 150, to: 250 })
    assert.deepEqual(states[0].range, { from: 150, to: 250 })
    assert.deepEqual(checkScale(states), scaleBefore)
    assert.equal(states[0].data[0].open, firstPriceBefore)
  })
}

test("empty lists, absent chart data and unavailable full-window previousClose have explicit messages without exceptions", async () => {
  const { report, charts } = fixture()
  report.closest = []
  report.calmer = []
  report.candidates = []
  assert.match(renderPriceComparisonMarkdown(report), /Подборка пуста: ниже только эталон/)
  const html = await renderPriceComparisonHtml(report, charts)
  assert.match(html, /<select id="candidate" disabled>/)
  assert.match(html, /Подборки пусты: можно рассмотреть только эталон/)
  const alone = mount(html)
  assert.deepEqual(alone.payload.charts.map(chart => chart.baseCurrencyId), ["prove"])
  assert.equal(alone.states[0].data.length, 672)
  assert.equal(alone.states[1].data.length, 0)
  assert.equal(alone.elements["candidate-chart"].hidden, true)
  const empty = mount(await renderPriceComparisonHtml(report, []))
  assert.ok(empty.states.every(state => state.data.length === 0))
  assert.match(empty.elements["chart-status"].textContent, /PROVE: нет свечей или previousClose/)
  charts.find(chart => chart.baseCurrencyId === "prove").previousClose = null
  const partial = mount(await renderPriceComparisonHtml(report, charts))
  assert.equal(partial.states[0].data.length, 672)
  partial.buttons.at(-1).click()
  assert.equal(partial.states[0].data.length, 0)
  assert.match(partial.elements["chart-status"].textContent, /previousClose/)
})

test("a missing candidate chart is not substituted; a zero-range pair keeps a valid common scale", async () => {
  const { report, charts } = fixture()
  const missing = mount(await renderPriceComparisonHtml(report, charts.filter(chart => chart.baseCurrencyId !== "a")))
  assert.equal(missing.states[0].data.length, 672)
  assert.equal(missing.states[1].data.length, 0)
  assert.match(missing.elements["chart-status"].textContent, /AAA: нет свечей/)
  missing.elements.candidate.value = "b"
  missing.elements.candidate.change()
  assert.equal(missing.states[1].data.length, 672)
  charts.forEach((chart) => {
    chart.previousClose = 100
    chart.candles.forEach(candle => Object.assign(candle, { open: 100, max: 100, min: 100, close: 100 }))
  })
  const flat = mount(await renderPriceComparisonHtml(report, charts))
  assert.deepEqual(checkScale(flat.states), { minValue: -1, maxValue: 1 })
  assert.equal(flat.states[0].data[0].open, 0)
})

test("HTML text, attributes, Markdown and inline JSON escape hostile symbols, IDs, reasons and warnings", async () => {
  const { report, charts } = fixture()
  const unsafe = "</ScRiPt><img src=x onerror=alert(1)>&\"'\u2028\u2029\n|[link](javascript:alert(1))"
  report.reference.symbol = unsafe
  Object.assign(report.candidates[0], { baseCurrencyId: unsafe, symbol: unsafe, name: unsafe, marketSymbol: unsafe, exclusions: [unsafe] })
  report.closest[0] = unsafe
  Object.assign(charts.find(chart => chart.baseCurrencyId === "a"), { baseCurrencyId: unsafe, symbol: unsafe })
  report.warnings = [unsafe]
  report.methodology = [unsafe]
  report.rejected[0].reason = unsafe
  report.pending[0].name = unsafe
  const html = await renderPriceComparisonHtml(report, charts)
  const embedded = scripts(html)
  assert.equal(embedded.length, 3)
  assert.doesNotMatch(embedded[0], /[<\u2028\u2029]/)
  assert.match(embedded[0], /\\u003c\/ScRiPt>/)
  assert.match(embedded[0], /\\u2028\\u2029/)
  assert.deepEqual(JSON.parse(embedded[0]).report, report)
  assert.doesNotMatch(html, /<img src=x|<\/ScRiPt>/)
  assert.match(html, /<option value="&lt;\/ScRiPt&gt;/)
  assert.match(html, /&amp;&quot;&#39;/)
  const markdown = renderPriceComparisonMarkdown(report)
  assert.doesNotMatch(markdown, /<img|\n\|\[link\]/)
  assert.ok(markdown.includes("\\|\\[link\\]"))
})
