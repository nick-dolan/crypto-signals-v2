import assert from "node:assert/strict"
import fs from "node:fs/promises"
import test from "node:test"
import vm from "node:vm"

import { isArray, isFinite, isFunction, isSafeInteger, isString } from "../src/helpers/utils.typed.js"
import { createChartUpdater } from "../src/steps/step11-report/chart-update.js"

const script = new vm.Script(
  await fs.readFile(new URL("../src/steps/step11-report/report.js", import.meta.url), "utf8"),
  { filename: "report.js" },
)
const template = await fs.readFile(new URL("../src/steps/step11-report/report.html", import.meta.url), "utf8")

// Only the DOM operations used by report.js; no layout, HTML parsing or event bubbling.
function createNode (tagName = "div") {
  let text = ""
  return {
    tagName: tagName.toUpperCase(),
    children: [],
    dataset: {},
    style: {},
    attributes: new Map(),
    listeners: new Map(),
    value: "",
    hidden: false,
    disabled: false,
    open: false,
    get textContent () {
      return text + this.children.map(child => child.textContent).join("")
    },
    set textContent (value) {
      text = String(value)
      this.children = []
    },
    append (...children) {
      this.children.push(...children)
      children.forEach((child) => {
        child.parentElement = this
      })
    },
    replaceChildren (...children) {
      this.textContent = ""
      this.append(...children)
    },
    setAttribute (name, value) {
      this.attributes.set(name, String(value))
    },
    addEventListener (name, listener) {
      this.listeners.set(name, listener)
    },
    closest (selector) {
      assert.equal(selector, "[data-symbol]")
      return this.dataset.symbol != null ? this : this.parentElement?.closest(selector) ?? null
    },
  }
}

function createChart (container, options) {
  const panes = []
  return {
    container,
    options,
    series: [],
    ranges: [],
    removed: false,
    addSeries (type, options, paneIndex = 0) {
      panes[paneIndex] ??= {
        setStretchFactor (value) {
          this.stretchFactor = value
        },
      }
      const scale = {
        applyOptions (value) {
          this.options = value
        },
      }
      const series = {
        type,
        options,
        paneIndex,
        data: [],
        setData (points) {
          // VM objects have different prototypes; record data in the test's realm.
          this.data = structuredClone(points)
        },
        priceScale: () => scale,
      }
      this.series.push(series)
      return series
    },
    timeScale () {
      return {
        setVisibleRange: (range) => {
          this.ranges.push(structuredClone(range))
        },
      }
    },
    panes: () => panes,
    subscribeCrosshairMove (listener) {
      this.crosshair = listener
    },
    remove () {
      this.removed = true
    },
  }
}

function runReport (report, { updateChartHistory = () => assert.fail("Unexpected chart update") } = {}) {
  const nodes = new Map([...template.matchAll(/<[^>]+\bid="([^"]+)"[^>]*>/g)].map(([tag, id]) => {
    const node = createNode()
    node.hidden = /\bhidden\b/.test(tag)
    return [id, node]
  }))
  const byId = id => nodes.get(id) ?? null
  const days = [...template.matchAll(/<button\b[^>]*data-days="(\d+)"[^>]*>/g)].map(([tag, value]) => {
    const node = createNode()
    node.dataset.days = value
    node.setAttribute("aria-pressed", tag.match(/aria-pressed="([^"]+)"/)[1])
    return node
  })
  byId("report-data").textContent = JSON.stringify(report)
  byId("sort").value = "probability"
  const charts = []
  const markers = []
  const updateCalls = []
  const directRequests = []
  script.runInNewContext({
    URL,
    updateChartHistory: (coin, asOf, previous) => {
      updateCalls.push({ coin, asOf, previous })
      return updateChartHistory(coin, asOf, previous)
    },
    fetch: (...args) => {
      directRequests.push(args)
      assert.fail("report.js must not bypass the injected updater")
    },
    document: {
      getElementById: byId,
      createElement: createNode,
      querySelectorAll (selector) {
        if (selector === "[data-days]") {
          return days
        }
        assert.equal(selector, ".top-card")
        return byId("top-candidates").children.filter(node => node.className === "top-card")
      },
    },
    LightweightCharts: {
      ColorType: { Solid: "solid" },
      CrosshairMode: { Normal: 0 },
      CandlestickSeries: "Candlestick",
      HistogramSeries: "Histogram",
      LineSeries: "Line",
      createSeriesMarkers (series, points) {
        const plugin = { series, data: structuredClone(points) }
        markers.push(plugin)
        return plugin
      },
      createChart (container, options) {
        const chart = createChart(container, options)
        charts.push(chart)
        return chart
      },
    },
  }, { timeout: 1_000 })
  return { byId, charts, days, markers, updateCalls, directRequests }
}

function click (node, target = node) {
  assert.ok(isFunction(node.listeners.get("click")))
  return node.listeners.get("click")({ target })
}

function createReport (symbols = ["COTI"]) {
  const report = {
    asOf: "2026-09-15T09:00:00.000Z",
    reportCreatedAt: "2026-09-15T11:37:42.123Z",
    timeframe: "1h",
    objective: "P сильного движения в следующие 4–12 часов",
    candidateCount: symbols.length,
    universeCoinCount: 30,
    marketContext: { breadth4h: 0.6 },
    marketDefinitions: { breadth4h: "Доля растущих монет" },
    definitions: { rvRatio: "Соотношение волатильности" },
    flagDefinitions: { coiling: "Сжатие и растущий OI" },
  }
  report.coins = symbols.map((symbol, index) => {
    const candles = Array.from({ length: 168 }, (_, hour) => ({
      time: Date.parse(report.asOf) / 1_000 - (167 - hour) * 3_600,
      open: 100 + hour,
      high: 102 + hour,
      low: 99 + hour,
      close: 101 + hour,
    }))
    return {
      symbol,
      name: `${symbol} coin`,
      marketSymbol: `BINANCE:${symbol}USDT.P`,
      topRank: index + 1,
      movementProbability: 0.8 - index * 0.1,
      directionBias: "up",
      estimateConfidence: "medium",
      explanation: `Оценка ${symbol}`,
      drivers: ["rvRatio=0.6: Сжатие волатильности"],
      counterSignals: ["Нет подтверждения объёмом"],
      features: { rvRatio: 0.6, socialStatus: "unavailable", flags: ["coiling"] },
      history: {
        candles,
        volume: candles.map(({ time }, hour) => ({ time, value: 1_000 + hour })),
        openInterest: candles.map(({ time }, hour) => ({ time, value: 10_000 + hour })),
        warning: null,
      },
    }
  })
  return report
}

test("report displays directional pattern labels and new numeric features", () => {
  for (const [flag, label] of [
    ["range_pressure_up", "Давление на верхнюю границу"],
    ["range_pressure_down", "Давление на нижнюю границу"],
    ["short_squeeze_setup", "Условия для short squeeze ↑"],
    ["long_squeeze_setup", "Условия для long squeeze ↓"],
  ]) {
    const report = createReport()
    Object.assign(report.coins[0].features, {
      distanceToHigh24hAtr: -0.25, distanceToLow24hAtr: 2.75, fundingRate: -1e-12, oiLevelPctile: 0.9, flags: [flag],
    })
    const { byId } = runReport(report)

    assert.ok(byId("flags").textContent.includes(label))
    assert.ok(byId("feature-rows").textContent.includes(label))
    for (const value of ["distanceToHigh24hAtr", "distanceToLow24hAtr", "fundingRate", "oiLevelPctile", "-0.25", "-1e-12"]) {
      assert.ok(byId("feature-rows").textContent.includes(value))
    }
  }
})

for (const [status, label, history, current, historyText, currentText] of [
  ["persistent", "Устойчиво сильная", 81.412, 91.235, "81,4 / 100", "91,2 / 100"],
  ["emerging", "Сила появляется", 37.555, 83.333, "37,6 / 100", "83,3 / 100"],
  ["fading", "Сила ослабевает", 82.345, 64.999, "82,3 / 100", "65 / 100"],
  ["neutral", "Не выделяется", 0, 0, "0 / 100", "0 / 100"],
  ["insufficient_data", "Недостаточно данных", null, 73.35, "Нет данных", "73,4 / 100"],
]) {
  test(`sustained strength card shows saved ${status} status and scores without recalculating them`, () => {
    const report = createReport()
    Object.assign(report.coins[0].features, {
      sustainedStatus: status, sustainedHistoryScore: history, sustainedCurrentScore: current,
      sustainedDownWinRate: 0.65, sustainedDownPositiveRate: 0.2, sustainedDownExcessMedianPct: 0.45,
      sustainedUpParticipationRate: 0.6, sustainedExcess24hPct: 0.23,
    })
    Object.assign(report.definitions, {
      sustainedStatus: "Готовый статус",
      sustainedHistoryScore: "Историческая оценка 0–100",
      sustainedCurrentScore: "Текущая оценка 0–100",
    })
    const before = structuredClone(report)
    const { byId, updateCalls, directRequests } = runReport(report)

    assert.equal(byId("sustained-strength").dataset.status, status)
    assert.equal(byId("sustained-strength-status").textContent, label)
    assert.equal(byId("sustained-strength-status").title, report.definitions.sustainedStatus)
    assert.equal(byId("sustained-strength-history").textContent, historyText)
    assert.equal(byId("sustained-strength-current").textContent, currentText)
    assert.equal(byId("sustained-strength-history").title, report.definitions.sustainedHistoryScore)
    assert.equal(byId("sustained-strength-current").title, report.definitions.sustainedCurrentScore)
    for (const [field, value] of Object.entries(report.coins[0].features).filter(([key]) => key.startsWith("sustained"))) {
      const row = byId("feature-rows").children.find(node => node.children[0].textContent === field)
      assert.equal(row.children[1].textContent, value === null ? "Нет данных / события" : String(value))
    }
    assert.equal(updateCalls.length, 0)
    assert.equal(directRequests.length, 0)
    assert.deepEqual(report, before)
    assert.deepEqual(JSON.parse(byId("report-data").textContent), before)
  })
}

for (const [label, features, history, current] of [
  ["legacy missing fields", {}, "Нет данных", "Нет данных"],
  ["unavailable history", { sustainedStatus: "insufficient_data", sustainedHistoryScore: null, sustainedCurrentScore: 0 }, "Нет данных", "0 / 100"],
  ["unavailable current score", { sustainedStatus: "insufficient_data", sustainedHistoryScore: 100, sustainedCurrentScore: null }, "100 / 100", "Нет данных"],
]) {
  test(`sustained strength card handles ${label} without hiding available scores`, () => {
    const report = createReport()
    Object.assign(report.coins[0].features, features)
    const { byId } = runReport(report)

    assert.equal(byId("sustained-strength").dataset.status, "insufficient_data")
    assert.equal(byId("sustained-strength-status").textContent, "Недостаточно данных")
    assert.equal(byId("sustained-strength-history").textContent, history)
    assert.equal(byId("sustained-strength-current").textContent, current)
    assert.equal(byId("sustained-strength-history").title, "")
    assert.equal(byId("sustained-strength-current").title, "")
  })
}

test("sustained strength status cannot inject markup or an arbitrary color state", () => {
  for (const status of ["unknown", "__proto__", "</script><img src=x onerror=alert(1)>"]) {
    const report = createReport()
    report.coins[0].features.sustainedStatus = status
    const { byId } = runReport(report)
    assert.equal(byId("sustained-strength").dataset.status, "insufficient_data")
    assert.equal(byId("sustained-strength-status").textContent, "Недостаточно данных")
    assert.deepEqual(byId("sustained-strength-status").children, [])
  }
})

test("switching coins replaces sustained strength and clears values for a legacy coin", () => {
  const report = createReport(["COTI", "SOL", "ADA"])
  Object.assign(report.coins[0].features, {
    sustainedStatus: "persistent", sustainedHistoryScore: 80, sustainedCurrentScore: 90,
  })
  Object.assign(report.coins[1].features, {
    sustainedStatus: "fading", sustainedHistoryScore: 75, sustainedCurrentScore: 30,
  })
  const browser = runReport(report)
  const view = () => [
    browser.byId("sustained-strength").dataset.status,
    ...["sustained-strength-status", "sustained-strength-history", "sustained-strength-current"]
      .map(id => browser.byId(id).textContent),
  ]
  const initial = view()
  assert.deepEqual(initial, ["persistent", "Устойчиво сильная", "80 / 100", "90 / 100"])
  selectCoin(browser, "SOL")
  assert.deepEqual(view(), ["fading", "Сила ослабевает", "75 / 100", "30 / 100"])
  selectCoin(browser, "ADA")
  assert.deepEqual(view(), ["insufficient_data", "Недостаточно данных", "Нет данных", "Нет данных"])
  selectCoin(browser, "COTI")
  assert.deepEqual(view(), initial)
  assert.equal(browser.updateCalls.length, 0)
  assert.equal(browser.directRequests.length, 0)
})

function addOiGaps (report) {
  const { history } = report.coins[0]
  const timeAt = index => history.candles[index].time
  const segments = [
    [{ time: timeAt(160), value: 10 }, { time: timeAt(161), value: 20 }],
    [{ time: timeAt(164), value: 30 }],
    [{ time: timeAt(166), value: 0 }, { time: timeAt(167), value: 40 }],
  ]
  const values = new Map(segments.flat().map(point => [point.time, point]))
  const omittedTime = timeAt(165)
  history.openInterest = history.openInterest
    .filter(point => point.time !== omittedTime)
    .map(({ time }) => values.get(time) ?? { time })
  history.candles = history.candles.filter(point => point.time !== omittedTime)
  history.volume = history.volume.filter(point => point.time !== omittedTime)
  history.warning = "Open Interest: отсутствующие значения оставлены пропусками"
  return segments
}

function addInformation (report) {
  report.informationSources = {
    news: { from: "2026-09-14T10:45:00.000Z", asOf: "2026-09-15T10:45:00.000Z" },
    twitter: { from: "2026-09-14T11:00:00.000Z", asOf: "2026-09-15T11:00:00.000Z" },
    contextGeneratedAt: "2026-09-15T11:05:00.000Z",
  }
  report.coins[0].explanation = "Исходная оценка. Дополненное объяснение из шага 10."
  report.coins[0].information = {
    news: {
      status: "available", error: null,
      items: [{
        title: "Новость про монету", publishedAt: "2026-09-15T10:30:00.000Z",
        provider: { name: "Crypto News" }, externalUrl: "https://example.com/news",
        tradingViewUrl: "https://www.tradingview.com/news/story/",
        shortDescription: "Краткое описание", content: "Полный сохранённый текст\nВторой абзац",
      }],
    },
    twitter: {
      status: "available", error: null,
      tweets: [{
        id: "1234567890123456789", authorUsername: "researcher", text: "Публикация о монете\nПодробности",
        createdAt: "2026-09-15T10:50:00.000Z", likeCount: 12, retweetCount: 3, viewCount: 456, authorFollowers: 1000,
      }],
    },
  }
  return report.coins[0].information
}

function descendants (node) {
  return node.children.flatMap(child => [child, ...descendants(child)])
}

function oiLegend (byId) {
  return byId("chart-legend").children.at(-1).textContent
}

function chartTime (report, hours = 0) {
  return Date.parse(report.asOf) / 1_000 + hours * 3_600
}

function createUpdate (report, coin = report.coins[0], hours = 5) {
  const history = structuredClone(coin.history)
  const candles = Array.from({ length: hours }, (_, index) => ({
    time: chartTime(report, index + 1), open: 300 + index, high: 302 + index, low: 299 + index, close: 301 + index,
  }))
  history.candles.push(...candles)
  history.volume.push(...candles.map(({ time }, index) => ({ time, value: 2_000 + index })))
  history.openInterest.push(...candles.map(({ time }, index) => ({ time, value: 20_000 + index })))
  return {
    history,
    updatedAt: new Date(chartTime(report, hours) * 1_000 + 1_800_000).toISOString(),
    formingTime: chartTime(report, hours),
    currentOiAt: new Date(chartTime(report, hours) * 1_000 + 1_799_000).toISOString(),
    sourceFrom: chartTime(report, 1),
    oiSourceFrom: chartTime(report, 1),
  }
}

function controlledUpdater () {
  const requests = []
  return {
    requests,
    updateChartHistory () {
      const pending = Promise.withResolvers()
      requests.push(pending)
      return pending.promise
    },
  }
}

function selectCoin (browser, symbol) {
  const row = browser.byId("candidate-rows").children.find(node => node.dataset.symbol === symbol)
  assert.ok(row, `Missing candidate ${symbol}`)
  return click(browser.byId("candidate-rows"), row)
}

function chartSeries (chart, type) {
  return chart.series.find(series => series.type === type)
}

function chartMarkers (browser, chart = browser.charts.at(-1)) {
  return browser.markers.filter(plugin => chart.series.includes(plugin.series)).flatMap(plugin => plugin.data)
}

function hoverChart (chart, time) {
  const seriesData = new Map(chart.series.flatMap((series) => {
    const point = series.data.find(point => point.time === time && (point.close != null || point.value != null))
    return point ? [[series, point]] : []
  }))
  chart.crosshair({ time, seriesData })
}

function createBinanceApi (report) {
  const requests = []
  const state = { now: chartTime(report, 5) * 1_000 + 1_200_000, close: 400, volume: 2_500, currentOi: 6_000 }
  return {
    requests,
    state,
    async fetch (url, options) {
      url = new URL(url)
      requests.push({ url, options })
      const symbol = url.searchParams.get("symbol")
      if (url.pathname === "/fapi/v1/time") {
        return new Response(JSON.stringify({ serverTime: state.now }))
      }
      if (url.pathname === "/fapi/v1/openInterest") {
        return new Response(JSON.stringify({ symbol, openInterest: String(state.currentOi), time: state.now - 1_000 }))
      }

      const hours = Math.floor(state.now / 3_600_000) - chartTime(report) / 3_600
      let rows
      if (url.pathname === "/fapi/v1/klines") {
        rows = Array.from({ length: hours }, (_, index) => {
          const open = 300 + index
          const close = index === hours - 1 ? state.close : open + 1
          return [
            chartTime(report, index + 1) * 1_000, String(open), String(Math.max(open, close) + 1),
            String(Math.min(open, close) - 1), String(close), String(index === hours - 1 ? state.volume : 2_000 + index),
          ]
        })
      } else {
        assert.equal(url.pathname, "/futures/data/openInterestHist")
        rows = Array.from({ length: hours - 1 }, (_, index) => ({
          symbol,
          timestamp: chartTime(report, index + 2) * 1_000,
          sumOpenInterest: String(10_002 + index),
          sumOpenInterestValue: "999999999999",
        }))
      }
      return new Response(JSON.stringify(rows.filter((row) => {
        const timestamp = isArray(row) ? row[0] : row.timestamp
        return timestamp >= Number(url.searchParams.get("startTime")) && timestamp <= Number(url.searchParams.get("endTime"))
      }).slice(0, Number(url.searchParams.get("limit")))))
    },
  }
}

test("initializes the first ranked top candidate, hourly whitespace grid and three-day range", () => {
  const report = createReport(["PLAIN", "SECOND", "FIRST"])
  report.coins[0].topRank = null
  report.coins[0].movementProbability = 0.1
  report.coins[2].topRank = 1
  report.coins[2].movementProbability = 0.9
  const { history } = report.coins[2]
  const times = history.candles.map(point => point.time)
  for (const key of ["candles", "volume", "openInterest"]) {
    history[key] = history[key].filter((_, index) => index >= 5 && index !== 80)
  }
  const { byId, charts, days } = runReport(report)
  assert.equal(byId("coin-symbol").textContent, "FIRST")
  assert.equal(byId("as-of").dateTime, report.asOf)
  assert.equal(byId("coin-detail").hidden, false)
  assert.equal(byId("no-candidates").hidden, true)
  assert.equal(byId("candidate-rows").children.length, 3)
  assert.deepEqual(byId("top-candidates").children.map(node => node.dataset.symbol), ["FIRST", "SECOND"])
  assert.deepEqual(byId("top-candidates").children.map(node => node.attributes.get("aria-pressed")), ["true", "false"])
  assert.equal(charts.length, 1)
  const [chart] = charts
  assert.equal(chart.container, byId("chart"))
  assert.equal(chart.panes().length, 3)
  for (const [type, paneIndex] of [["Candlestick", 0], ["Histogram", 1]]) {
    const series = chart.series.find(series => series.type === type)
    assert.equal(series.paneIndex, paneIndex)
    assert.equal(series.data.length, 168)
    assert.deepEqual(series.data.map(point => point.time), times)
    assert.deepEqual(series.data[0], { time: times[0] })
    assert.deepEqual(series.data[80], { time: times[80] })
    assert.equal(series.data.at(-1).time, Date.parse(report.asOf) / 1_000)
  }
  assert.deepEqual(chart.ranges.at(-1), {
    from: Date.parse("2026-09-12T10:00:00.000Z") / 1_000,
    to: Date.parse(report.asOf) / 1_000,
  })
  assert.deepEqual(days.map(node => node.attributes.get("aria-pressed")), ["false", "true", "false"])
  for (const [value, from] of [["1", "2026-09-14T10:00:00.000Z"], ["7", "2026-09-08T10:00:00.000Z"]]) {
    click(days.find(node => node.dataset.days === value))
    assert.deepEqual(chart.ranges.at(-1), { from: Date.parse(from) / 1_000, to: times.at(-1) })
    assert.deepEqual(days.map(node => node.attributes.get("aria-pressed")), days.map(node => String(node.dataset.days === value)))
  }
  assert.equal(byId("chart-empty").hidden, true)
})

test("tiny prices use a custom formatter and nonzero scientific values in the price and legend", () => {
  const report = createReport()
  report.coins[0].history.candles = report.coins[0].history.candles.map(({ time }) => ({
    time, open: 9.9e-13, high: 1.2e-12, low: 9.9e-13, close: 1.1e-12,
  }))
  const { byId, charts } = runReport(report)
  assert.equal(charts.length, 1)
  assert.equal(charts[0].removed, false)
  assert.equal(byId("chart").hidden, false)
  assert.equal(byId("chart-empty").hidden, true)
  const candles = charts[0].series.find(series => series.type === "Candlestick")
  assert.equal(candles.data[0].low, 9.9e-13)
  assert.equal(candles.options.priceFormat.type, "custom")
  assert.ok(isFunction(candles.options.priceFormat.formatter))
  for (const text of [
    candles.options.priceFormat.formatter(9.9e-13),
    byId("last-price").textContent,
    ...byId("chart-legend").children.slice(1, 5).map(node => node.children[0].textContent),
  ]) {
    assert.match(text, /E[-−]\d+/i)
    const value = Number(text.replace(/\s/g, "").replace(",", ".").replace("−", "-"))
    assert.ok(isFinite(value) && value > 0 && value < 1e-11, text)
  }
})

test("OI series never bridge whitespace or missing hours and expose isolated points", () => {
  const report = createReport()
  const expected = addOiGaps(report)
  const { byId, charts } = runReport(report)
  const series = charts[0].series.filter(series => series.paneIndex === 2)
  assert.equal(byId("chart-empty").hidden, true)
  assert.equal(series.length, 3)
  assert.ok(series.every(series => series.type === "Line"))
  const segments = series.map(series => series.data.filter(point => isFinite(point.value)))
  assert.deepEqual(segments, expected)
  for (const segment of segments) {
    for (let index = 1; index < segment.length; index += 1) {
      assert.equal(segment[index].time - segment[index - 1].time, 3_600)
    }
  }
  assert.equal(series[1].options.pointMarkersVisible, true)
  assert.equal(byId("history-warning").hidden, false)
})

test("OI tooltip uses the exact hour across segments, distinguishes missing from zero and resets on leave", () => {
  const report = createReport()
  const segments = addOiGaps(report)
  const { byId, charts } = runReport(report)
  const [chart] = charts
  assert.ok(isFunction(chart.crosshair))
  const hover = (time) => {
    const seriesData = new Map(chart.series.flatMap((series) => {
      const point = series.data.find(point => point.time === time && (point.value != null || point.close != null))
      return point ? [[series, point]] : []
    }))
    chart.crosshair({ time, seriesData })
  }
  assert.equal(oiLegend(byId), "OI 40")
  hover(segments[0][1].time + 3_600)
  assert.equal(oiLegend(byId), "OI —")
  hover(segments[1][0].time)
  assert.equal(oiLegend(byId), "OI 30")
  hover(segments[1][0].time + 3_600)
  assert.equal(oiLegend(byId), "OI —")
  hover(segments[2][0].time)
  assert.equal(oiLegend(byId), "OI 0")
  chart.crosshair({ seriesData: new Map() })
  assert.equal(oiLegend(byId), "OI 40")
})

for (const shape of ["whitespace", "empty"]) {
  test(`unavailable OI (${shape}) retains an empty third pane without hiding price history`, () => {
    const report = createReport()
    const { history } = report.coins[0]
    history.openInterest = shape === "empty" ? [] : history.openInterest.map(({ time }) => ({ time }))
    history.warning = "Open Interest: нет данных"
    const { byId, charts } = runReport(report)
    assert.equal(charts.length, 1)
    assert.equal(charts[0].panes().length, 3)
    const series = charts[0].series.filter(series => series.paneIndex === 2)
    assert.equal(series.length, 1)
    assert.equal(series[0].type, "Line")
    assert.ok(series[0].data.every(point => point.value == null))
    assert.equal(byId("chart").hidden, false)
    assert.equal(byId("chart-empty").hidden, true)
    assert.equal(byId("history-warning").textContent, history.warning)
    assert.equal(oiLegend(byId), "OI —")
  })
}

test("missing history preserves assessment and empty state before and after switching coins", () => {
  const report = createReport(["MISSING", "AVAILABLE"])
  report.coins[0].history = { candles: [], volume: [], openInterest: [], warning: "История недоступна" }
  const { byId, charts, days } = runReport(report)
  const assertEmptyHistory = () => {
    assert.equal(byId("coin-symbol").textContent, "MISSING")
    assert.equal(byId("coin-detail").hidden, false)
    assert.equal(byId("no-candidates").hidden, true)
    assert.equal(byId("chart").hidden, true)
    assert.equal(byId("chart-empty").hidden, false)
    assert.equal(byId("last-price").textContent, "—")
    assert.equal(byId("chart-legend").children.length, 0)
    assert.equal(byId("history-warning").hidden, false)
    assert.equal(byId("history-warning").textContent, "История недоступна")
    assert.equal(byId("explanation").hidden, false)
    assert.equal(byId("explanation").textContent, report.coins[0].explanation)
    assert.match(byId("drivers").textContent, /Сжатие волатильности/)
    assert.equal(byId("counter-signals").textContent, report.coins[0].counterSignals[0])
    assert.equal(byId("feature-rows").children.length, Object.keys(report.coins[0].features).length)
  }
  assertEmptyHistory()
  assert.equal(charts.length, 0)
  click(days.find(node => node.dataset.days === "7"))
  click(byId("top-candidates"), byId("top-candidates").children[1].children[0])
  assert.equal(charts.length, 1)
  assert.equal(byId("coin-symbol").textContent, "AVAILABLE")
  assert.equal(byId("chart").hidden, false)
  assert.equal(byId("chart-empty").hidden, true)
  assert.equal(byId("history-warning").hidden, true)
  assert.equal(charts[0].ranges.at(-1).from, Date.parse("2026-09-08T10:00:00.000Z") / 1_000)
  const row = byId("candidate-rows").children.find(node => node.dataset.symbol === "MISSING")
  click(byId("candidate-rows"), row.children[0].children[0].children[0])
  assert.equal(charts[0].removed, true)
  assert.equal(charts.length, 1)
  assertEmptyHistory()
})

test("an empty candidate list renders its empty states without creating a chart", () => {
  const { byId, charts, days } = runReport(createReport([]))
  assert.equal(charts.length, 0)
  assert.equal(byId("candidate-count").textContent, "0")
  assert.equal(byId("no-candidates").hidden, false)
  assert.equal(byId("coin-detail").hidden, true)
  assert.match(byId("top-candidates").textContent, /не выделил лучших кандидатов/)
  assert.equal(byId("candidate-rows").textContent, "Ничего не найдено")
  assert.equal(byId("search-results").textContent, "Показано 0 из 0")
  days.forEach(node => click(node))
  assert.equal(charts.length, 0)
  assert.equal(byId("coin-detail").hidden, true)
})

test("top candidates show enriched explanations, news, tweets and their independent collection times", () => {
  const report = createReport()
  addInformation(report)
  const { byId } = runReport(report)
  assert.equal(byId("information-panel").hidden, false)
  assert.equal(byId("news-details").open, false)
  assert.equal(byId("twitter-details").open, false)
  assert.equal(byId("explanation").textContent, report.coins[0].explanation)
  assert.match(byId("analysis-source").textContent, /шаге 10/)
  assert.match(byId("context-generated").textContent, /11:05/)
  assert.match(byId("news-window").textContent, /10:45/)
  assert.match(byId("twitter-window").textContent, /11:00/)
  assert.equal(byId("as-of").dateTime, report.asOf)
  assert.equal(byId("news-count").textContent, "1")
  assert.equal(byId("twitter-count").textContent, "1")
  assert.equal(byId("news-status").hidden, true)
  assert.equal(byId("twitter-status").hidden, true)
  assert.match(byId("news-items").textContent, /Crypto News.*10:30/)
  assert.match(byId("news-items").textContent, /Полный сохранённый текст\nВторой абзац/)
  assert.match(byId("twitter-items").textContent, /@researcher.*10:50/)
  assert.match(byId("twitter-items").textContent, /Лайки: 12.*Репосты: 3.*Просмотры: 456/)
  const links = [...descendants(byId("news-items")), ...descendants(byId("twitter-items"))].filter(node => node.tagName === "A")
  assert.deepEqual(links.map(link => link.href), ["https://example.com/news", "https://www.tradingview.com/news/story/", "https://x.com/i/status/1234567890123456789"])
  assert.ok(links.every(link => link.target === "_blank" && link.rel === "noopener noreferrer"))
})

test("empty searches and failed sources have distinct messages, while missing article text stays visible", () => {
  const report = createReport(["EMPTY", "ARTICLE"])
  const information = addInformation(report)
  report.coins[1].information = structuredClone(information)
  const item = report.coins[1].information.news.items[0]
  item.content = null
  item.shortDescription = null
  item.paywall = true
  information.news = { status: "empty", error: null, items: [] }
  information.twitter = { status: "failed", error: "Rate limit", tweets: [] }
  const { byId } = runReport(report)
  assert.equal(byId("news-status").hidden, false)
  assert.match(byId("news-status").textContent, /ничего не найдено/)
  assert.match(byId("twitter-status").textContent, /Ошибка загрузки: Rate limit/)
  assert.equal(byId("twitter-count").textContent, "ошибка")
  assert.equal(byId("news-items").children.length, 0)
  assert.equal(byId("twitter-items").children.length, 0)
  click(byId("top-candidates"), byId("top-candidates").children[1])
  assert.equal(byId("news-status").hidden, true)
  assert.match(byId("news-items").textContent, /Новость про монету/)
  assert.match(byId("news-items").textContent, /ограниченный доступ/)
})

test("switching to a non-top candidate clears and hides all source data and collapses the source panels", () => {
  const report = createReport(["TOP", "PLAIN"])
  report.coins[1].topRank = null
  addInformation(report)
  const { byId } = runReport(report)
  byId("news-details").open = true
  byId("twitter-details").open = true
  const row = byId("candidate-rows").children.find(node => node.dataset.symbol === "PLAIN")
  click(byId("candidate-rows"), row)
  assert.equal(byId("information-panel").hidden, true)
  assert.equal(byId("news-items").children.length, 0)
  assert.equal(byId("twitter-items").children.length, 0)
  assert.equal(byId("context-generated").textContent, "")
  assert.equal(byId("analysis-source").textContent, "Анализ шага 7")
  assert.equal(byId("explanation").textContent, report.coins[1].explanation)
  click(byId("top-candidates"), byId("top-candidates").children[0])
  assert.equal(byId("information-panel").hidden, false)
  assert.equal(byId("news-details").open, false)
  assert.equal(byId("twitter-details").open, false)
})

test("source markup is literal text, unsafe URLs and tweet IDs never create active links", () => {
  const report = createReport()
  const information = addInformation(report)
  const unsafe = "</script><img src=x onerror=alert(1)>"
  Object.assign(information.news.items[0], {
    title: unsafe, shortDescription: unsafe, content: unsafe,
    provider: { name: unsafe }, externalUrl: "javascript:alert(1)", tradingViewUrl: "data:text/html,unsafe", publishedAt: "invalid date",
  })
  Object.assign(information.twitter.tweets[0], { id: "12/../x", authorUsername: unsafe, text: unsafe, createdAt: "invalid date" })
  const { byId } = runReport(report)
  assert.ok(byId("news-items").textContent.includes(unsafe))
  assert.ok(byId("twitter-items").textContent.includes(unsafe))
  assert.match(byId("news-items").textContent, /Время не указано/)
  assert.match(byId("twitter-items").textContent, /Время не указано/)
  const nodes = [...descendants(byId("news-items")), ...descendants(byId("twitter-items"))]
  assert.ok(nodes.every(node => !["A", "IMG", "SCRIPT", "IFRAME"].includes(node.tagName)))
})

for (const [status, change4hPct, breadth4h, label, icon, change, breadth] of [
  ["up", 1.25, 0.6, "Преобладает рост", "↑", "+1,25%", "60%"],
  ["down", -2.5, 0.2, "Преобладает снижение", "↓", "-2,5%", "20%"],
  ["mixed", 0, 0.55, "Смешанный фон", "↔", "0%", "55%"],
  ["unavailable", null, 0.6, "Недостаточно данных", "—", "Нет данных", "60%"],
]) {
  test(`alt-market banner renders ${status} with a textual status, icon and saved metrics`, () => {
    const report = createReport()
    report.altMarketBackground = {
      status, change4hPct, breadth4h, warning: status === "unavailable" ? "TOTAL3ES недоступен" : null,
    }
    const browser = runReport(report)
    assert.equal(browser.byId("alt-market-background").dataset.status, status)
    assert.equal(browser.byId("alt-market-status").textContent, label)
    assert.equal(browser.byId("alt-market-icon").textContent, icon)
    assert.equal(browser.byId("alt-market-change").textContent, change)
    assert.equal(browser.byId("alt-market-breadth").textContent, breadth)
    assert.equal(browser.byId("alt-market-warning").hidden, status !== "unavailable")
    assert.match(browser.byId("alt-market-as-of").textContent, /09:00 UTC.*не меняется при Update chart/)
    assert.doesNotMatch(browser.byId("alt-market-as-of").textContent, /11:37/)
    assert.equal(browser.updateCalls.length, 0)
    assert.equal(browser.directRequests.length, 0)
  })
}

test("missing breadth retains the known capitalization change and never appears as zero or mixed", () => {
  const report = createReport()
  report.altMarketBackground = {
    status: "unavailable", change4hPct: 1.25, breadth4h: null, warning: "Ширина рынка недоступна",
  }
  const { byId } = runReport(report)
  assert.equal(byId("alt-market-background").dataset.status, "unavailable")
  assert.equal(byId("alt-market-change").textContent, "+1,25%")
  assert.equal(byId("alt-market-breadth").textContent, "Нет данных")
  assert.equal(byId("alt-market-warning").textContent, "Ширина рынка недоступна")
  assert.equal(byId("alt-market-warning").hidden, false)
})

test("legacy reports and empty candidate lists show an unavailable background without breaking the report", () => {
  for (const symbols of [["COTI"], []]) {
    const report = createReport(symbols)
    const { byId } = runReport(report)
    assert.equal(byId("alt-market-background").dataset.status, "unavailable")
    assert.equal(byId("alt-market-status").textContent, "Недостаточно данных")
    assert.equal(byId("alt-market-change").textContent, "Нет данных")
    assert.equal(byId("alt-market-breadth").textContent, "Нет данных")
    assert.match(byId("alt-market-warning").textContent, /не рассчитан/)
    assert.match(byId("alt-market-warning").textContent, /шаги 4–6/)
    assert.equal(byId("no-candidates").hidden, symbols.length > 0)
  }
})

test("background warnings remain text and unknown statuses cannot inject a color or markup", () => {
  const report = createReport()
  const unsafe = "</script><img src=x onerror=alert(1)>"
  report.altMarketBackground = { status: unsafe, change4hPct: null, breadth4h: null, warning: unsafe }
  const { byId } = runReport(report)
  assert.equal(byId("alt-market-background").dataset.status, "unavailable")
  assert.equal(byId("alt-market-status").textContent, "Недостаточно данных")
  assert.equal(byId("alt-market-warning").textContent, unsafe)
  assert.deepEqual(byId("alt-market-warning").children, [])
})

test("the market background stays at the original universe snapshot during chart updates, errors and coin switches", async () => {
  const report = createReport(["COTI", "SOL"])
  report.altMarketBackground = { status: "down", change4hPct: -1.5, breadth4h: 0.2, warning: null }
  const controlled = controlledUpdater()
  const browser = runReport(report, controlled)
  const view = () => ({
    status: browser.byId("alt-market-background").dataset.status,
    text: ["alt-market-status", "alt-market-icon", "alt-market-change", "alt-market-breadth", "alt-market-as-of", "alt-market-warning"]
      .map(id => browser.byId(id).textContent),
    warningHidden: browser.byId("alt-market-warning").hidden,
  })
  const initial = view()
  const embedded = browser.byId("report-data").textContent
  const pending = click(browser.byId("update-chart"))
  assert.deepEqual(view(), initial)
  controlled.requests[0].resolve(createUpdate(report))
  await pending
  assert.deepEqual(view(), initial)
  selectCoin(browser, "SOL")
  click(browser.days.find(day => day.dataset.days === "7"))
  assert.deepEqual(view(), initial)
  const failed = click(browser.byId("update-chart"))
  controlled.requests[1].reject(new Error("Offline"))
  await failed
  selectCoin(browser, "COTI")
  assert.deepEqual(view(), initial)
  assert.equal(browser.byId("report-data").textContent, embedded)
})

test("startup, coin selection, periods, search and sorting never call the updater or fetch", async () => {
  const report = createReport(["COTI", "SOL"])
  const api = createBinanceApi(report)
  const browser = runReport(report, {
    updateChartHistory: createChartUpdater({ isArray, isFinite, isSafeInteger, isString, fetch: api.fetch }),
  })
  await Promise.resolve()
  selectCoin(browser, "SOL")
  click(browser.byId("top-candidates"), browser.byId("top-candidates").children[0])
  for (const day of browser.days) {
    await click(day)
  }
  browser.byId("search").value = "SOL"
  browser.byId("search").listeners.get("input")()
  browser.byId("sort").value = "symbol"
  browser.byId("sort").listeners.get("change")()

  assert.equal(browser.updateCalls.length, 0)
  assert.equal(api.requests.length, 0)
  assert.equal(browser.directRequests.length, 0)
  assert.equal(browser.markers.length, 0)
  assert.equal(browser.byId("update-chart").disabled, false)
  assert.equal(browser.byId("update-chart").attributes.get("aria-busy"), "false")
  assert.match(browser.byId("chart-update-status").textContent, /Сохранённый срез/)
  assert.match(browser.byId("chart-source").textContent, /сохранённые данные TradingView/)
})

test("real createChartUpdater integrates fake Binance OHLCV and native OI; same-hour refresh has no duplicates", async () => {
  const report = createReport(["RAY", "SOL"])
  report.coins[0].marketSymbol = "BINANCE:RAYSOLUSDT.P"
  const before = structuredClone(report)
  const api = createBinanceApi(report)
  const browser = runReport(report, {
    updateChartHistory: createChartUpdater({ isArray, isFinite, isSafeInteger, isString, fetch: api.fetch }),
  })
  const original = browser.charts.at(-1)
  const pending = click(browser.byId("update-chart"))
  assert.ok(isFunction(pending?.then))
  await pending
  const first = browser.charts.at(-1)
  const candles = chartSeries(first, "Candlestick")
  const volume = chartSeries(first, "Histogram")
  const oi = first.series.filter(series => series.type === "Line").flatMap(series => series.data)

  assert.notEqual(first, original)
  assert.equal(original.removed, true)
  assert.equal(first.removed, false)
  assert.equal(first.panes().length, 3)
  assert.equal(candles.data.length, 173)
  assert.equal(volume.data.length, 173)
  assert.deepEqual(candles.data.filter(point => point.time <= chartTime(report)), report.coins[0].history.candles)
  assert.deepEqual(oi.filter(point => point.time <= chartTime(report)), report.coins[0].history.openInterest)
  assert.equal(candles.data.at(-1).close, 400)
  assert.equal(volume.data.at(-1).value, 2_500)
  assert.equal(oi.find(point => point.time === chartTime(report, 1)).value, 10_002)
  assert.equal(oi.find(point => point.time === chartTime(report, 4)).value, 10_005)
  assert.equal(oi.at(-1).value, 6_000)
  assert.equal(browser.updateCalls.length, 1)
  assert.equal(browser.updateCalls[0].asOf, report.asOf)
  assert.equal(browser.updateCalls[0].previous, null)
  assert.deepEqual(new Set(api.requests.map(call => call.url.pathname)), new Set([
    "/fapi/v1/time", "/fapi/v1/klines", "/futures/data/openInterestHist", "/fapi/v1/openInterest",
  ]))
  assert.ok(api.requests.every(call => call.url.origin === "https://fapi.binance.com" && call.options.credentials === "omit"))
  assert.ok(api.requests.filter(call => call.url.searchParams.has("symbol"))
    .every(call => call.url.searchParams.get("symbol") === "RAYSOLUSDT"))
  assert.match(browser.byId("chart-update-status").textContent, /Обновлено.*14:20:00.*формируются.*14:19:59.*не закрытие часа/)
  assert.match(browser.byId("chart-source").textContent, /TradingView → Binance.*OI.*базовом активе/)
  assert.match(browser.byId("last-price-label").textContent, /незакрытая свеча/)
  assert.equal(browser.byId("chart-update-error").hidden, true)
  assert.equal(browser.byId("history-warning").hidden, true)

  api.state.now += 30_000
  api.state.close = 450
  api.state.volume = 3_500
  api.state.currentOi = 6_500
  await click(browser.byId("update-chart"))
  const second = browser.charts.at(-1)
  assert.equal(first.removed, true)
  assert.equal(chartSeries(second, "Candlestick").data.at(-1).close, 450)
  assert.equal(chartSeries(second, "Histogram").data.at(-1).value, 3_500)
  assert.equal(browser.updateCalls.length, 2)
  assert.equal(browser.updateCalls[1].previous.history.candles.at(-1).close, 400)
  assert.equal(browser.updateCalls[1].previous.history.openInterest.at(-1).value, 6_000)
  assert.equal(candles.data.at(-1).close, 400)
  assert.equal(oi.at(-1).value, 6_000)
  for (const type of ["Candlestick", "Histogram", "Line"]) {
    const points = second.series.filter(series => series.type === type).flatMap(series => series.data)
    assert.equal(points.length, 173)
    assert.equal(new Set(points.map(point => point.time)).size, points.length)
    assert.ok(points.every((point, index) => index === 0 || point.time > points[index - 1].time))
  }
  assert.equal(oiLegend(browser.byId).replace(/\s/g, ""), "OI6500")
  assert.equal(browser.directRequests.length, 0)
  assert.deepEqual(JSON.parse(browser.byId("report-data").textContent), before)
  assert.deepEqual(structuredClone(browser.updateCalls[1].coin), before.coins[0])
  assert.deepEqual(report, before)
})

test("the hourly grid extends beyond 168 hours and every selected range follows the updated end", async () => {
  const report = createReport()
  const result = createUpdate(report, report.coins[0], 200)
  const browser = runReport(report, { updateChartHistory: async () => result })
  await click(browser.byId("update-chart"))
  const chart = browser.charts.at(-1)

  for (const type of ["Candlestick", "Histogram"]) {
    const points = chartSeries(chart, type).data
    assert.equal(points.length, 368)
    assert.equal(points[0].time, chartTime(report, -167))
    assert.equal(points.at(-1).time, chartTime(report, 200))
  }
  assert.deepEqual(chart.ranges.at(-1), { from: chartTime(report, 200 - 71), to: chartTime(report, 200) })
  for (const day of browser.days) {
    click(day)
    assert.deepEqual(chart.ranges.at(-1), {
      from: chartTime(report, 200 - (Number(day.dataset.days) * 24 - 1)), to: chartTime(report, 200),
    })
  }
  assert.equal(browser.charts.length, 2)
  assert.equal(browser.updateCalls.length, 1)
})

test("the report marker stays at the saved asOf, never at HTML creation or either update time", async () => {
  const report = createReport()
  const updates = [createUpdate(report), createUpdate(report, report.coins[0], 8)]
  const browser = runReport(report, { updateChartHistory: async () => updates.shift() })
  const hour = chartTime(report)
  assert.equal(browser.markers.length, 0)
  assert.match(browser.byId("report-time-note").textContent, /09:00/)
  assert.notEqual(hour, Math.floor(Date.parse(report.reportCreatedAt) / 3_600_000) * 3_600)

  for (const end of [5, 8]) {
    await click(browser.byId("update-chart"))
    const markers = chartMarkers(browser)
    assert.equal(markers.length, 1)
    assert.equal(markers[0].time, hour)
    assert.equal(markers[0].text, "Отчёт")
    assert.equal(markers[0].shape, "arrowDown")
    assert.equal(markers[0].position, "aboveBar")
    assert.notEqual(markers[0].time, chartTime(report, end))
    assert.match(browser.byId("report-time-note").textContent, /09:00.*Отметка «Отчёт»/)
    const count = browser.markers.length
    click(browser.days.find(day => day.dataset.days === "7"))
    assert.equal(browser.markers.length, count)
    assert.equal(chartMarkers(browser)[0].time, hour)
  }
  assert.equal(report.reportCreatedAt, "2026-09-15T11:37:42.123Z")
})

test("regenerating HTML during the latest candle does not move the marker away from the saved snapshot", async () => {
  const report = createReport()
  for (const hours of [5, 8]) {
    const update = createUpdate(report, report.coins[0], hours)
    const regenerated = { ...report, reportCreatedAt: update.updatedAt }
    const browser = runReport(regenerated, { updateChartHistory: async () => update })
    await click(browser.byId("update-chart"))
    assert.equal(chartMarkers(browser)[0].time, chartTime(report))
    assert.notEqual(chartMarkers(browser)[0].time, chartSeries(browser.charts.at(-1), "Candlestick").data.at(-1).time)
  }
})

test("a missing asOf candle never snaps the marker to an older or newly loaded candle, even if OI exists at asOf", async () => {
  const report = createReport()
  const hour = chartTime(report)
  report.coins[0].history.candles = report.coins[0].history.candles.filter(point => point.time !== hour)
  const updates = [createUpdate(report), createUpdate(report, report.coins[0], 8)]
  const browser = runReport(report, { updateChartHistory: async () => updates.shift() })
  await click(browser.byId("update-chart"))
  const chart = browser.charts.at(-1)

  assert.deepEqual(chartSeries(chart, "Candlestick").data.find(point => point.time === hour), { time: hour })
  assert.deepEqual(chartSeries(chart, "Histogram").data.find(point => point.time === hour), { time: hour })
  assert.ok(chart.series.some(series => series.type === "Line" && series.data.some(point => point.time === hour)))
  assert.equal(browser.markers.length, 0)
  assert.match(browser.byId("report-time-note").textContent, /Свеча среза недоступна.*не подменяется/)
  for (const day of browser.days) {
    click(day)
  }
  assert.equal(browser.markers.length, 0)

  await click(browser.byId("update-chart"))
  assert.equal(chartMarkers(browser).length, 0)
})

test("a legacy report without reportCreatedAt still marks its saved asOf", async () => {
  const report = createReport()
  delete report.reportCreatedAt
  const browser = runReport(report, { updateChartHistory: async () => createUpdate(report) })
  await click(browser.byId("update-chart"))
  assert.equal(chartMarkers(browser).length, 1)
  assert.equal(chartMarkers(browser)[0].time, chartTime(report))
  assert.match(browser.byId("report-time-note").textContent, /Срез отчёта.*09:00/)
  assert.equal(browser.byId("chart-update-error").hidden, true)
})

test("loading disables Update and suppresses duplicate handlers while keeping the old chart until success", async () => {
  const report = createReport()
  const controlled = controlledUpdater()
  const browser = runReport(report, controlled)
  const button = browser.byId("update-chart")
  const original = browser.charts.at(-1)
  const pending = click(button)

  assert.ok(isFunction(pending?.then))
  assert.equal(button.disabled, true)
  assert.equal(button.attributes.get("aria-busy"), "true")
  assert.equal(button.textContent, "Обновление…")
  assert.match(browser.byId("chart-update-status").textContent, /Загружаем свечи, объём и OI/)
  assert.equal(browser.charts.at(-1), original)
  assert.equal(original.removed, false)
  // Dispatch directly even though the button is disabled: the handler must also guard duplicates.
  await click(button)
  assert.equal(controlled.requests.length, 1)
  assert.equal(browser.updateCalls.length, 1)
  click(browser.days.find(day => day.dataset.days === "7"))
  controlled.requests[0].resolve(createUpdate(report))
  await pending

  assert.equal(button.disabled, false)
  assert.equal(button.attributes.get("aria-busy"), "false")
  assert.equal(button.textContent, "Update chart")
  assert.equal(browser.charts.length, 2)
  assert.equal(original.removed, true)
  assert.deepEqual(browser.charts.at(-1).ranges.at(-1), { from: chartTime(report, 5 - 167), to: chartTime(report, 5) })
})

test("coin switches reuse independent caches, pass the correct previous result, and reload restores embedded history", async () => {
  const report = createReport(["COTI", "SOL"])
  const cot = createUpdate(report, report.coins[0], 5)
  const sol = createUpdate(report, report.coins[1], 8)
  const refreshed = createUpdate(report, report.coins[0], 6)
  const updateChartHistory = async (coin, _asOf, previous) => coin.symbol === "SOL" ? sol : previous ? refreshed : cot
  const browser = runReport(report, { updateChartHistory })
  const embedded = browser.byId("report-data").textContent
  await click(browser.byId("update-chart"))
  selectCoin(browser, "SOL")
  assert.equal(chartSeries(browser.charts.at(-1), "Candlestick").data.length, 168)
  assert.match(browser.byId("chart-update-status").textContent, /Сохранённый срез/)
  assert.equal(chartMarkers(browser).length, 0)
  await click(browser.byId("update-chart"))
  assert.equal(browser.updateCalls[1].previous, null)

  for (const [symbol, result] of [["COTI", cot], ["SOL", sol], ["COTI", cot]]) {
    selectCoin(browser, symbol)
    assert.deepEqual(chartSeries(browser.charts.at(-1), "Candlestick").data, result.history.candles)
    assert.match(browser.byId("chart-update-status").textContent, /Обновлено/)
    assert.equal(chartMarkers(browser)[0].time, chartTime(report))
  }
  assert.equal(browser.updateCalls.length, 2)
  await click(browser.byId("update-chart"))
  assert.equal(browser.updateCalls[2].coin.symbol, "COTI")
  assert.equal(browser.updateCalls[2].previous, cot)
  assert.deepEqual(chartSeries(browser.charts.at(-1), "Candlestick").data, refreshed.history.candles)
  click(browser.days.find(day => day.dataset.days === "7"))
  assert.equal(browser.byId("report-data").textContent, embedded)

  const reloaded = runReport(JSON.parse(embedded), { updateChartHistory })
  assert.equal(reloaded.updateCalls.length, 0)
  assert.equal(reloaded.directRequests.length, 0)
  assert.equal(reloaded.markers.length, 0)
  assert.deepEqual(chartSeries(reloaded.charts[0], "Candlestick").data, report.coins[0].history.candles)
  assert.match(reloaded.byId("chart-update-status").textContent, /Сохранённый срез/)
  assert.match(reloaded.byId("chart-source").textContent, /сохранённые данные TradingView/)
  assert.equal(reloaded.byId("chart-update-error").hidden, true)
  assert.deepEqual(reloaded.days.map(day => day.attributes.get("aria-pressed")), ["false", "true", "false"])
})

test("switching coins during an update keeps the inactive success cached without replacing the active chart", async () => {
  const report = createReport(["COTI", "SOL"])
  const controlled = controlledUpdater()
  const browser = runReport(report, controlled)
  const pending = click(browser.byId("update-chart"))
  selectCoin(browser, "SOL")
  const active = browser.charts.at(-1)
  const count = browser.charts.length
  const status = browser.byId("chart-update-status").textContent
  assert.equal(browser.byId("update-chart").disabled, false)
  controlled.requests[0].resolve(createUpdate(report))
  await pending

  assert.equal(browser.byId("coin-symbol").textContent, "SOL")
  assert.equal(browser.charts.length, count)
  assert.equal(browser.charts.at(-1), active)
  assert.equal(active.removed, false)
  assert.equal(browser.byId("chart-update-status").textContent, status)
  assert.equal(chartMarkers(browser).length, 0)
  selectCoin(browser, "COTI")
  assert.equal(chartSeries(browser.charts.at(-1), "Candlestick").data.length, 173)
  assert.match(browser.byId("chart-update-status").textContent, /Обновлено/)
  assert.equal(browser.updateCalls.length, 1)
})

for (const order of [[0, 1], [1, 0]]) {
  test(`two coins update independently with completion order ${order.join(" → ")}`, async () => {
    const report = createReport(["COTI", "SOL"])
    const controlled = controlledUpdater()
    const browser = runReport(report, controlled)
    const pending = [click(browser.byId("update-chart"))]
    selectCoin(browser, "SOL")
    pending.push(click(browser.byId("update-chart")))
    selectCoin(browser, "COTI")
    assert.equal(browser.byId("update-chart").disabled, true)
    await click(browser.byId("update-chart"))
    selectCoin(browser, "SOL")
    assert.equal(browser.byId("update-chart").disabled, true)
    await click(browser.byId("update-chart"))
    assert.equal(controlled.requests.length, 2)
    assert.deepEqual(browser.updateCalls.map(call => call.coin.symbol), ["COTI", "SOL"])
    assert.ok(browser.updateCalls.every(call => call.previous === null))
    const results = [createUpdate(report), createUpdate(report, report.coins[1], 8)]
    const completed = new Set()

    for (const index of order) {
      const visible = browser.charts.at(-1)
      controlled.requests[index].resolve(results[index])
      await pending[index]
      completed.add(index)
      assert.equal(browser.byId("coin-symbol").textContent, "SOL")
      assert.equal(browser.byId("update-chart").disabled, !completed.has(1))
      assert.equal(browser.byId("chart-update-error").hidden, true)
      if (index === 0) {
        assert.equal(browser.charts.at(-1), visible)
        assert.equal(visible.removed, false)
      } else {
        assert.notEqual(browser.charts.at(-1), visible)
        assert.deepEqual(chartSeries(browser.charts.at(-1), "Candlestick").data, results[1].history.candles)
      }
    }
    selectCoin(browser, "COTI")
    assert.deepEqual(chartSeries(browser.charts.at(-1), "Candlestick").data, results[0].history.candles)
    assert.equal(browser.byId("update-chart").disabled, false)
    assert.equal(browser.updateCalls.length, 2)
  })
}

for (const cached of [false, true]) {
  test(`inactive failure with cached=${cached} belongs only to its coin and cannot disturb the other update`, async () => {
    const report = createReport(["COTI", "SOL"])
    const controlled = controlledUpdater()
    const browser = runReport(report, controlled)
    const cot = createUpdate(report)
    if (cached) {
      const initial = click(browser.byId("update-chart"))
      controlled.requests.at(-1).resolve(cot)
      await initial
    }
    const failed = click(browser.byId("update-chart"))
    const failedRequest = controlled.requests.at(-1)
    selectCoin(browser, "SOL")
    const other = click(browser.byId("update-chart"))
    const otherRequest = controlled.requests.at(-1)
    const sol = createUpdate(report, report.coins[1], 8)
    if (cached) {
      otherRequest.resolve(sol)
      await other
    }
    const active = browser.charts.at(-1)
    const count = browser.charts.length
    const status = browser.byId("chart-update-status").textContent
    failedRequest.reject(new Error("CORS COTI"))
    await failed

    assert.equal(browser.charts.at(-1), active)
    assert.equal(browser.charts.length, count)
    assert.equal(active.removed, false)
    assert.equal(browser.byId("chart-update-status").textContent, status)
    assert.equal(browser.byId("chart-update-error").hidden, true)
    assert.equal(browser.byId("update-chart").disabled, !cached)
    if (!cached) {
      otherRequest.resolve(sol)
      await other
    }
    assert.deepEqual(chartSeries(browser.charts.at(-1), "Candlestick").data, sol.history.candles)
    selectCoin(browser, "COTI")
    assert.deepEqual(chartSeries(browser.charts.at(-1), "Candlestick").data, cached ? cot.history.candles : report.coins[0].history.candles)
    assert.equal(browser.byId("chart-update-error").hidden, false)
    assert.match(browser.byId("chart-update-error").textContent, /CORS COTI.*можно повторить/)
    assert.equal(browser.byId("update-chart").disabled, false)
    assert.equal(browser.updateCalls.length, cached ? 3 : 2)
  })
}

for (const cached of [false, true]) {
  test(`consecutive failed updates with cached=${cached} preserve the exact previous chart instance and offer a working retry`, async () => {
    const report = createReport()
    const controlled = controlledUpdater()
    const browser = runReport(report, controlled)
    const result = createUpdate(report)
    if (cached) {
      const initial = click(browser.byId("update-chart"))
      controlled.requests.at(-1).resolve(result)
      await initial
    }
    const previous = browser.charts.at(-1)
    const count = browser.charts.length
    const markerCount = browser.markers.length
    const data = previous.series.map(series => series.data)
    const ranges = structuredClone(previous.ranges)
    const legend = browser.byId("chart-legend").textContent
    const source = browser.byId("chart-source").textContent
    for (const message of ["HTTP 429", "CORS repeated failure"]) {
      const pending = click(browser.byId("update-chart"))
      assert.equal(browser.charts.at(-1), previous)
      assert.equal(previous.removed, false)
      assert.equal(browser.updateCalls.at(-1).previous, cached ? result : null)
      assert.equal(browser.byId("chart-update-error").hidden, true)
      assert.equal(browser.byId("update-chart").disabled, true)
      controlled.requests.at(-1).reject(new Error(message))
      await pending

      assert.equal(browser.charts.length, count)
      assert.equal(browser.charts.at(-1), previous)
      assert.equal(previous.removed, false)
      previous.series.forEach((series, index) => assert.equal(series.data, data[index]))
      assert.deepEqual(previous.ranges, ranges)
      assert.equal(browser.markers.length, markerCount)
      assert.equal(browser.byId("chart-legend").textContent, legend)
      assert.equal(browser.byId("chart-source").textContent, source)
      assert.equal(browser.byId("chart").hidden, false)
      assert.equal(browser.byId("chart-update-error").hidden, false)
      assert.ok(browser.byId("chart-update-error").textContent.startsWith(message))
      assert.match(browser.byId("chart-update-error").textContent, /График не изменён.*можно повторить/)
      assert.equal(browser.byId("update-chart").disabled, false)
      assert.equal(browser.byId("update-chart").attributes.get("aria-busy"), "false")
    }

    const retry = click(browser.byId("update-chart"))
    assert.equal(browser.byId("chart-update-error").hidden, true)
    assert.equal(browser.byId("chart-update-error").textContent, "")
    assert.equal(browser.updateCalls.at(-1).previous, cached ? result : null)
    assert.equal(browser.charts.at(-1), previous)
    assert.equal(previous.removed, false)
    const recovered = createUpdate(report, report.coins[0], 6)
    controlled.requests.at(-1).resolve(recovered)
    await retry
    assert.equal(browser.charts.length, count + 1)
    assert.equal(previous.removed, true)
    assert.deepEqual(chartSeries(browser.charts.at(-1), "Candlestick").data, recovered.history.candles)
    assert.equal(browser.byId("chart-update-error").hidden, true)
    assert.equal(browser.byId("update-chart").disabled, false)
    assert.equal(browser.updateCalls.length, cached ? 4 : 3)
  })
}

test("pending, successful and failed updates preserve embedded JSON, analysis and expanded news without rebuilding their DOM", async () => {
  const report = createReport()
  Object.assign(report.coins[0].features, {
    sustainedStatus: "persistent", sustainedHistoryScore: 82.5, sustainedCurrentScore: 91.25,
  })
  addInformation(report)
  const before = structuredClone(report)
  const controlled = controlledUpdater()
  const browser = runReport(report, controlled)
  const embedded = browser.byId("report-data").textContent
  const article = descendants(browser.byId("news-items")).find(node => node.tagName === "DETAILS")
  assert.ok(article)
  const expanded = [browser.byId("news-details"), browser.byId("twitter-details"), article]
  expanded.forEach((node) => {
    node.open = true
  })
  const unchanged = [
    "as-of", "coverage", "objective", "coin-badges", "market-summary", "top-candidates", "candidate-rows",
    "explanation", "drivers", "counter-signals", "feature-highlights", "feature-rows", "flags", "analysis-source",
    "information-panel", "context-generated", "news-window", "news-count", "news-status", "news-items", "twitter-window",
    "twitter-count", "twitter-status", "twitter-items",
    "sustained-strength-status", "sustained-strength-history", "sustained-strength-current",
  ].map(id => ({ id, text: browser.byId(id).textContent, hidden: browser.byId(id).hidden, children: [...browser.byId(id).children] }))
  const assertUnchanged = () => {
    assert.equal(browser.byId("report-data").textContent, embedded)
    assert.deepEqual(JSON.parse(embedded), before)
    assert.deepEqual(report, before)
    assert.equal(browser.byId("as-of").dateTime, report.asOf)
    assert.equal(browser.byId("sustained-strength").dataset.status, "persistent")
    for (const { id, text, hidden, children } of unchanged) {
      assert.equal(browser.byId(id).textContent, text, id)
      assert.equal(browser.byId(id).hidden, hidden, id)
      assert.equal(browser.byId(id).children.length, children.length, id)
      children.forEach((child, index) => assert.equal(browser.byId(id).children[index], child, id))
    }
    assert.ok(expanded.every(node => node.open))
    assert.equal(descendants(browser.byId("news-items")).find(node => node.tagName === "DETAILS"), article)
    for (const call of browser.updateCalls) {
      assert.equal(call.asOf, report.asOf)
      assert.deepEqual(structuredClone(call.coin), before.coins[0])
    }
  }

  const pending = click(browser.byId("update-chart"))
  assertUnchanged()
  controlled.requests.at(-1).resolve(createUpdate(report))
  await pending
  assertUnchanged()
  const failed = click(browser.byId("update-chart"))
  assertUnchanged()
  controlled.requests.at(-1).reject(new Error("Network failed"))
  await failed
  assertUnchanged()
})

for (const value of [22, 0, undefined]) {
  test(`latest legend uses exact-hour OI ${value ?? "missing"} when the forming price candle is absent`, async () => {
    const report = createReport()
    const result = createUpdate(report, report.coins[0], 3)
    result.formingTime = null
    result.history.candles = result.history.candles.filter(point => point.time !== chartTime(report, 3))
    result.history.volume = result.history.volume.map(point => (
      point.time === chartTime(report, 2) ? { time: point.time, value: 17 } : point
    ))
    result.history.openInterest = result.history.openInterest.map((point) => {
      if (point.time === chartTime(report, 2)) {
        return value === undefined ? { time: point.time } : { time: point.time, value }
      }
      return point.time === chartTime(report, 3) ? { time: point.time, value: 99 } : point
    })
    const browser = runReport(report, { updateChartHistory: async () => result })
    await click(browser.byId("update-chart"))
    const chart = browser.charts.at(-1)
    const expected = value === undefined ? "OI —" : `OI ${value}`
    assert.equal(oiLegend(browser.byId), expected)
    assert.equal(browser.byId("chart-legend").children.at(-2).textContent, "Объём 17")
    assert.match(browser.byId("chart-legend").children[0].textContent, /11:00/)
    assert.match(browser.byId("last-price-label").textContent, /последняя закрытая свеча/)
    assert.match(browser.byId("chart-update-status").textContent, /Текущая свеча недоступна.*Текущий OI: снимок/)
    assert.deepEqual(chartSeries(chart, "Candlestick").data.at(-1), { time: chartTime(report, 3) })
    assert.deepEqual(chartSeries(chart, "Histogram").data.at(-1), { time: chartTime(report, 3) })
    assert.equal(chart.ranges.at(-1).to, chartTime(report, 3))

    hoverChart(chart, chartTime(report, 3))
    assert.equal(oiLegend(browser.byId), "OI 99")
    assert.ok(browser.byId("chart-legend").children.slice(1, 5).every(node => node.children[0].textContent === "—"))
    hoverChart(chart, chartTime(report, 2))
    assert.equal(oiLegend(browser.byId), expected)
    hoverChart(chart)
    assert.equal(oiLegend(browser.byId), expected)
    assert.equal(browser.byId("chart-legend").children.at(-2).textContent, "Объём 17")
  })
}
