import assert from "node:assert/strict"
import fs from "node:fs/promises"
import test from "node:test"
import vm from "node:vm"

import { isArray, isFinite, isFunction, isSafeInteger, isString } from "../src/helpers/utils.typed.js"
import { createChartUpdater } from "../src/steps/step13-report/chart-update.js"

const script = new vm.Script(
  await fs.readFile(new URL("../src/steps/step13-report/report.js", import.meta.url), "utf8"),
  { filename: "report.js" },
)
const template = await fs.readFile(new URL("../src/steps/step13-report/report.html", import.meta.url), "utf8")

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
      this.removeCount = (this.removeCount ?? 0) + 1
    },
  }
}

function runReport (report, {
  updateChartHistory = () => assert.fail("Unexpected chart update"),
  chartsAvailable = true,
  configureChart = () => {},
} = {}) {
  const document = { activeElement: null }
  const createElement = (tag) => {
    const node = createNode(tag)
    node.focus = () => {
      document.activeElement = node
    }
    return node
  }
  const nodes = new Map([...template.matchAll(/<[^>]+\bid="([^"]+)"[^>]*>/g)].map(([tag, id]) => {
    const node = createElement(tag.match(/^<(\w+)/)[1])
    node.hidden = /\bhidden\b/.test(tag)
    for (const [, name, value] of tag.matchAll(/([\w-]+)="([^"]*)"/g)) {
      node.setAttribute(name, value)
    }
    node.id = id
    node.tabIndex = Number(node.attributes.get("tabindex") ?? 0)
    if (node.attributes.has("data-report-tab")) {
      node.dataset.reportTab = node.attributes.get("data-report-tab")
    }
    return [id, node]
  }))
  const byId = id => nodes.get(id) ?? null
  const rangeButtons = attribute => [...template.matchAll(new RegExp(`<button\\b[^>]*${attribute}="(\\d+)"[^>]*>`, "g"))].map(([tag, value]) => {
    const node = createElement("button")
    node.dataset[attribute === "data-days" ? "days" : "peerDays"] = value
    node.setAttribute("aria-pressed", tag.match(/aria-pressed="([^"]+)"/)[1])
    return node
  })
  const days = rangeButtons("data-days")
  const peerDays = rangeButtons("data-peer-days")
  const tabs = [...nodes.values()].filter(node => node.dataset.reportTab)
  Object.assign(document, {
    getElementById: byId,
    createElement,
    createElementNS (namespaceURI, tag) {
      const node = createElement(tag)
      node.namespaceURI = namespaceURI
      return node
    },
    querySelectorAll (selector) {
      if (selector === "[data-days]") {
        return days
      }
      if (selector === "[data-peer-days]") {
        return peerDays
      }
      if (selector === "[data-report-tab]") {
        return tabs
      }
      assert.equal(selector, ".top-card")
      return byId("top-candidates").children.filter(node => node.className === "top-card")
    },
  })
  byId("report-data").textContent = JSON.stringify(report)
  const sortOptions = template.match(/<select id="sort">([\s\S]*?)<\/select>/)[1]
  byId("sort").value = sortOptions.match(/<option value="([^"]+)" selected>/)[1]
  const charts = []
  const markers = []
  const updateCalls = []
  const directRequests = []
  script.runInNewContext({
    URL,
    isFinite,
    updateChartHistory: (coin, asOf, previous) => {
      updateCalls.push({ coin, asOf, previous })
      return updateChartHistory(coin, asOf, previous)
    },
    fetch: (...args) => {
      directRequests.push(args)
      assert.fail("report.js must not bypass the injected updater")
    },
    document,
    LightweightCharts: chartsAvailable
      ? {
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
            chart.radarHiddenAtCreation = byId("peer-radar").hidden
            configureChart(chart)
            return chart
          },
        }
      : undefined,
  }, { timeout: 1_000 })
  return { byId, charts, days, peerDays, tabs, document, markers, updateCalls, directRequests }
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
    objective: "P(|движение| > 2.5 ATR в следующие 4–12 часов)",
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
      baseCurrencyId: `XTVC${symbol}`,
      name: `${symbol} coin`,
      marketSymbol: `BINANCE:${symbol}USDT.P`,
      topRank: index + 1,
      movementProbability: 0.8 - index * 0.1,
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

function addPeerRadar (report, symbols = ["OUTSIDE", "LIMITED"]) {
  const observations = symbols.map((symbol, index) => ({
    coin: {
      baseCurrencyId: symbol.toLowerCase(), symbol, name: `${symbol} radar coin`,
      tradingViewSymbol: `${symbol}USDT`, marketSymbol: `BINANCE:${symbol}USDT.P`,
    },
    peerStatus: index === 1 ? "partial" : "available",
    peerCount: 3,
    availablePeerCount: index === 1 ? 2 : 3,
    benchmarkCoinCount: 20,
    baseCurrencyId: symbol.toLowerCase(),
    verdict: index % 2 ? "limited" : "watch",
    explanation: `Независимое объяснение ${symbol}`,
    caveats: [`Оговорка ${symbol}: общая рыночная история`],
    leaders: [{
      baseCurrencyId: "leader", symbol: "LEADER", type: "competitor",
      basis: "Близкий продукт", caveat: "Разные масштабы бизнеса",
      detectedAt: "2026-09-15T06:00:00.000Z", windowStartedAt: "2026-09-15T02:00:00.000Z",
      ageHours: 4, status: "fresh", return4hPct: 9, move4hAtr: 4.5, marketExcess4hAtr: 2, relativeVolume4h: 2.4,
      retainedPct: 50, returnSinceStartPct: 5, moveSinceStartAtr: 2.5,
      coinReturnSinceStartPct: index === 1 ? 0.8 : -1.25,
      coinMoveSinceStartAtr: index === 1 ? 0.2 : -0.75,
      responseRatio: index === 1 ? 0.08 : -0.3,
      gapAtr: index === 1 ? 2.3 : 3.25,
      coinReaction: index === 1 ? "flat" : "falling",
    }],
  }))
  const data = {
    schemaVersion: 1,
    asOf: report.asOf,
    snapshotClosedAt: new Date(Date.parse(report.asOf) + 3_600_000).toISOString(),
    generatedAt: "2026-09-15T10:08:09.000Z",
    scanGeneratedAt: "2026-09-15T10:02:00.000Z",
    timeframe: "1h",
    registryGeneratedAt: "2026-09-01T12:00:00.000Z",
    universeCoinCount: report.universeCoinCount,
    loadedCoinCount: 28,
    coverage: { available: 22, partial: 1, no_peers: 1, insufficient_data: 1, not_covered: 1, unreviewed: 1, unavailable: 1 },
    criteria: { impulse: "Исходный импульс ≥ 2,5 ATR", lag: "Отставание в своих ATR", reaction: "Реакция на интервале лидера" },
    candidateCount: observations.length,
    analysisStatus: observations.length ? "complete" : "skipped_no_candidates",
    analysis: {
      source: observations.length ? "copilot" : "none",
      model: observations.length ? "test-model" : null,
      reasoningEffort: observations.length ? "high" : null,
      callCount: observations.length ? 1 : 0,
    },
    observationCount: observations.length,
    watchCount: observations.filter(item => item.verdict === "watch").length,
    observations,
  }
  report.peerRadar = { status: "available", warning: null, data }
  return data
}

function addPeerHistories (report) {
  const data = report.peerRadar.data
  const members = new Map(data.observations.flatMap(item => [item.coin, ...item.leaders]).map(member => [member.baseCurrencyId, member]))
  report.peerRadar.histories = Object.fromEntries([...members.values()].map((member, index) => [member.baseCurrencyId, {
    baseCurrencyId: member.baseCurrencyId,
    symbol: member.symbol,
    marketSymbol: `BYBIT:${member.symbol}USDT.P`,
    points: Array.from({ length: 169 }, (_, hour) => ({
      time: Date.parse(data.snapshotClosedAt) / 1_000 - (168 - hour) * 3_600,
      value: 100 + index * 20 + hour * (index % 2 ? -0.1 : 0.2),
    })),
    warning: null,
  }]))
  return report.peerRadar.histories
}

function peerPart (card, className) {
  return descendants(card).find(node => node.className === className)
}

function radarCharts (browser) {
  return browser.charts.filter(chart => chart.container.className === "peer-chart")
}

function pressKey (tab, key) {
  let prevented = false
  tab.listeners.get("keydown")({ key, preventDefault: () => {
    prevented = true
  } })
  return prevented
}

function peerNodes (byId) {
  return [...template.matchAll(/\bid="(peer-radar(?:-[^"]+)?)"/g)]
    .filter(([, id]) => id !== "peer-radar-tab")
    .flatMap(([, id]) => [byId(id), ...descendants(byId(id))])
}

test("tabs default to main, navigate with arrows/Home/End and preserve the main chart, selection and controls", () => {
  const report = createReport(["COTI", "SOL"])
  addPeerRadar(report)
  addPeerHistories(report)
  const browser = runReport(report)
  const { byId, tabs, document, charts, days, peerDays } = browser
  const [main, radar] = tabs
  assert.equal(byId("main-panel").hidden, false)
  assert.equal(byId("peer-radar").hidden, true)
  assert.deepEqual(tabs.map(tab => tab.attributes.get("aria-selected")), ["true", "false"])
  assert.deepEqual(tabs.map(tab => tab.tabIndex), [0, -1])
  assert.equal(charts.length, 1)
  assert.equal(charts[0].container, byId("chart"))
  assert.equal(radarCharts(browser).length, 0)
  for (const tab of tabs) {
    assert.equal(byId(tab.attributes.get("aria-controls")).attributes.get("aria-labelledby"), tab.id)
  }

  selectCoin(browser, "SOL")
  click(days[2])
  byId("search").value = "SOL"
  byId("search").listeners.get("input")()
  byId("sort").value = "confidence"
  byId("sort").listeners.get("change")()
  const mainChart = charts.at(-1)
  mainChart.timeScale().setVisibleRange({ from: chartTime(report, -13), to: chartTime(report, -2) })
  const ranges = structuredClone(mainChart.ranges)
  const rows = [...byId("candidate-rows").children]
  const cards = [...byId("peer-radar-observations").children]
  const facts = peerPart(cards[0], "peer-observation-facts")
  facts.open = true

  assert.equal(pressKey(main, "ArrowRight"), true)
  assert.equal(document.activeElement, radar)
  assert.equal(byId("main-panel").hidden, true)
  assert.equal(byId("peer-radar").hidden, false)
  assert.deepEqual(tabs.map(tab => tab.attributes.get("aria-selected")), ["false", "true"])
  assert.deepEqual(tabs.map(tab => tab.tabIndex), [-1, 0])
  assert.deepEqual(peerDays.map(button => button.attributes.get("aria-pressed")), ["true", "false", "false"])
  const firstCharts = radarCharts(browser)
  assert.equal(firstCharts.length, 2)
  assert.ok(firstCharts.every(chart => !chart.radarHiddenAtCreation))
  click(radar)
  assert.equal(radarCharts(browser).length, 2)
  assert.equal(pressKey(radar, "Escape"), false)
  assert.equal(byId("peer-radar").hidden, false)

  assert.equal(pressKey(radar, "ArrowRight"), true)
  assert.equal(document.activeElement, main)
  assert.equal(byId("peer-radar").hidden, true)
  assert.ok(firstCharts.every(chart => chart.removed && chart.removeCount === 1))
  assert.equal(mainChart.removed, false)
  assert.deepEqual(mainChart.ranges, ranges)
  assert.equal(byId("coin-symbol").textContent, "SOL")
  assert.equal(byId("search").value, "SOL")
  assert.equal(byId("sort").value, "confidence")
  assert.deepEqual(byId("candidate-rows").children, rows)
  assert.equal(days[2].attributes.get("aria-pressed"), "true")

  assert.equal(pressKey(main, "ArrowLeft"), true)
  assert.equal(document.activeElement, radar)
  click(peerDays[1])
  assert.equal(pressKey(radar, "Home"), true)
  assert.equal(document.activeElement, main)
  assert.equal(pressKey(main, "End"), true)
  assert.equal(document.activeElement, radar)
  assert.equal(peerDays[1].attributes.get("aria-pressed"), "true")
  assert.equal(byId("peer-radar-observations").children[0], cards[0])
  assert.equal(peerPart(cards[0], "peer-observation-facts"), facts)
  assert.equal(facts.open, true)
  click(main)
  assert.ok(radarCharts(browser).every(chart => chart.removed && chart.removeCount === 1))
  assert.equal(mainChart.removed, false)
  assert.deepEqual(mainChart.ranges, ranges)
  assert.equal(browser.updateCalls.length, 0)
  assert.equal(browser.directRequests.length, 0)
})

for (const allLimited of [false, true]) {
  test(`all 23 radar candidates have visible charts, including outsiders and limited (allLimited=${allLimited})`, () => {
    const report = createReport()
    const data = addPeerRadar(report, Array.from({ length: 23 }, (_, index) => `OUTSIDE${index}`))
    if (allLimited) {
      data.observations.forEach((item) => {
        item.verdict = "limited"
      })
      data.watchCount = 0
    }
    data.observations.unshift(data.observations.pop())
    data.observations[0].leaders.push({ ...data.observations[0].leaders[0], baseCurrencyId: "second", symbol: "SECOND" })
    addPeerHistories(report)
    const before = structuredClone(report)
    const browser = runReport(report)
    const { byId } = browser
    const expected = [...data.observations.filter(item => item.verdict === "watch"), ...data.observations.filter(item => item.verdict !== "watch")]
    const cards = byId("peer-radar-observations").children
    assert.deepEqual(cards.map(card => card.children[0].children[0].textContent), expected.map(item => item.coin.symbol))
    assert.equal(radarCharts(browser).length, 0)
    click(byId("peer-radar-tab"))
    const charts = radarCharts(browser)
    assert.equal(charts.length, 23)
    cards.forEach((card, index) => {
      assert.equal(charts[index].container, peerPart(card, "peer-chart"))
      assert.equal(charts[index].container.hidden, false)
      assert.equal(charts[index].radarHiddenAtCreation, false)
      assert.equal(peerPart(card, "peer-observation-facts").open, false)
      assert.deepEqual(charts[index].series.map(series => series.options.title), [
        `Кандидат ${expected[index].coin.symbol}`, ...expected[index].leaders.map(leader => `Лидер ${leader.symbol}`),
      ])
      assert.equal(peerPart(card, "peer-chart-legend").children.length, expected[index].leaders.length + 1)
      assert.ok(charts[index].series.every(series => series.type === "Line"))
    })
    assert.deepEqual(byId("candidate-rows").children.map(node => node.dataset.symbol), ["COTI"])
    assert.equal(byId("coin-symbol").textContent, "COTI")
    assert.equal(browser.charts[0].removed, false)
    assert.deepEqual(report, before)
    assert.deepEqual(JSON.parse(byId("report-data").textContent), before)
    assert.equal(browser.updateCalls.length, 0)
    assert.equal(browser.directRequests.length, 0)
  })
}

test("all radar lines use the same exact close anchor and common 1/3/7-day windows, never the ATR signal", () => {
  const report = createReport()
  const data = addPeerRadar(report)
  const histories = addPeerHistories(report)
  const browser = runReport(report)
  const { byId, peerDays } = browser
  click(byId("peer-radar-tab"))
  const to = Date.parse(data.snapshotClosedAt) / 1_000
  const cards = byId("peer-radar-observations").children
  for (const button of peerDays) {
    const old = radarCharts(browser).filter(chart => !chart.removed)
    click(button)
    const days = Number(button.dataset.peerDays)
    const from = to - days * 86_400
    const charts = radarCharts(browser).filter(chart => !chart.removed)
    assert.equal(charts.length, 2)
    if (days !== 1) {
      assert.ok(old.every(chart => chart.removed && chart.removeCount === 1))
    }
    assert.deepEqual(peerDays.map(item => item.attributes.get("aria-pressed")), peerDays.map(item => String(item === button)))
    charts.forEach((chart, index) => {
      assert.deepEqual(chart.ranges, [{ from, to }])
      assert.match(chart.options.localization.timeFormatter(to), /15 сент\. 2026 г\., 10:00 UTC · закрытие/)
      const members = [data.observations[index].coin, ...data.observations[index].leaders]
      members.forEach((member, lineIndex) => {
        const history = histories[member.baseCurrencyId]
        const anchor = history.points.find(point => point.time === from).value
        const series = chart.series[lineIndex]
        assert.equal(series.data.length, days * 24 + 1)
        assert.deepEqual(series.data, history.points.filter(point => point.time >= from).map(point => ({
          time: point.time, value: (point.value / anchor - 1) * 100,
        })))
        assert.deepEqual(series.data[0], { time: from, value: 0 })
        assert.equal(series.data.at(-1).time, to)
        assert.equal(series.options.priceFormat.type, "percent")
        assert.equal(series.options.lineWidth, lineIndex === 0 ? 3 : 2)
        if (lineIndex) {
          assert.notEqual(series.options.color, chart.series[0].options.color)
        }
      })
      assert.equal(peerPart(cards[index], "warning").hidden, true)
      assert.match(peerPart(cards[index], "peer-chart-time").textContent, /10:00 UTC.*% \(не ATR\)/)
      hoverChart(chart, from)
      assert.ok(peerPart(cards[index], "peer-chart-legend").children.every(item => item.textContent.endsWith(" · 0%")))
      assert.ok(peerPart(cards[index], "peer-chart-time").textContent.includes(chart.options.localization.timeFormatter(from).split(" · ")[0]))
      chart.crosshair({})
    })
    assert.match(byId("peer-radar-range-note").textContent, /Общая база \(0%\):.*10:00 UTC → срез:.*10:00 UTC/)
  }
  assert.equal(browser.charts[0].removed, false)
  assert.equal(browser.days[2].attributes.get("aria-pressed"), "true")
  assert.equal(browser.updateCalls.length, 0)
  assert.equal(browser.directRequests.length, 0)
})

test("missing exact anchors disable only that coin, including omitted slots, without rebasing to the next close", () => {
  const report = createReport()
  addPeerRadar(report, ["OUTSIDE"])
  const histories = addPeerHistories(report)
  histories.outside.points[144] = { time: histories.outside.points[144].time }
  histories.leader.points.splice(96, 1)
  const browser = runReport(report)
  const { byId, peerDays } = browser
  click(byId("peer-radar-tab"))
  const card = byId("peer-radar-observations").children[0]
  let chart = radarCharts(browser).at(-1)
  assert.deepEqual(chart.series.map(series => series.options.title), ["Лидер LEADER"])
  assert.match(peerPart(card, "warning").textContent, /OUTSIDE: Нет цены закрытия на общей базе 14 сент\. 2026 г\., 10:00 UTC — линия отключена/)
  assert.equal(peerPart(card, "peer-chart-legend").children[0].dataset.disabled, "true")
  assert.match(peerPart(card, "peer-chart-legend").children[0].textContent, /Линия отключена: нет общей базы/)
  assert.equal(peerPart(card, "peer-chart-legend").children[1].dataset.disabled, "false")

  click(peerDays[1])
  chart = radarCharts(browser).at(-1)
  assert.ok(chart.series.every(series => series.options.title === "Кандидат OUTSIDE"))
  assert.match(peerPart(card, "warning").textContent, /LEADER: Нет цены закрытия на общей базе 12 сент\. 2026 г\., 10:00 UTC — линия отключена/)
  assert.equal(peerPart(card, "peer-chart-legend").children[0].dataset.disabled, "false")
  assert.equal(peerPart(card, "peer-chart-legend").children[1].dataset.disabled, "true")
  click(peerDays[2])
  chart = radarCharts(browser).at(-1)
  assert.deepEqual([...new Set(chart.series.map(series => series.options.title))], ["Кандидат OUTSIDE", "Лидер LEADER"])
  assert.ok(peerPart(card, "peer-chart-legend").children.every(item => item.dataset.disabled === "false"))
  assert.doesNotMatch(peerPart(card, "warning").textContent, /линия отключена/)
})

test("radar splits every internal gap into contiguous lines, shows isolated points and keeps missing end hours", () => {
  const report = createReport()
  addPeerRadar(report, ["OUTSIDE"])
  const histories = addPeerHistories(report)
  for (const index of [145, 167, 168]) {
    histories.outside.points[index] = { time: histories.outside.points[index].time }
  }
  const omitted = histories.outside.points.splice(147, 1)[0].time
  const browser = runReport(report)
  const { byId } = browser
  click(byId("peer-radar-tab"))
  const card = byId("peer-radar-observations").children[0]
  const chart = radarCharts(browser)[0]
  const segments = chart.series.filter(series => series.options.title === "Кандидат OUTSIDE")
  assert.deepEqual(segments.map(series => series.data.filter(point => point.value != null).length), [1, 1, 19])
  assert.deepEqual(segments.map(series => series.options.pointMarkersVisible), [true, true, false])
  assert.ok(segments.every(series => !series.options.lastValueVisible))
  for (const series of chart.series) {
    assert.equal(series.data.length, 25)
    series.data.slice(1).forEach((point, index) => assert.equal(point.time - series.data[index].time, 3_600))
    const values = series.data.filter(point => point.value != null)
    values.slice(1).forEach((point, index) => assert.equal(point.time - values[index].time, 3_600))
  }
  assert.equal(peerPart(card, "peer-chart-legend").children.length, 2)
  assert.match(peerPart(card, "warning").textContent, /OUTSIDE: Нет 4 из 25 часовых закрытий; пропуски не соединяются/)
  assert.match(peerPart(card, "peer-chart-legend").children[0].textContent, /Нет закрытия/)
  hoverChart(chart, omitted)
  assert.match(peerPart(card, "peer-chart-legend").children[0].textContent, /Нет закрытия/)
  hoverChart(chart, omitted - 3_600)
  assert.doesNotMatch(peerPart(card, "peer-chart-legend").children[0].textContent, /Нет закрытия/)
  chart.crosshair({})
  assert.match(peerPart(card, "peer-chart-legend").children[0].textContent, /Нет закрытия/)
  assert.equal(chart.ranges[0].to, Date.parse(report.peerRadar.data.snapshotClosedAt) / 1_000)
})

for (const legacy of [true, false]) {
  test(`unavailable histories keep every card and its facts visible without rebasing or requests (legacy=${legacy})`, () => {
    const report = createReport([])
    addPeerRadar(report)
    if (!legacy) {
      const histories = addPeerHistories(report)
      Object.values(histories).forEach(history => Object.assign(history, { points: [], marketSymbol: null, warning: "История недоступна" }))
    }
    const browser = runReport(report)
    const { byId } = browser
    click(byId("peer-radar-tab"))
    assert.equal(byId("peer-radar").hidden, false)
    assert.equal(byId("peer-radar-content").hidden, false)
    assert.equal(byId("peer-radar-observations").children.length, 2)
    for (const card of byId("peer-radar-observations").children) {
      assert.equal(peerPart(card, "warning").hidden, false)
      assert.match(peerPart(card, "warning").textContent, /линия отключена/)
      assert.equal(peerPart(card, "empty-state").hidden, false)
      assert.equal(peerPart(card, "peer-chart").hidden, true)
      assert.equal(peerPart(card, "peer-observation-facts").hidden, false)
      assert.match(peerPart(card, "peer-observation-facts").textContent, /Независимое объяснение/)
    }
    assert.equal(browser.charts.length, 0)
    assert.equal(browser.updateCalls.length, 0)
    assert.equal(browser.directRequests.length, 0)
  })
}

test("unavailable chart library leaves per-card warnings, legends and saved facts usable", () => {
  const report = createReport()
  addPeerRadar(report)
  addPeerHistories(report)
  const browser = runReport(report, { chartsAvailable: false })
  const { byId } = browser
  click(byId("peer-radar-tab"))
  for (const card of byId("peer-radar-observations").children) {
    assert.equal(peerPart(card, "warning").hidden, false)
    assert.match(peerPart(card, "warning").textContent, /Не удалось построить график/)
    assert.equal(peerPart(card, "peer-chart").hidden, true)
    assert.equal(peerPart(card, "peer-chart-legend").children.length, 2)
    assert.match(peerPart(card, "peer-observation-facts").textContent, /Независимое объяснение/)
    peerPart(card, "peer-observation-facts").open = true
  }
  click(byId("main-tab"))
  assert.equal(byId("coin-symbol").textContent, "COTI")
  assert.equal(byId("coin-detail").hidden, false)
  assert.equal(browser.charts.length, 0)
  assert.equal(browser.updateCalls.length, 0)
})

test("one radar chart failure is isolated and cleaned up; range changes retry without rebuilding facts", () => {
  const report = createReport()
  addPeerRadar(report)
  addPeerHistories(report)
  let fail = true
  const browser = runReport(report, {
    configureChart (chart) {
      if (chart.container.className !== "peer-chart" || !fail) {
        return
      }
      fail = false
      const addSeries = chart.addSeries.bind(chart)
      chart.addSeries = (...args) => {
        const series = addSeries(...args)
        series.setData = () => {
          throw new Error("<img src=x onerror=alert(1)> chart error")
        }
        return series
      }
    },
  })
  const { byId } = browser
  click(byId("peer-radar-tab"))
  const cards = byId("peer-radar-observations").children
  const failed = radarCharts(browser)[0]
  assert.equal(failed.removed, true)
  assert.equal(failed.removeCount, 1)
  assert.equal(radarCharts(browser)[1].removed, false)
  assert.equal(peerPart(cards[0], "warning").children.length, 0)
  assert.match(peerPart(cards[0], "warning").textContent, /<img src=x onerror=alert\(1\)> chart error/)
  const facts = peerPart(cards[0], "peer-observation-facts")
  facts.open = true
  click(browser.peerDays[1])
  assert.equal(radarCharts(browser).filter(chart => !chart.removed).length, 2)
  assert.equal(peerPart(cards[0], "warning").hidden, true)
  assert.equal(peerPart(cards[0], "peer-chart").hidden, false)
  assert.equal(peerPart(cards[0], "peer-observation-facts"), facts)
  assert.equal(facts.open, true)
  click(byId("main-tab"))
  assert.ok(radarCharts(browser).every(chart => chart.removeCount === 1))
  assert.equal(browser.charts[0].removed, false)
})

test("visible radar charts and facts survive main updates, selection, search and sort; main caches survive tab toggles", async () => {
  const report = createReport(["COTI", "SOL"])
  addPeerRadar(report)
  addPeerHistories(report)
  const before = structuredClone(report)
  const controlled = controlledUpdater()
  const browser = runReport(report, controlled)
  const { byId } = browser
  const pending = click(byId("update-chart"))
  click(byId("peer-radar-tab"))
  const charts = radarCharts(browser)
  const cards = [...byId("peer-radar-observations").children]
  const radarState = peerNodes(byId).map(node => [node, node.textContent, [...node.children]])
  const result = createUpdate(report)
  controlled.requests[0].resolve(result)
  await pending
  const cached = browser.charts.at(-1)
  assert.equal(cached.container, byId("chart"))
  assert.match(byId("chart-update-status").textContent, /Обновлено/)
  assert.ok(charts.every(chart => !chart.removed && chart.ranges[0].to === Date.parse(report.peerRadar.data.snapshotClosedAt) / 1_000))
  selectCoin(browser, "SOL")
  selectCoin(browser, "COTI")
  byId("search").value = "SOL"
  byId("search").listeners.get("input")()
  byId("sort").value = "probability"
  byId("sort").listeners.get("change")()
  assert.deepEqual(radarCharts(browser), charts)
  assert.deepEqual(byId("peer-radar-observations").children, cards)
  radarState.forEach(([node, text, children]) => {
    assert.equal(node.textContent, text)
    assert.deepEqual(node.children, children)
  })
  const main = browser.charts.at(-1)
  click(byId("main-tab"))
  assert.equal(main.removed, false)
  click(byId("peer-radar-tab"))
  click(byId("main-tab"))
  assert.equal(main.removed, false)
  const retry = click(byId("update-chart"))
  assert.equal(browser.updateCalls[1].previous, result)
  controlled.requests[1].reject(new Error("Offline"))
  await retry
  assert.equal(main.removed, false)
  assert.deepEqual(JSON.parse(byId("report-data").textContent), before)
  assert.deepEqual(report, before)
  assert.equal(browser.updateCalls.length, 2)
  assert.equal(browser.directRequests.length, 0)
})

test("radar uses only verified history symbols for leader links and treats all history text as literal offline data", () => {
  const report = createReport()
  const data = addPeerRadar(report, ["OUTSIDE"])
  const unsafe = "</script><img src=x onerror=alert(1)> & <svg onload=alert(2)>"
  data.observations[0].leaders.push({ ...data.observations[0].leaders[0], baseCurrencyId: "unverified", symbol: "UNVERIFIED" })
  const histories = addPeerHistories(report)
  histories.outside.warning = unsafe
  histories.leader.marketSymbol = "BYBIT:1000LEADERUSDT.P&symbol=OTHER\" onclick=alert(1)"
  histories.unverified.marketSymbol = null
  histories.unverified.symbol = unsafe
  data.observations[0].leaders[1].marketSymbol = "BINANCE:GUESSEDUSDT.P"
  const browser = runReport(report)
  const { byId } = browser
  click(byId("peer-radar-tab"))
  for (const button of browser.peerDays) {
    click(button)
  }
  const card = byId("peer-radar-observations").children[0]
  assert.equal(peerPart(card, "warning").textContent, `OUTSIDE: ${unsafe}`)
  assert.equal(peerPart(card, "warning").children.length, 0)
  const leaders = descendants(card).filter(node => node.className === "peer-leader")
  const verifiedLink = descendants(leaders[0]).find(node => node.tagName === "A")
  assert.equal(new URL(verifiedLink.href).searchParams.get("symbol"), histories.leader.marketSymbol)
  assert.equal(descendants(leaders[1]).filter(node => node.tagName === "A").length, 0)
  assert.match(peerPart(card, "peer-chart-legend").textContent, /UNVERIFIED/)
  const links = descendants(card).filter(node => node.tagName === "A")
  for (const link of links) {
    const url = new URL(link.href)
    assert.equal(url.origin, "https://www.tradingview.com")
    assert.equal(url.pathname, "/chart/")
    assert.equal(url.hash, "")
    assert.equal(url.username, "")
    assert.equal([...url.searchParams].length, 1)
    assert.notEqual(url.searchParams.get("symbol"), "BINANCE:GUESSEDUSDT.P")
    assert.equal(link.rel, "noopener noreferrer")
    assert.equal(link.target, "_blank")
    assert.equal(link.listeners.size, 0)
  }
  assert.ok(descendants(card).every(node => !["SCRIPT", "IMG", "SVG", "IFRAME"].includes(node.tagName)))
  assert.equal(browser.updateCalls.length, 0)
  assert.equal(browser.directRequests.length, 0)
})

test("peer radar renders independent watch and limited observations with snapshot and release times", () => {
  const report = createReport()
  const data = addPeerRadar(report)
  const before = structuredClone(report)
  const { byId, updateCalls, directRequests } = runReport(report)

  assert.equal(byId("peer-radar").dataset.status, "available")
  assert.equal(byId("peer-radar-content").hidden, false)
  assert.equal(byId("peer-radar-warning").hidden, true)
  assert.equal(byId("peer-radar-status").textContent, "Наблюдения для ручной проверки")
  assert.deepEqual(byId("peer-radar-counts").children.map(node => node.textContent), [
    "Наблюдений: 2", "Обратить внимание: 1", "Ограниченная интерпретация: 1",
  ])
  assert.match(byId("peer-radar-time").textContent, /Срез закрыт: 15 сент\. 2026 г\., 10:00 UTC/)
  assert.match(byId("peer-radar-time").textContent, /Анализ выпущен: 15 сент\. 2026 г\., 10:08:09 UTC/)
  assert.doesNotMatch(byId("peer-radar-time").textContent, /09:00|11:37/)
  const cards = byId("peer-radar-observations").children
  assert.equal(cards.length, 2)
  for (const [index, verdict] of ["Обратить внимание", "Ограниченная интерпретация"].entries()) {
    const card = cards[index]
    const observation = data.observations[index]
    assert.equal(card.tagName, "ARTICLE")
    assert.equal(descendants(card).find(node => node.className === "peer-observation-facts").open, false)
    assert.equal(card.dataset.verdict, observation.verdict)
    assert.match(card.children[0].textContent, new RegExp(observation.coin.symbol))
    assert.ok(card.children[0].textContent.includes(observation.coin.name))
    assert.ok(card.children[0].textContent.includes(verdict))
    assert.ok(card.textContent.includes(observation.explanation))
    assert.ok(card.textContent.includes(observation.caveats[0]))
    const link = descendants(card).find(node => node.tagName === "A")
    const url = new URL(link.href)
    assert.equal(url.origin, "https://www.tradingview.com")
    assert.equal(url.pathname, "/chart/")
    assert.equal(url.searchParams.get("symbol"), observation.coin.marketSymbol)
    assert.equal(link.target, "_blank")
    assert.equal(link.rel, "noopener noreferrer")
    assert.equal(link.listeners.size, 0)
  }
  assert.equal(byId("coin-symbol").textContent, "COTI")
  assert.deepEqual(JSON.parse(byId("report-data").textContent), before)
  assert.deepEqual(report, before)
  assert.equal(updateCalls.length, 0)
  assert.equal(directRequests.length, 0)
})

test("peer radar shows all 23 outsiders watch-first without adding them to the main shortlist or charts", () => {
  const report = createReport(["COTI", "SOL"])
  const symbols = Array.from({ length: 23 }, (_, index) => `OUTSIDE${index + 1}`)
  addPeerRadar(report, symbols)
  const { byId, charts, updateCalls, directRequests } = runReport(report)
  const cards = byId("peer-radar-observations").children

  assert.equal(cards.length, 23)
  assert.deepEqual(cards.map(card => card.children[0].children[0].textContent), [
    ...symbols.filter((_, index) => index % 2 === 0), ...symbols.filter((_, index) => index % 2 === 1),
  ])
  assert.ok(cards.every(card => !card.open))
  assert.equal(byId("peer-radar-counts").children[0].textContent, "Наблюдений: 23")
  assert.equal(byId("candidate-count").textContent, "2")
  for (const id of ["candidate-rows", "top-candidates"]) {
    assert.deepEqual(byId(id).children.map(node => node.dataset.symbol), ["COTI", "SOL"])
    assert.doesNotMatch(byId(id).textContent, /OUTSIDE/)
  }
  assert.ok(peerNodes(byId).every(node => node.dataset.symbol == null && node.listeners.size === 0))
  peerPart(cards.at(-1), "peer-observation-facts").open = true
  assert.equal(byId("coin-symbol").textContent, "COTI")
  assert.equal(charts.length, 1)
  assert.equal(charts[0].removed, false)
  assert.equal(updateCalls.length, 0)
  assert.equal(directRequests.length, 0)
})

test("peer radar stays available when the main candidate list is empty", () => {
  const report = createReport([])
  addPeerRadar(report)
  const { byId, charts, updateCalls, directRequests } = runReport(report)

  assert.equal(byId("coin-detail").hidden, true)
  assert.equal(byId("no-candidates").hidden, false)
  assert.equal(byId("peer-radar-content").hidden, false)
  assert.equal(byId("peer-radar").dataset.status, "available")
  assert.equal(byId("peer-radar-observations").children.length, 2)
  assert.equal(charts.length, 0)
  assert.equal(updateCalls.length, 0)
  assert.equal(directRequests.length, 0)
})

for (const symbols of [[], ["COTI"]]) {
  test(`an empty peer scan is available, not unavailable, with ${symbols.length} main candidates`, () => {
    const report = createReport(symbols)
    addPeerRadar(report, [])
    const { byId, updateCalls, directRequests } = runReport(report)

    assert.equal(byId("peer-radar").dataset.status, "available")
    assert.equal(byId("peer-radar-content").hidden, false)
    assert.equal(byId("peer-radar-warning").hidden, true)
    assert.match(byId("peer-radar-status").textContent, /Наблюдений нет.*не нашёл кандидатов.*анализ шага 12 пропущен/)
    assert.doesNotMatch(byId("peer-radar-status").textContent, /недоступен/)
    assert.deepEqual(byId("peer-radar-counts").children.map(node => node.textContent), [
      "Наблюдений: 0", "Обратить внимание: 0", "Ограниченная интерпретация: 0",
    ])
    assert.equal(byId("peer-radar-observations").children.length, 0)
    assert.match(byId("peer-radar-analysis").textContent, /Модель: —.*Вызовов: 0/)
    assert.equal(byId("coin-detail").hidden, !symbols.length)
    assert.equal(updateCalls.length, 0)
    assert.equal(directRequests.length, 0)
  })
}

for (const warning of [
  undefined,
  "Результат шага 12 не найден.",
  "Срез шага 12 не совпадает с текущим asOf.",
  "Результат шага 12 повреждён.",
  "После нового скана шага 11 нужен свежий анализ шага 12.",
  "<img src=x onerror=alert(1)> Причина недоступности",
]) {
  test(`unavailable or legacy peer radar preserves the rest of the report: ${warning ?? "legacy"}`, () => {
    const report = createReport()
    if (warning !== undefined) {
      report.peerRadar = { status: "unavailable", warning, data: null }
    }
    const { byId, charts } = runReport(report)

    assert.equal(byId("peer-radar").dataset.status, "unavailable")
    assert.equal(byId("peer-radar-status").textContent, "Радар недоступен")
    assert.equal(byId("peer-radar-content").hidden, true)
    assert.equal(byId("peer-radar-warning").hidden, false)
    assert.equal(byId("peer-radar-warning").textContent, warning ?? "Результат шага 12 не добавлен.")
    assert.equal(byId("peer-radar-warning").children.length, 0)
    assert.equal(byId("peer-radar-observations").children.length, 0)
    assert.equal(byId("coin-symbol").textContent, "COTI")
    assert.equal(byId("explanation").textContent, "Оценка COTI")
    assert.equal(charts.length, 1)
  })
}

test("peer radar exposes partial and unknown coverage without treating no_peers as an error", () => {
  const report = createReport()
  const data = addPeerRadar(report)
  data.registryGeneratedAt = null
  report.peerRadar.warning = "Доступна только часть справочника."
  const { byId } = runReport(report)

  assert.equal(byId("peer-radar-coverage").textContent, "Загружено 28 / 30 монет · Частичное покрытие: 1 · Неизвестные связи: 3 · Без соседей: 1 (не ошибка)")
  assert.deepEqual(byId("peer-radar-coverage-counts").children.map(node => node.textContent), [
    "Полное покрытие: 22", "Частичное покрытие: 1", "Без соседей: 1", "Недостаточно данных: 1",
    "Вне справочника: 1", "Не проверено: 1", "Справочник недоступен: 1",
  ])
  assert.equal(byId("peer-radar-warning").textContent, report.peerRadar.warning)
  assert.equal(byId("peer-radar-warning").hidden, false)
  assert.equal(byId("peer-radar-method").open, false)
  assert.match(byId("peer-radar-provenance").textContent, /asOf \(открытие\):.*09:00 UTC.*Скан шага 11 выпущен:.*10:02 UTC/)
  assert.match(byId("peer-radar-provenance").textContent, /Справочник: время выпуска не указано/)
  assert.match(byId("peer-radar-analysis").textContent, /Источник анализа: copilot.*Модель: test-model.*Усилие рассуждения: high.*Вызовов: 1/)
  assert.deepEqual(byId("peer-radar-criteria").children.map(node => node.children[1].textContent), Object.values(data.criteria))
  assert.match(byId("peer-radar-observations").children[1].textContent, /Частичное покрытие · Соседи с данными: 2 \/ 3 · Монет для сравнения с рынком: 20/)
})

test("each peer leader keeps actual signed returns, own ATR and reaction separate from its frozen 4h trigger", () => {
  const report = createReport()
  const data = addPeerRadar(report)
  data.observations[0].leaders.push({
    ...data.observations[0].leaders[0],
    baseCurrencyId: "adjacent", symbol: "ADJACENT", type: "adjacent",
    basis: "Общая аудитория", caveat: "Не прямой конкурент",
    detectedAt: "2026-09-15T04:00:00.000Z", windowStartedAt: "2026-09-15T00:00:00.000Z",
    ageHours: 6, status: "fading", return4hPct: 7.5, move4hAtr: 3.75,
    retainedPct: 80, returnSinceStartPct: 6, moveSinceStartAtr: 3,
    coinReturnSinceStartPct: 8.5, coinMoveSinceStartAtr: 1.2, responseRatio: 0.4, gapAtr: 1.8, coinReaction: "rising",
  })
  const { byId } = runReport(report)
  const [watch, limited] = byId("peer-radar-observations").children
  const leaders = descendants(watch).filter(node => node.className === "peer-leader")
  const values = metrics => metrics.children.map(node => node.children[1].textContent)
  assert.equal(leaders.length, 2)
  assert.equal(leaders[0].children[0].textContent, "LEADER · Конкурент")
  assert.match(leaders[0].textContent, /Свежий импульс \(fresh\) · Возраст с обнаружения: 4 ч · Обнаружен:.*06:00 UTC/)
  assert.match(leaders[0].textContent, /Связь по справочнику: Близкий продукт.*Оговорка связи: Разные масштабы бизнеса/)
  assert.match(leaders[0].children.find(node => node.className === "peer-current-window").textContent, /02:00 UTC →.*10:00 UTC/)
  assert.equal(leaders[0].children.find(node => node.className === "peer-reaction").textContent, "Реакция OUTSIDE на этом интервале: Снижение (falling)")
  const current = leaders[0].children.find(node => node.className === "peer-metrics")
  assert.deepEqual(values(current), ["+5%", "-1,25%", "+2,5 ATR", "-0,75 ATR", "3,25 ATR", "50%", "-0,3×"])
  assert.doesNotMatch(current.textContent, /\+9%|\+4,5 ATR/)
  assert.match(current.textContent, /Лидер LEADER · изменение цены.*Кандидат OUTSIDE · изменение цены/)
  const frozen = leaders[0].children.find(node => node.tagName === "DETAILS")
  assert.equal(frozen.open, false)
  assert.equal(frozen.children[0].textContent, "Исходный импульс · 4ч (зафиксирован)")
  assert.match(frozen.textContent, /02:00 UTC →.*06:00 UTC.*не текущая доходность/)
  assert.deepEqual(values(frozen.children.find(node => node.className === "peer-metrics")), ["+9%", "+4,5 ATR", "+2 ATR", "2,4×"])
  assert.equal(leaders[1].children[0].textContent, "ADJACENT · Смежный сосед")
  assert.match(leaders[1].textContent, /Затухающий импульс \(fading\) · Возраст с обнаружения: 6 ч/)
  assert.match(leaders[1].children.find(node => node.className === "peer-current-window").textContent, /00:00 UTC →.*10:00 UTC/)
  assert.equal(leaders[1].children.find(node => node.className === "peer-reaction").textContent, "Реакция OUTSIDE на этом интервале: Рост (rising)")
  assert.deepEqual(values(leaders[1].children.find(node => node.className === "peer-metrics")), ["+6%", "+8,5%", "+3 ATR", "+1,2 ATR", "1,8 ATR", "80%", "0,4×"])
  assert.match(limited.textContent, /Реакция LIMITED на этом интервале: Слабая \(flat\)/)
  assert.match(limited.textContent, /\+0,8%.*\+0,2 ATR/)
})

test("peer radar DOM, expanded cards and embedded data survive main selection, search, sorting and chart updates", async () => {
  const report = createReport(["COTI", "SOL"])
  addPeerRadar(report)
  const before = structuredClone(report)
  const controlled = controlledUpdater()
  const browser = runReport(report, controlled)
  const { byId } = browser
  const cards = byId("peer-radar-observations").children
  peerPart(cards[0], "peer-observation-facts").open = true
  peerPart(cards[0], "peer-original").open = true
  byId("peer-radar-method").open = true
  const nodes = peerNodes(byId)
  const states = nodes.map(node => ({
    text: node.textContent, hidden: node.hidden, open: node.open, href: node.href,
    dataset: { ...node.dataset }, children: [...node.children],
  }))
  const embedded = byId("report-data").textContent
  const assertUnchanged = () => {
    const current = peerNodes(byId)
    assert.equal(current.length, nodes.length)
    nodes.forEach((node, index) => {
      assert.equal(current[index], node)
      assert.equal(node.textContent, states[index].text)
      assert.equal(node.hidden, states[index].hidden)
      assert.equal(node.open, states[index].open)
      assert.equal(node.href, states[index].href)
      assert.deepEqual(node.dataset, states[index].dataset)
      assert.equal(node.children.length, states[index].children.length)
      node.children.forEach((child, childIndex) => assert.equal(child, states[index].children[childIndex]))
    })
    assert.equal(byId("report-data").textContent, embedded)
    assert.deepEqual(JSON.parse(embedded), before)
    assert.deepEqual(report, before)
    assert.equal(browser.directRequests.length, 0)
  }

  selectCoin(browser, "SOL")
  assertUnchanged()
  click(byId("top-candidates"), byId("top-candidates").children[0])
  assertUnchanged()
  for (const query of ["SOL", "OUTSIDE", ""]) {
    byId("search").value = query
    byId("search").listeners.get("input")()
    assertUnchanged()
  }
  for (const sort of ["probability", "confidence", "top"]) {
    byId("sort").value = sort
    byId("sort").listeners.get("change")()
    assertUnchanged()
  }
  for (const day of browser.days) {
    click(day)
    assertUnchanged()
  }
  assert.equal(browser.updateCalls.length, 0)
  const pending = click(byId("update-chart"))
  assertUnchanged()
  selectCoin(browser, "SOL")
  assertUnchanged()
  controlled.requests[0].resolve(createUpdate(report))
  await pending
  assertUnchanged()
  selectCoin(browser, "COTI")
  assertUnchanged()
  assert.match(byId("chart-update-status").textContent, /Обновлено/)
  const failed = click(byId("update-chart"))
  assertUnchanged()
  controlled.requests[1].reject(new Error("Offline"))
  await failed
  assertUnchanged()
})

test("peer radar agent and registry text stays literal and market symbols cannot change the TradingView destination", () => {
  const report = createReport()
  const data = addPeerRadar(report, ["OUTSIDE", "LIMITED", "THIRD"])
  const unsafe = "</summary><script>globalThis.injected = true</script><img src=x onerror=alert(1)> & <svg onload=alert(2)>"
  const marketSymbols = ["javascript:alert(1)", "https://evil.example/@x?symbol=OTHER#hash", "BINANCE:COINUSDT.P&symbol=OTHER\" onclick=alert(1)"]
  report.peerRadar.warning = unsafe
  Object.assign(data.analysis, { source: unsafe, model: unsafe, reasoningEffort: unsafe })
  Object.assign(data.criteria, { impulse: unsafe, lag: unsafe, reaction: unsafe })
  data.observations.forEach((observation, index) => {
    Object.assign(observation.coin, { name: unsafe, symbol: unsafe, marketSymbol: marketSymbols[index], tradingViewSymbol: "javascript:alert(1)" })
    Object.assign(observation, { explanation: unsafe, caveats: [unsafe] })
    Object.assign(observation.leaders[0], { symbol: unsafe, basis: unsafe, caveat: unsafe })
  })
  const { byId, updateCalls, directRequests } = runReport(report)
  const nodes = peerNodes(byId)
  const cards = byId("peer-radar-observations").children
  assert.equal(byId("peer-radar-warning").textContent, unsafe)
  assert.equal(byId("peer-radar-warning").children.length, 0)
  assert.ok(byId("peer-radar-analysis").textContent.includes(unsafe))
  assert.ok(byId("peer-radar-criteria").children.every(node => node.children[1].textContent === unsafe && !node.children[1].children.length))
  cards.forEach((card, index) => {
    for (const className of ["peer-symbol", "peer-name", "peer-radar-text"]) {
      const node = descendants(card).find(node => node.className === className)
      assert.equal(node.textContent, unsafe)
      assert.equal(node.children.length, 0)
    }
    assert.equal(descendants(card).find(node => node.tagName === "LI").textContent, unsafe)
    const links = descendants(card).filter(node => node.tagName === "A")
    assert.equal(links.length, 1)
    const url = new URL(links[0].href)
    assert.equal(url.origin, "https://www.tradingview.com")
    assert.equal(url.pathname, "/chart/")
    assert.equal(url.hash, "")
    assert.equal(url.username, "")
    assert.deepEqual([...url.searchParams], [["symbol", marketSymbols[[0, 2, 1][index]]]])
    assert.equal(links[0].rel, "noopener noreferrer")
    assert.equal(links[0].target, "_blank")
  })
  assert.ok(nodes.every(node => !["SCRIPT", "IMG", "SVG", "IFRAME"].includes(node.tagName)))
  assert.ok(nodes.every(node => !Object.hasOwn(node, "innerHTML")))
  assert.ok(nodes.every(node => !node.className?.includes(unsafe) && !node.dataset.symbol))
  assert.equal(byId("coin-symbol").textContent, "COTI")
  assert.equal(updateCalls.length, 0)
  assert.equal(directRequests.length, 0)
})

for (const bias of [undefined, "up", "down", "unclear"]) {
  test(`report shows movement estimates without a direction forecast for ${bias ?? "missing"} directionBias`, () => {
    const report = createReport(["COTI", "SOL", "ADA"])
    report.altMarketBackground = { status: "down", change4hPct: -1.5, breadth4h: 0.2, warning: null }
    report.coins.forEach((coin, index) => {
      coin.estimateConfidence = ["high", "medium", "low"][index]
      if (bias != null) {
        coin.directionBias = bias
      }
    })
    const before = structuredClone(report)
    const browser = runReport(report)
    const { byId } = browser

    assert.equal(byId("objective").textContent, "Цель анализа: P(|движение| > 2.5 ATR в следующие 4–12 часов)")
    for (const [index, [probability, confidence]] of [
      ["80%", "высокая"], ["70%", "средняя"], ["60%", "низкая"],
    ].entries()) {
      const coin = report.coins[index]
      const card = byId("top-candidates").children[index]
      const row = byId("candidate-rows").children[index]
      assert.equal(descendants(card).find(node => node.className === "top-card-probability").textContent, `${probability}P движения`)
      assert.equal(card.children.at(-1).textContent, `Уверенность: ${confidence}`)
      assert.equal(row.children.length, 2)
      assert.equal(row.children[1].textContent, probability)

      selectCoin(browser, coin.symbol)
      assert.deepEqual(byId("coin-badges").children.map(node => node.textContent), [
        `P движения ${probability}`, `Уверенность: ${confidence}`, "Social: нет данных",
      ])
      assert.equal(byId("explanation").textContent, coin.explanation)
      assert.match(byId("drivers").textContent, /Сжатие волатильности/)
      assert.deepEqual(byId("counter-signals").children.map(node => node.textContent), coin.counterSignals)
      assert.match(byId("flags").textContent, /Накопление в сжатии/)
      for (const node of [card, row, byId("coin-badges")]) {
        assert.doesNotMatch(node.textContent, /уклон|направлен|↑ Вверх|↓ Вниз|↔ Неясно/i)
      }
    }
    assert.equal(byId("alt-market-background").dataset.status, "down")
    assert.equal(byId("alt-market-status").textContent, "Преобладает снижение")
    assert.equal(byId("alt-market-change").textContent, "-1,5%")
    assert.equal(byId("alt-market-breadth").textContent, "20%")

    byId("search").value = "UNKNOWN"
    byId("search").listeners.get("input")()
    assert.equal(byId("candidate-rows").children[0].children[0].colSpan, 2)
    assert.equal(byId("candidate-rows").textContent, "Ничего не найдено")
    assert.deepEqual(report, before)
  })
}

function addDescriptions (report) {
  const coins = [...report.coins, ...(report.peerRadar?.data?.observations ?? []).map(observation => observation.coin)]
  report.coinDescriptions = Object.fromEntries(coins.map(coin => [coin.baseCurrencyId, {
    description: `${coin.name} — краткое описание проекта и назначения токена.`,
    sources: [
      { url: `https://www.example.com/${coin.baseCurrencyId}`, checkedAt: "2026-09-25T09:00:00.000Z" },
      { url: `https://api.coingecko.com/api/v3/coins/${coin.symbol.toLowerCase()}` },
    ],
  }]))
  return report.coinDescriptions
}

test("coin descriptions and compact source links follow selection and clear when an entry is missing", () => {
  const report = createReport(["COTI", "SOL", "MINA"])
  const descriptions = addDescriptions(report)
  delete descriptions.XTVCMINA
  const before = structuredClone(report)
  const browser = runReport(report)
  const { byId } = browser
  const section = () => byId("coin-description").children[0]
  const links = () => descendants(section()).filter(node => node.tagName === "A")

  assert.equal(section().tagName, "SECTION")
  assert.equal(section().attributes.get("aria-label"), "О монете COTI")
  assert.equal(section().children[0].textContent, descriptions.XTVCCOTI.description)
  assert.equal(section().hidden, false)
  assert.equal(byId("coin-description").hidden, false)
  assert.deepEqual(links().map(link => link.textContent), ["example.com", "CoinGecko"])
  assert.deepEqual(links().map(link => link.href), descriptions.XTVCCOTI.sources.map(source => source.url))
  assert.match(links()[0].title, /Проверено:.*2026.*UTC/)
  assert.equal(links()[1].title, undefined)
  assert.ok(links().every(link => link.target === "_blank" && link.rel === "noopener noreferrer"))
  assert.equal(peerPart(section(), "coin-description-sources").children[0].textContent, "Источники:")

  selectCoin(browser, "SOL")
  assert.equal(section().children[0].textContent, descriptions.XTVCSOL.description)
  assert.deepEqual(links().map(link => link.href), descriptions.XTVCSOL.sources.map(source => source.url))
  assert.equal(section().attributes.get("aria-label"), "О монете SOL")

  selectCoin(browser, "MINA")
  assert.equal(section().textContent, "Описание пока не добавлено")
  assert.deepEqual(links(), [])
  assert.equal(peerPart(section(), "coin-description-sources"), undefined)

  selectCoin(browser, "COTI")
  assert.equal(byId("coin-description").children.length, 1)
  assert.equal(section().children[0].textContent, descriptions.XTVCCOTI.description)
  assert.equal(links().length, 2)
  assert.deepEqual(report, before)
  assert.deepEqual(JSON.parse(byId("report-data").textContent), before)
  assert.deepEqual(browser.updateCalls, [])
  assert.deepEqual(browser.directRequests, [])
})

test("descriptions never fall back to a ticker, name or inherited object key", () => {
  for (const baseCurrencyId of [undefined, "DIFFERENT-ID", "__proto__", "constructor", "toString"]) {
    const report = createReport()
    addDescriptions(report)
    report.coins[0].baseCurrencyId = baseCurrencyId
    report.coinDescriptions.COTI = { description: "Wrong same-ticker entry", sources: [] }
    const { byId } = runReport(report)

    assert.equal(byId("coin-description").textContent, "Описание пока не добавлено")
    assert.equal(descendants(byId("coin-description")).filter(node => node.tagName === "A").length, 0)
  }
})

test("legacy reports without a description lookup retain the candidate and chart", () => {
  for (const coinDescriptions of [undefined, null, {}]) {
    const report = createReport()
    report.coinDescriptions = coinDescriptions
    const { byId, charts } = runReport(report)

    assert.equal(byId("coin-detail").hidden, false)
    assert.equal(byId("coin-description").textContent, "Описание пока не добавлено")
    assert.equal(byId("explanation").textContent, report.coins[0].explanation)
    assert.equal(charts.length, 1)
  }
})

test("radar descriptions appear before charts even with collapsed facts and distinguish same-ticker coins by ID", () => {
  const report = createReport()
  const radar = addPeerRadar(report, ["COTI", "OUTSIDE", "NOINFO"])
  const descriptions = addDescriptions(report)
  delete descriptions.noinfo
  const before = structuredClone(report)
  const browser = runReport(report)
  const { byId } = browser
  click(byId("peer-radar-tab"))
  const cards = byId("peer-radar-observations").children

  for (const observation of radar.observations) {
    const card = cards.find(card => card.children[0].children[0].textContent === observation.coin.symbol)
    const section = card.children.find(node => node.className === "coin-description")
    const info = descriptions[observation.coin.baseCurrencyId]
    const links = descendants(section).filter(node => node.tagName === "A")
    assert.ok(card.children.indexOf(section) > 0)
    assert.ok(card.children.indexOf(section) < card.children.indexOf(peerPart(card, "peer-comparison")))
    assert.equal(section.children[0].textContent, info?.description ?? "Описание пока не добавлено")
    assert.equal(section.hidden, false)
    assert.equal(peerPart(card, "peer-observation-facts").open, false)
    assert.deepEqual(links.map(link => link.href), (info?.sources ?? []).map(source => source.url))
    assert.ok(links.every(link => link.target === "_blank" && link.rel === "noopener noreferrer"))
  }
  assert.notEqual(descriptions.coti.description, descriptions.XTVCCOTI.description)
  assert.equal(byId("coin-description").children[0].children[0].textContent, descriptions.XTVCCOTI.description)
  assert.equal(report.coins.length, 1)
  assert.deepEqual(report, before)
  assert.deepEqual(browser.updateCalls, [])
  assert.deepEqual(browser.directRequests, [])
})

test("radar descriptions remain available without any main candidates", () => {
  const report = createReport([])
  addPeerRadar(report, ["OUTSIDE"])
  const descriptions = addDescriptions(report)
  const { byId, directRequests } = runReport(report)
  click(byId("peer-radar-tab"))
  const card = byId("peer-radar-observations").children[0]

  assert.equal(byId("coin-detail").hidden, true)
  assert.equal(peerPart(card, "coin-description").children[0].textContent, descriptions.outside.description)
  assert.equal(descendants(peerPart(card, "coin-description")).filter(node => node.tagName === "A").length, 2)
  assert.deepEqual(directRequests, [])
})

test("description text stays literal and both views activate only absolute HTTP/HTTPS source URLs", () => {
  const report = createReport()
  addPeerRadar(report, ["OUTSIDE"])
  const descriptions = addDescriptions(report)
  const unsafe = "</script><script>alert(1)</script><img src=x onerror=alert(1)>"
  for (const info of Object.values(descriptions)) {
    info.description = unsafe
    info.sources = [
      { url: "javascript:alert(1)" },
      { url: "data:text/html,<script>alert(1)</script>" },
      { url: "file:///tmp/private" },
      { url: "//example.com/relative" },
      { url: "not a URL" },
      { url: "mailto:test@example.com" },
      { url: `https://www.safe.example/about?text=${encodeURIComponent(unsafe)}`, checkedAt: unsafe },
      { url: "http://docs.safe.example/about", checkedAt: "2026-09-25T09:00:00.000Z" },
    ]
  }
  const { byId, updateCalls, directRequests } = runReport(report)
  click(byId("peer-radar-tab"))
  const sections = [byId("coin-description").children[0], peerPart(byId("peer-radar-observations").children[0], "coin-description")]

  for (const section of sections) {
    const links = descendants(section).filter(node => node.tagName === "A")
    assert.equal(section.children[0].textContent, unsafe)
    assert.equal(section.children[0].children.length, 0)
    assert.deepEqual(links.map(link => link.textContent), ["safe.example", "docs.safe.example"])
    assert.ok(links.every(link => ["http:", "https:"].includes(new URL(link.href).protocol)))
    assert.ok(links.every(link => link.target === "_blank" && link.rel === "noopener noreferrer"))
    assert.equal(links[0].title, "Проверено: Время не указано")
    assert.ok(descendants(section).every(node => !["IMG", "SCRIPT"].includes(node.tagName)))
  }
  assert.deepEqual(updateCalls, [])
  assert.deepEqual(directRequests, [])
})

test("empty or unsafe-only source lists leave descriptions visible without a dangling sources label", () => {
  for (const sources of [[], [{ url: "javascript:alert(1)" }]]) {
    const report = createReport()
    addPeerRadar(report, ["OUTSIDE"])
    const descriptions = addDescriptions(report)
    Object.values(descriptions).forEach(info => info.sources = sources)
    const { byId } = runReport(report)
    const sections = [byId("coin-description").children[0], peerPart(byId("peer-radar-observations").children[0], "coin-description")]

    for (const section of sections) {
      assert.match(section.children[0].textContent, /краткое описание проекта/)
      assert.equal(section.children.length, 1)
      assert.equal(section.hidden, false)
    }
  }
})

test("CoinGecko badges and categories follow the selected coin without leaking stale data", () => {
  const report = createReport(["COTI", "SOL", "MINA"])
  Object.assign(report.coins[0].features, {
    coingeckoId: "coti", coingeckoTrending: true, coingeckoTrendingCategories: ["Privacy", "Layer 1"],
    category: "tradingview-category",
  })
  Object.assign(report.coins[1].features, {
    coingeckoId: "solana", coingeckoTrending: true, coingeckoTrendingCategories: [],
  })
  const before = structuredClone(report)
  const browser = runReport(report)
  const { byId } = browser
  const badges = node => descendants(node).filter(child => child.className === "badge coingecko-badge")

  assert.equal(byId("coingecko-badge").hidden, false)
  assert.equal(byId("coingecko-badge").textContent, "CoinGecko Trending")
  assert.equal(byId("coingecko-context").hidden, false)
  assert.deepEqual(byId("coingecko-categories").children.map(node => node.textContent), ["Privacy", "Layer 1"])
  assert.equal(byId("coingecko-category-status").hidden, true)
  assert.equal(badges(byId("top-candidates")).length, 2)
  assert.equal(badges(byId("candidate-rows")).length, 2)
  assert.equal(badges(byId("candidate-rows")).every(badge => badge.textContent === "CoinGecko Trending"), true)
  assert.equal(byId("feature-rows").children.find(row => row.children[0].textContent === "coingeckoTrendingCategories")
    .children[1].textContent, "Privacy, Layer 1")

  selectCoin(browser, "SOL")
  assert.equal(byId("coingecko-badge").hidden, false)
  assert.equal(byId("coingecko-context").hidden, false)
  assert.equal(byId("coingecko-categories").children.length, 0)
  assert.equal(byId("coingecko-category-status").hidden, false)
  assert.equal(byId("coingecko-category-status").textContent, "Нет пересечений с трендовыми категориями")
  assert.equal(byId("feature-rows").children.find(row => row.children[0].textContent === "coingeckoTrendingCategories")
    .children[1].textContent, "Нет пересечений с трендовыми категориями")

  selectCoin(browser, "MINA")
  assert.equal(byId("coingecko-badge").hidden, true)
  assert.equal(byId("coingecko-badge").children.length, 0)
  assert.equal(byId("coingecko-context").hidden, true)
  assert.equal(byId("coingecko-categories").children.length, 0)
  assert.equal(byId("coingecko-category-status").hidden, true)
  assert.equal(byId("coingecko-category-status").textContent, "")

  selectCoin(browser, "COTI")
  assert.deepEqual(byId("coingecko-categories").children.map(node => node.textContent), ["Privacy", "Layer 1"])
  assert.equal(byId("coingecko-badge").children.length, 1)
  assert.deepEqual(report, before)
  assert.deepEqual(browser.updateCalls, [])
  assert.deepEqual(browser.directRequests, [])
})

for (const status of [undefined, null, false, "true"]) {
  test(`CoinGecko badges require a confirmed true flag, not ${String(status)}`, () => {
    const report = createReport()
    Object.assign(report.coins[0].features, {
      coingeckoId: "coti", coingeckoTrending: status, coingeckoTrendingCategories: ["Privacy"],
    })
    const { byId } = runReport(report)

    assert.equal(byId("coingecko-badge").hidden, true)
    assert.equal(byId("coingecko-context").hidden, true)
    assert.equal(byId("coingecko-categories").children.length, 0)
    for (const id of ["top-candidates", "candidate-rows"]) {
      assert.equal(descendants(byId(id)).some(node => node.className === "badge coingecko-badge"), false)
    }
  })
}

for (const categories of [null, undefined]) {
  test(`missing CoinGecko categories ${String(categories)} are not reported as an empty intersection`, () => {
    const report = createReport()
    Object.assign(report.coins[0].features, {
      coingeckoId: "coti", coingeckoTrending: true, coingeckoTrendingCategories: categories,
    })
    const { byId } = runReport(report)

    assert.equal(byId("coingecko-badge").hidden, false)
    assert.equal(byId("coingecko-category-status").textContent, "Нет данных о категориях")
    assert.equal(byId("coingecko-category-status").hidden, false)
  })
}

test("CoinGecko category names are literal text and never become markup", () => {
  const report = createReport()
  const unsafe = "<img src=x onerror=alert(1)> & Privacy"
  Object.assign(report.coins[0].features, {
    coingeckoId: "coti", coingeckoTrending: true, coingeckoTrendingCategories: [unsafe],
  })
  const { byId } = runReport(report)
  const [category] = byId("coingecko-categories").children

  assert.equal(category.tagName, "SPAN")
  assert.equal(category.textContent, unsafe)
  assert.equal(category.children.length, 0)
  assert.equal(descendants(byId("coingecko-context")).some(node => node.tagName === "IMG"), false)
})

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

function addInformation (report, coin = report.coins[0]) {
  report.informationSources = {
    news: { from: "2026-09-14T10:45:00.000Z", asOf: "2026-09-15T10:45:00.000Z" },
    twitter: { from: "2026-09-14T11:00:00.000Z", asOf: "2026-09-15T11:00:00.000Z" },
    contextGeneratedAt: "2026-09-15T11:05:00.000Z",
  }
  coin.explanation = [coin.topRank == null ? "" : "Исходная оценка.", "Дополненное объяснение из шага 10."].filter(Boolean).join(" ")
  coin.information = {
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
  return coin.information
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

test("initializes the first ranked top candidate, hourly whitespace grid and seven-day range", () => {
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
    from: Date.parse("2026-09-08T10:00:00.000Z") / 1_000,
    to: Date.parse(report.asOf) / 1_000,
  })
  assert.deepEqual(days.map(node => node.attributes.get("aria-pressed")), ["false", "false", "true"])
  for (const [value, from] of [["1", "2026-09-14T10:00:00.000Z"], ["3", "2026-09-12T10:00:00.000Z"], ["7", "2026-09-08T10:00:00.000Z"]]) {
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

for (const [label, topRank, trending] of [["top", 1, false], ["non-top trending", null, true], ["top and trending", 1, true]]) {
  test(`${label} candidates show enriched explanations, news, tweets and their independent collection times once`, () => {
    const report = createReport()
    report.coins[0].topRank = topRank
    report.coins[0].features.coingeckoTrending = trending
    addInformation(report)
    const before = structuredClone(report)
    const { byId, updateCalls, directRequests } = runReport(report)
    assert.equal(byId("information-panel").hidden, false)
    assert.equal(byId("news-details").open, false)
    assert.equal(byId("twitter-details").open, false)
    assert.equal(byId("explanation").hidden, false)
    assert.equal(byId("explanation").textContent, report.coins[0].explanation)
    if (topRank == null) {
      assert.equal(byId("explanation").textContent, "Дополненное объяснение из шага 10.")
    }
    assert.match(byId("analysis-source").textContent, /шаге 10/)
    assert.match(byId("context-generated").textContent, /11:05/)
    assert.match(byId("news-window").textContent, /10:45/)
    assert.match(byId("twitter-window").textContent, /11:00/)
    assert.equal(byId("as-of").dateTime, report.asOf)
    assert.equal(byId("news-count").textContent, "1")
    assert.equal(byId("twitter-count").textContent, "1")
    assert.equal(byId("news-items").children.length, 1)
    assert.equal(byId("twitter-items").children.length, 1)
    assert.equal(byId("news-status").hidden, true)
    assert.equal(byId("twitter-status").hidden, true)
    assert.match(byId("news-items").textContent, /Crypto News.*10:30/)
    assert.match(byId("news-items").textContent, /Полный сохранённый текст\nВторой абзац/)
    assert.match(byId("twitter-items").textContent, /@researcher.*10:50/)
    assert.match(byId("twitter-items").textContent, /Лайки: 12.*Репосты: 3.*Просмотры: 456/)
    const links = [...descendants(byId("news-items")), ...descendants(byId("twitter-items"))].filter(node => node.tagName === "A")
    assert.deepEqual(links.map(link => link.href), ["https://example.com/news", "https://www.tradingview.com/news/story/", "https://x.com/i/status/1234567890123456789"])
    assert.ok(links.every(link => link.target === "_blank" && link.rel === "noopener noreferrer"))
    assert.equal(byId("candidate-rows").children.length, 1)
    assert.equal(byId("candidate-count").textContent, "1")
    assert.equal(byId("top-candidates").children.filter(node => node.dataset.symbol === "COTI").length, topRank == null ? 0 : 1)
    assert.equal(byId("top-rank").hidden, topRank == null)
    assert.match(byId("coin-badges").textContent, /P движения 80%/)
    assert.match(byId("drivers").textContent, /Сжатие волатильности/)
    assert.match(byId("counter-signals").textContent, /Нет подтверждения объёмом/)
    assert.deepEqual(JSON.parse(byId("report-data").textContent), before)
    assert.deepEqual(report, before)
    assert.deepEqual(updateCalls, [])
    assert.deepEqual(directRequests, [])
  })
}

for (const [sentiment, label] of [
  ["positive", "Позитивный инфоповод"],
  ["negative", "Негативный инфоповод"],
  ["mixed", "Смешанный инфоповод"],
  ["neutral", "Нейтральный инфоповод"],
]) {
  test(`${sentiment} social news uses an accessible sidebar SVG and the exact reason for top and trending coins`, () => {
    const report = createReport(["TOP", "TRENDING"])
    report.coins[1].topRank = null
    report.coins[1].features.coingeckoTrending = true
    report.coins.forEach((coin) => {
      addInformation(report, coin)
      Object.assign(coin, { socialSignificant: true, socialSentiment: sentiment, socialReason: `Событие ${coin.symbol}: «точная причина».` })
    })
    const before = structuredClone(report)
    const browser = runReport(report)
    const { byId } = browser

    for (const coin of report.coins) {
      const row = byId("candidate-rows").children.find(row => row.dataset.symbol === coin.symbol)
      const indicators = descendants(row).filter(node => node.className === "social-indicator")
      assert.equal(indicators.length, 1)
      const indicator = indicators[0]
      const title = `${label}: ${coin.socialReason}`
      assert.equal(row.children[0].children[0].children[coin.topRank == null ? 1 : 2], indicator)
      assert.equal(indicator.dataset.sentiment, sentiment)
      assert.equal(indicator.title, title)
      assert.equal(indicator.attributes.get("role"), "img")
      assert.equal(indicator.attributes.get("aria-label"), title)
      const svg = indicator.children[0]
      assert.equal(svg.tagName, "SVG")
      assert.equal(svg.namespaceURI, "http://www.w3.org/2000/svg")
      assert.equal(svg.attributes.get("viewBox"), "0 0 24 24")
      assert.equal(svg.attributes.get("fill"), "none")
      assert.equal(svg.attributes.get("stroke"), "currentColor")
      assert.equal(svg.attributes.get("aria-hidden"), "true")
      assert.equal(svg.attributes.get("focusable"), "false")
      assert.equal(svg.children[0].tagName, "PATH")
      assert.equal(svg.children[0].namespaceURI, svg.namespaceURI)
      assert.ok(svg.children[0].attributes.get("d"))

      click(byId("candidate-rows"), svg.children[0])
      assert.equal(byId("coin-symbol").textContent, coin.symbol)
      assert.equal(byId("top-rank").hidden, coin.topRank == null)
      assert.equal(byId("information-panel").hidden, false)
      assert.equal(byId("social-reason").hidden, false)
      assert.equal(byId("social-reason").textContent, title)
    }
    assert.equal(descendants(byId("top-candidates")).filter(node => node.className === "social-indicator").length, 0)
    assert.deepEqual(JSON.parse(byId("report-data").textContent), before)
    assert.deepEqual(report, before)
    assert.deepEqual(browser.updateCalls, [])
    assert.deepEqual(browser.directRequests, [])
  })
}

test("sidebar social indicators require literal true, never false, unknown, absent or truthy alternatives", () => {
  for (const socialSignificant of [false, null, undefined, 0, 1, "true", {}, []]) {
    const report = createReport()
    addInformation(report)
    if (socialSignificant !== undefined) {
      Object.assign(report.coins[0], { socialSignificant, socialReason: "Значимость не подтверждена", socialSentiment: null })
    }
    const { byId } = runReport(report)
    assert.equal(descendants(byId("candidate-rows")).filter(node => node.className === "social-indicator").length, 0)
    assert.equal(descendants(byId("top-candidates")).filter(node => node.className === "social-indicator").length, 0)
  }
})

test("switching coins replaces the social reason and clears it for unknown, legacy and unenriched coins", () => {
  const report = createReport(["TOP", "TRENDING", "QUIET", "UNKNOWN", "LEGACY", "PLAIN"])
  report.coins[1].topRank = null
  report.coins[1].features.coingeckoTrending = true
  report.coins[5].topRank = null
  report.coins.slice(0, 5).forEach(coin => addInformation(report, coin))
  Object.assign(report.coins[0], { socialSignificant: true, socialReason: "Новое партнёрство", socialSentiment: "positive" })
  Object.assign(report.coins[1], { socialSignificant: true, socialReason: "Взлом протокола", socialSentiment: "negative" })
  Object.assign(report.coins[2], { socialSignificant: false, socialReason: "Только повторяющиеся упоминания", socialSentiment: null })
  Object.assign(report.coins[3], { socialSignificant: null, socialReason: null, socialSentiment: null })
  const before = structuredClone(report)
  const browser = runReport(report)
  const { byId } = browser

  for (const [symbol, text] of [
    ["TOP", "Позитивный инфоповод: Новое партнёрство"],
    ["TRENDING", "Негативный инфоповод: Взлом протокола"],
    ["QUIET", "Только повторяющиеся упоминания"],
    ["UNKNOWN", ""],
    ["TOP", "Позитивный инфоповод: Новое партнёрство"],
    ["LEGACY", ""],
    ["TRENDING", "Негативный инфоповод: Взлом протокола"],
    ["PLAIN", ""],
    ["TOP", "Позитивный инфоповод: Новое партнёрство"],
  ]) {
    selectCoin(browser, symbol)
    assert.equal(byId("social-reason").textContent, text)
    assert.equal(byId("social-reason").hidden, !text)
    assert.equal(byId("information-panel").hidden, symbol === "PLAIN")
  }
  assert.deepEqual(JSON.parse(byId("report-data").textContent), before)
  assert.deepEqual(report, before)
})

test("social reason markup stays literal in the tooltip, accessible name and information section", () => {
  const report = createReport()
  addInformation(report)
  const unsafe = "</script><img src=x onerror=alert(1)>\" aria-label=\"injected & <svg onload=alert(2)>"
  Object.assign(report.coins[0], { socialSignificant: true, socialReason: unsafe, socialSentiment: "negative" })
  const { byId } = runReport(report)
  const indicator = descendants(byId("candidate-rows")).find(node => node.className === "social-indicator")

  assert.equal(indicator.title, `Негативный инфоповод: ${unsafe}`)
  assert.equal(indicator.attributes.get("aria-label"), indicator.title)
  assert.equal(byId("social-reason").textContent, indicator.title)
  assert.deepEqual(byId("social-reason").children, [])
  assert.deepEqual(descendants(indicator).map(node => node.tagName), ["SVG", "PATH"])
  assert.equal(indicator.attributes.has("onerror"), false)
  assert.equal(indicator.children[0].attributes.has("onload"), false)
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

test("non-top trending coins keep empty searches, failed sources and partial publications visible", () => {
  const report = createReport(["TOP", "TRENDING"])
  report.coins[1].topRank = null
  report.coins[1].features.coingeckoTrending = true
  const information = addInformation(report, report.coins[1])
  information.news = { status: "empty", error: null, items: [] }
  information.twitter.status = "failed"
  information.twitter.error = "Second page unavailable"
  const before = structuredClone(report)
  const browser = runReport(report)
  const { byId } = browser
  selectCoin(browser, "TRENDING")

  assert.equal(byId("information-panel").hidden, false)
  assert.equal(byId("news-status").hidden, false)
  assert.match(byId("news-status").textContent, /ничего не найдено/)
  assert.equal(byId("news-count").textContent, "0")
  assert.equal(byId("news-items").children.length, 0)
  assert.equal(byId("twitter-status").hidden, false)
  assert.match(byId("twitter-status").textContent, /Ошибка загрузки: Second page unavailable/)
  assert.equal(byId("twitter-count").textContent, "ошибка")
  assert.equal(byId("twitter-items").children.length, 1)
  assert.match(byId("twitter-items").textContent, /Публикация о монете/)
  assert.equal(byId("explanation").textContent, report.coins[1].explanation)
  assert.match(byId("analysis-source").textContent, /шаге 10/)
  assert.deepEqual(report, before)
})

test("switching from a top or trending coin to a plain non-top clears source data and collapses the panels", () => {
  const report = createReport(["TOP", "TRENDING", "PLAIN"])
  report.coins[1].topRank = null
  report.coins[1].features.coingeckoTrending = true
  report.coins[2].topRank = null
  report.coins[2].explanation = ""
  addInformation(report)
  const trending = addInformation(report, report.coins[1])
  trending.news.items[0].title = "Новость о трендовой монете"
  trending.twitter.tweets[0].text = "Обсуждение трендовой монеты"
  const before = structuredClone(report)
  const browser = runReport(report)
  const { byId } = browser

  for (const symbol of ["TOP", "TRENDING"]) {
    selectCoin(browser, symbol)
    assert.equal(byId("information-panel").hidden, false)
    byId("news-details").open = true
    byId("twitter-details").open = true
    selectCoin(browser, "PLAIN")
    assert.equal(byId("information-panel").hidden, true)
    for (const key of ["news", "twitter"]) {
      assert.equal(byId(`${key}-items`).children.length, 0)
      assert.equal(byId(`${key}-count`).textContent, "")
      assert.equal(byId(`${key}-window`).textContent, "")
      assert.equal(byId(`${key}-status`).textContent, "")
      assert.equal(byId(`${key}-status`).hidden, true)
      assert.equal(byId(`${key}-details`).open, false)
    }
    assert.equal(byId("context-generated").textContent, "")
    assert.equal(byId("analysis-source").textContent, "Анализ шага 7")
    assert.equal(byId("explanation").textContent, report.coins[2].explanation)
    assert.equal(byId("explanation").hidden, true)
    selectCoin(browser, symbol)
    assert.equal(byId("information-panel").hidden, false)
    assert.equal(byId("news-details").open, false)
    assert.equal(byId("twitter-details").open, false)
    assert.equal(byId("news-items").children.length, 1)
    assert.equal(byId("twitter-items").children.length, 1)
    const coin = report.coins.find(coin => coin.symbol === symbol)
    assert.equal(byId("explanation").textContent, coin.explanation)
    assert.ok(byId("news-items").textContent.includes(coin.information.news.items[0].title))
    assert.ok(byId("twitter-items").textContent.includes(coin.information.twitter.tweets[0].text))
  }

  assert.equal(byId("candidate-count").textContent, "3")
  assert.deepEqual(byId("candidate-rows").children.map(node => node.dataset.symbol), ["TOP", "TRENDING", "PLAIN"])
  assert.deepEqual(byId("top-candidates").children.map(node => node.dataset.symbol), ["TOP"])
  assert.deepEqual(JSON.parse(byId("report-data").textContent), before)
  assert.deepEqual(report, before)
  assert.deepEqual(browser.updateCalls, [])
  assert.deepEqual(browser.directRequests, [])
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

test("social indicators preserve top selection, sorting, filtering and movement assessments", () => {
  const report = createReport(["COTI", "SOL", "ADA", "BTC"])
  Object.assign(report.coins[0], { topRank: 2, estimateConfidence: "low" })
  Object.assign(report.coins[1], { topRank: null, estimateConfidence: "low" })
  Object.assign(report.coins[2], { topRank: null, estimateConfidence: "high" })
  Object.assign(report.coins[3], { topRank: 1, estimateConfidence: "medium" })
  report.coins.slice(1, 3).forEach((coin) => {
    coin.features.coingeckoTrending = true
    addInformation(report, coin)
    Object.assign(coin, { socialSignificant: true, socialReason: `Событие ${coin.symbol}`, socialSentiment: "mixed" })
  })
  const before = structuredClone(report)
  const browser = runReport(report)
  const { byId } = browser

  assert.equal(byId("coin-symbol").textContent, "BTC")
  assert.deepEqual(byId("top-candidates").children.map(card => card.dataset.symbol), ["BTC", "COTI"])
  assert.equal(byId("sort").value, "top")
  assert.deepEqual(byId("candidate-rows").children.map(row => row.dataset.symbol), ["BTC", "COTI", "SOL", "ADA"])

  for (const [sort, expected] of [
    ["probability", ["COTI", "SOL", "ADA", "BTC"]],
    ["top", ["BTC", "COTI", "SOL", "ADA"]],
    ["confidence", ["ADA", "BTC", "COTI", "SOL"]],
  ]) {
    byId("sort").value = sort
    byId("sort").listeners.get("change")()
    assert.deepEqual(byId("candidate-rows").children.map(row => row.dataset.symbol), expected)
    assert.equal(byId("coin-symbol").textContent, "BTC")
    assert.equal(byId("candidate-rows").children.find(row => row.className === "selected").dataset.symbol, "BTC")
    for (const row of byId("candidate-rows").children) {
      const coin = report.coins.find(coin => coin.symbol === row.dataset.symbol)
      assert.equal(row.children[1].textContent, `${Math.round(coin.movementProbability * 100)}%`)
    }
  }
  selectCoin(browser, "SOL")
  byId("search").value = "ADA"
  byId("search").listeners.get("input")()
  assert.deepEqual(byId("candidate-rows").children.map(row => row.dataset.symbol), ["ADA"])
  assert.equal(byId("coin-symbol").textContent, "SOL")
  assert.equal(byId("social-reason").textContent, "Смешанный инфоповод: Событие SOL")
  assert.equal(byId("top-rank").hidden, true)
  assert.equal(byId("candidate-count").textContent, "4")
  assert.equal(byId("explanation").textContent, report.coins[1].explanation)
  assert.match(byId("drivers").textContent, /Сжатие волатильности/)
  assert.deepEqual(byId("counter-signals").children.map(node => node.textContent), report.coins[1].counterSignals)
  assert.deepEqual(JSON.parse(byId("report-data").textContent), before)
  assert.deepEqual(report, before)
  assert.deepEqual(browser.updateCalls, [])
  assert.deepEqual(browser.directRequests, [])
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
  for (const sort of ["probability", "top", "confidence"]) {
    browser.byId("sort").value = sort
    browser.byId("sort").listeners.get("change")()
  }

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
  assert.deepEqual(chart.ranges.at(-1), { from: chartTime(report, 200 - 167), to: chartTime(report, 200) })
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
  click(browser.days.find(day => day.dataset.days === "3"))
  assert.equal(browser.byId("report-data").textContent, embedded)

  const reloaded = runReport(JSON.parse(embedded), { updateChartHistory })
  assert.equal(reloaded.updateCalls.length, 0)
  assert.equal(reloaded.directRequests.length, 0)
  assert.equal(reloaded.markers.length, 0)
  assert.deepEqual(chartSeries(reloaded.charts[0], "Candlestick").data, report.coins[0].history.candles)
  assert.match(reloaded.byId("chart-update-status").textContent, /Сохранённый срез/)
  assert.match(reloaded.byId("chart-source").textContent, /сохранённые данные TradingView/)
  assert.equal(reloaded.byId("chart-update-error").hidden, true)
  assert.deepEqual(reloaded.days.map(day => day.attributes.get("aria-pressed")), ["false", "false", "true"])
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
    coingeckoId: "coti", coingeckoTrending: true, coingeckoTrendingCategories: ["Privacy"],
  })
  addInformation(report)
  addDescriptions(report)
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
    "coingecko-badge", "coingecko-context", "coingecko-categories", "coingecko-category-status", "coin-description",
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
