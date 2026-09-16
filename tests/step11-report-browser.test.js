import assert from "node:assert/strict"
import fs from "node:fs/promises"
import test from "node:test"
import vm from "node:vm"

import { isFinite, isFunction } from "../src/helpers/utils.typed.js"

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

function runReport (report) {
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
  script.runInNewContext({
    URL,
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
      createChart (container, options) {
        const chart = createChart(container, options)
        charts.push(chart)
        return chart
      },
    },
  }, { timeout: 1_000 })
  return { byId, charts, days }
}

function click (node, target = node) {
  assert.ok(isFunction(node.listeners.get("click")))
  node.listeners.get("click")({ target })
}

function createReport (symbols = ["COTI"]) {
  const report = {
    asOf: "2026-09-15T09:00:00.000Z",
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
