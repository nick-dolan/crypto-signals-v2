import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

import { buildHourlyChartData } from "../src/helpers/hourly-chart-data-helper.js"
import { renderSvgPng } from "../src/helpers/svg-helper.js"
import { isArray, isFinite, isObject } from "../src/helpers/utils.typed.js"
import { buildPatternChartData, buildPatternChartSvg } from "../src/steps/step8.1-pattern-enrichment/render-pattern-chart.js"

function fixture () {
  const report = { asOf: "2026-09-30T23:00:00.000Z", timeframe: "1h" }
  const asOf = Date.parse(report.asOf) / 1_000
  const candles = Array.from({ length: 168 }, (_, index) => ({
    time: asOf - (167 - index) * 3_600,
    open: 100 + index, high: 102 + index, low: 98 + index, close: 100 + index + (index % 2 ? 1 : -1),
  }))
  const coin = {
    symbol: "ТЕСТ", name: "Синтетическая монета", marketSymbol: "BINANCE:TESTUSDT.P",
    history: { candles, volume: candles.map(({ time }, index) => ({ time, value: index * 100 })), warning: null },
  }
  return { report, coin }
}

function metadata (svg) {
  return JSON.parse(svg.match(/<desc>([\s\S]*?)<\/desc>/)[1].replace(/&(amp|lt|gt|quot|apos);/g, (_, name) => ({
    amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'",
  })[name]))
}

function visibleText (svg) {
  return [...svg.matchAll(/<text\b[^>]*>([^<]*)<\/text>/g)].map(([, value]) => value).join("\n")
}

function candleBars (svg) {
  return [...svg.matchAll(/<g class="candle" data-time="(\d+)">([\s\S]*?)<\/g>/g)].map(([, time, content]) => {
    const wick = content.match(/<line class="wick" x1="([^"]+)" x2="([^"]+)"/)
    assert.equal(Number(wick[1]), Number(wick[2]), "Wicks must be vertical")
    const body = content.match(/<rect class="body" x="([^"]+)"[^>]*width="([^"]+)"/)
    const doji = content.match(/<line class="doji" x1="([^"]+)" x2="([^"]+)"/)
    assert.ok(body || doji, "Each candle needs a body or an explicit doji")
    return {
      time: Number(time), center: Number(wick[1]),
      x: Number(body?.[1] ?? doji[1]),
      width: body ? Number(body[2]) : Number(doji[2]) - Number(doji[1]),
    }
  })
}

function volumeBars (svg) {
  return [...svg.matchAll(/<rect class="volume-bar" data-time="(\d+)" x="([^"]+)"[^>]*width="([^"]+)" height="([^"]+)" fill="([^"]+)"/g)]
    .map(([, time, x, width, height, color]) => ({ time: Number(time), x: Number(x), width: Number(width), height: Number(height), color }))
}

function assertSvg (svg) {
  assert.match(svg, /^<svg\b[^>]*width="1400"[^>]*height="800"[^>]*viewBox="0 0 1400 800"/)
  assert.match(svg, /<rect width="1400" height="800" fill="#fff"\/>/)
  assert.doesNotMatch(svg, /NaN|Infinity|\b(?:rx|ry)=|stroke-dasharray=|<path\b/)
  for (const [, name, value] of svg.matchAll(/\b(x|y|x1|x2|y1|y2|width|height|stroke-width|font-size)="([^"]*)"/g)) {
    assert.ok(value !== "" && isFinite(Number(value)), `Non-finite ${name}=${value}`)
  }
  for (const [, color] of svg.matchAll(/\b(?:fill|stroke)="([^"]+)"/g)) {
    assert.ok(["#fff", "#000", "#999"].includes(color), `Non-monochrome color ${color}`)
  }
}

function assertHourlyBars (svg, data) {
  const candles = candleBars(svg)
  const volumes = volumeBars(svg)
  assert.deepEqual(candles.map(candle => candle.time), data.points.filter(point => point.candle).map(point => point.time))
  assert.deepEqual(volumes.map(bar => bar.time), data.points.filter(point => point.volume !== null).map(point => point.time))
  assert.ok(volumes.every(bar => bar.color === "#999"), "Volume must not encode candle direction")
  for (const [bars, points] of [
    [candles, data.points.filter(point => point.candle)],
    [volumes, data.points.filter(point => point.volume !== null)],
  ]) {
    assert.equal(bars.length, points.length)
    for (const [index, bar] of bars.entries()) {
      const center = 64 + ((points[index].time - data.points[0].time) / 3_600 + 0.5) * 1240 / data.points.length
      assert.ok(Math.abs(bar.width - 1240 / data.points.length * 0.65) < 1e-9, "Gaps must not widen hourly bars")
      assert.ok(Math.abs(bar.x + bar.width / 2 - center) < 1e-9, "Price and volume must share their hourly grid")
      if (index > 0) {
        assert.ok(bars[index - 1].x + bars[index - 1].width < bar.x, "Bars must not overlap")
      }
    }
  }
  for (const candle of candles) {
    assert.ok(Math.abs(candle.center - candle.x - candle.width / 2) < 1e-9, "Bodies and wicks must share their center")
  }
}

function deepFreeze (value) {
  if (isArray(value) || isObject(value)) {
    Object.values(value).forEach(deepFreeze)
    Object.freeze(value)
  }
  return value
}

async function localDependencies (url, visited = new Set()) {
  if (visited.has(url.href)) {
    return visited
  }
  visited.add(url.href)
  assert.doesNotMatch(url.pathname, /coin-card/)
  const source = await readFile(url, "utf8")
  assert.doesNotMatch(source, /coin-card|CoinCard/)
  const imports = [...source.matchAll(/\bfrom\s+"([^"]+)"/g)].map(([, path]) => path).filter(path => path.startsWith("."))
  await Promise.all(imports.map(path => localDependencies(new URL(path, url), visited)))
  return visited
}

test("pattern rendering has no direct or transitive coin-card dependency and card exports no pattern functions", async () => {
  const dependencies = await localDependencies(new URL("../src/steps/step8.1-pattern-enrichment/render-pattern-chart.js", import.meta.url))
  assert.ok([...dependencies].some(path => path.endsWith("/helpers/hourly-chart-data-helper.js")))
  assert.ok([...dependencies].some(path => path.endsWith("/helpers/svg-helper.js")))
  for (const path of ["build-coin-card-data.js", "render-coin-card.js"]) {
    const source = await readFile(new URL(`../src/reports/coin-card/${path}`, import.meta.url), "utf8")
    assert.doesNotMatch(source, /buildPatternChart|render-pattern-chart|step8\.1-pattern-enrichment/)
  }
})

for (const hours of [168, 48]) {
  test(`${hours}-hour data retains exact closed hourly observations without OI or assessments`, () => {
    const { report, coin } = fixture()
    const data = buildPatternChartData(report, coin, { hours })
    assert.equal(data.asOf, Date.parse(report.asOf) / 1_000)
    assert.equal(data.closedAt, Date.parse("2026-10-01T00:00:00.000Z") / 1_000)
    assert.equal(data.points.length, hours)
    assert.equal(data.points[0].time, data.asOf - (hours - 1) * 3_600)
    assert.equal(data.points.at(-1).time, data.asOf)
    assert.equal(data.closedAt - data.points[0].time, hours * 3_600)
    assert.deepEqual(data.points, coin.history.candles.slice(-hours).map((candle, index) => ({
      time: candle.time, candle, volume: coin.history.volume.slice(-hours)[index].value,
    })))
    assert.deepEqual(data.coverage, { candles: hours, volume: hours })
    assert.equal(data.price, coin.history.candles.at(-1).close)
    assert.deepEqual(data.warnings, [])
    assert.deepEqual(data, buildHourlyChartData(report, coin, { hours }))
    for (const key of ["growthObjective", "change4hPct", "change24hPct", "oiChange4hPct", "relativeVolume"]) {
      assert.equal(data[key], undefined, key)
    }
  })

  test(`${hours}-hour SVG keeps exact market and UTC cutoffs only in title/desc and has no visible header`, () => {
    const { report, coin } = fixture()
    coin.marketSymbol = "BINANCE:VERYLONGEXACTMARKETIDENTIFIERUSDT.P"
    report.reportCreatedAt = "2035-01-01T12:34:56.000Z"
    const data = buildPatternChartData(report, coin, { hours })
    const svg = buildPatternChartSvg(report, coin, { hours })
    assertSvg(svg)
    assertHourlyBars(svg, data)
    assert.equal(svg.match(/<title>([^<]*)<\/title>/)[1], `${coin.marketSymbol} · ${hours}h · asOf ${report.asOf}`)
    assert.deepEqual(metadata(svg), {
      symbol: coin.symbol, name: coin.name, marketSymbol: coin.marketSymbol,
      timeframe: "1h", hours, asOf: report.asOf, closedAt: "2026-10-01T00:00:00.000Z",
      from: new Date(data.points[0].time * 1_000).toISOString(),
      timeZone: "UTC", timeAxis: "candle open", coverage: { candles: hours, volume: hours }, warnings: [],
    })
    const visible = visibleText(svg)
    for (const value of [coin.symbol, coin.name, coin.marketSymbol, report.asOf, "2035-01-01", "asOf", "warnings", "gaps preserved"]) {
      assert.ok(!visible.includes(value), `Unexpected visible metadata: ${value}`)
    }
    assert.match(visible, /hollow up\nfilled down\ndoji/)
    assert.match(visible, /Price/)
    assert.match(visible, /Volume/)
    assert.match(visible, /2026-09-\d{2} \d{2}:00/)
    assert.match(visible, /UTC/)
    assert.doesNotMatch(svg, /price-panel|volume-panel|last-price|annotation|trend-line|2035-01-01|Нет данных/)
    assert.match(svg, /<g id="price-axis"><line[^>]*y1="34" y2="590"/)
    assert.match(svg, /<g id="volume-axis"><line[^>]*y1="618" y2="736"/)
    assert.ok(590 - 34 > (736 - 618) * 4, "Price must occupy most of the plot")
    for (const [, x1, x2, y1, y2] of svg.matchAll(/<line\b[^>]*x1="([^"]+)" x2="([^"]+)" y1="([^"]+)" y2="([^"]+)"/g)) {
      assert.ok(Number(x1) === Number(x2) || Number(y1) === Number(y2), "No diagonal overlays")
      if (Number(y1) === Number(y2) && Math.abs(Number(x2) - Number(x1)) > 60) {
        assert.equal(Number(y1), 736, "Only the bottom time axis may span the plot horizontally")
      }
    }
  })
}

test("default overview and 48-hour detail end at the same asOf and last candle", () => {
  const { report, coin } = fixture()
  const overview = buildPatternChartData(report, coin)
  const detail = buildPatternChartData(report, coin, { hours: 48 })
  assert.equal(overview.points.length, 168)
  assert.deepEqual(detail.points, overview.points.slice(-48))
  assert.equal(detail.asOf, overview.asOf)
  assert.equal(detail.closedAt, overview.closedAt)
  assert.equal(detail.price, overview.price)
  assert.equal(buildPatternChartSvg(report, coin), buildPatternChartSvg(report, coin, { hours: 168 }))
})

test("the common helper excludes OI by default and retains opt-in OI coverage and warnings", () => {
  const { report, coin } = fixture()
  coin.history.openInterest = coin.history.volume.map(point => ({ ...point }))
  coin.history.openInterest[10].value = null
  const neutral = buildHourlyChartData(report, coin)
  assert.deepEqual(neutral.coverage, { candles: 168, volume: 168 })
  assert.deepEqual(neutral.warnings, [])
  assert.ok(neutral.points.every(point => !("openInterest" in point)))
  const withInterest = buildHourlyChartData(report, coin, { includeInterest: true })
  assert.deepEqual(withInterest.coverage, { candles: 168, volume: 168, openInterest: 167 })
  assert.equal(withInterest.points[0].openInterest, 0)
  assert.equal(withInterest.points[10].openInterest, null)
  assert.deepEqual(withInterest.warnings, ["Есть пропуски; недостающие значения не восстановлены."])
})

test("candles use black wicks, hollow up bodies, filled down bodies and explicit doji", () => {
  const { report, coin } = fixture()
  coin.history.candles[2].close = coin.history.candles[2].open
  const svg = buildPatternChartSvg(report, coin)
  const groups = [...svg.matchAll(/<g class="candle" data-time="(\d+)">([\s\S]*?)<\/g>/g)]
  assert.equal(groups.length, 168)
  for (const [index, [, , content]] of groups.entries()) {
    assert.match(content, /<line class="wick"[^>]*stroke="#000"/)
    const candle = coin.history.candles[index]
    if (candle.open === candle.close) {
      assert.match(content, /<line class="doji"[^>]*stroke="#000" stroke-width="1\.5"/)
      assert.doesNotMatch(content, /<rect\b/)
    } else {
      assert.match(content, candle.close > candle.open ? /fill="#fff" stroke="#000"/ : /fill="#000" stroke="#000"/)
    }
  }
  assertHourlyBars(svg, buildPatternChartData(report, coin))
})

test("missing OI, forecasts, ranks, sentiment and agent blocks cannot change the machine chart", () => {
  const { report, coin } = fixture()
  const expected = buildPatternChartSvg(report, coin)
  Object.assign(report, { objective: "P(рост > 2.5 ATR в следующие 4–12 часов)", demo: true })
  Object.assign(coin, {
    topRank: 1, movementProbability: 0.99, estimateConfidence: "high",
    socialSignificant: true, socialSentiment: "bullish",
    features: { relVolume: 12, coingeckoTrending: true },
    agentAnalysis: "БЛОК АГЕНТА", forecast: "ПРОГНОЗ РОСТА",
  })
  coin.history.openInterest = []
  const svg = buildPatternChartSvg(report, coin)
  assert.equal(svg, expected)
  assert.doesNotMatch(svg, /OPEN INTEREST|\bOI\b|oi-panel|oi-line|вероятност|оценк|уверенност|прогноз|рейтинг|ТОП|АГЕНТ|ФОН|TRENDING|ATR|ДЕМО|Нет данных|%/i)
  assert.deepEqual(buildPatternChartData(report, coin).warnings, [])
})

test("pattern rendering never reads OI or fields belonging to Telegram assessments", () => {
  const { report, coin } = fixture()
  const expected = buildPatternChartSvg(report, coin)
  for (const [object, keys] of [
    [report, ["objective", "demo", "reportCreatedAt"]],
    [coin, ["topRank", "movementProbability", "estimateConfidence", "features", "socialSignificant", "socialSentiment"]],
    [coin.history, ["openInterest"]],
  ]) {
    for (const key of keys) {
      Object.defineProperty(object, key, { get: () => assert.fail(`Pattern chart must not read ${key}`) })
    }
  }
  assert.equal(buildPatternChartSvg(report, coin), expected)
})

test("a 72-hour history keeps 96 empty earlier hours instead of stretching observations", () => {
  const { report, coin } = fixture()
  coin.history.candles = coin.history.candles.slice(-72)
  coin.history.volume = coin.history.volume.slice(-72)
  const data = buildPatternChartData(report, coin)
  assert.equal(data.points.length, 168)
  assert.ok(data.points.slice(0, 96).every(point => point.candle === null && point.volume === null))
  assert.equal(data.points[96].time, coin.history.candles[0].time)
  assert.deepEqual(data.coverage, { candles: 72, volume: 72 })
  const svg = buildPatternChartSvg(report, coin)
  assertSvg(svg)
  assertHourlyBars(svg, data)
  assert.match(visibleText(svg), /price 72\/168 · volume 72\/168 · gaps preserved · warnings 1/)
  assert.deepEqual(metadata(svg).warnings, ["Есть пропуски; недостающие значения не восстановлены."])
  assert.doesNotMatch(svg, /oi-panel|OPEN INTEREST|Нет данных/)
})

test("48-hour detail computes coverage against its own window, not against 168 hours", () => {
  const { report, coin } = fixture()
  coin.history.candles = coin.history.candles.slice(-48)
  coin.history.volume = coin.history.volume.slice(-48)
  const data = buildPatternChartData(report, coin, { hours: 48 })
  assert.deepEqual(data.coverage, { candles: 48, volume: 48 })
  assert.deepEqual(data.warnings, [])
  const svg = buildPatternChartSvg(report, coin, { hours: 48 })
  assertSvg(svg)
  assertHourlyBars(svg, data)
  assert.doesNotMatch(visibleText(svg), /warnings|gaps preserved|\/168/)
  assert.deepEqual(buildPatternChartData(report, coin).coverage, { candles: 48, volume: 48 })
  assert.match(visibleText(buildPatternChartSvg(report, coin)), /price 48\/168 · volume 48\/168 · gaps preserved/)
})

for (const hours of [168, 48]) {
  test(`${hours}-hour independent price/volume gaps keep exact positions and independent coverage`, () => {
    const { report, coin } = fixture()
    const times = coin.history.candles.slice(-hours).map(point => point.time)
    coin.history.candles = coin.history.candles.filter(point => ![times[1], times[2], times.at(-2)].includes(point.time))
    coin.history.volume = coin.history.volume.filter(point => ![times[3], times[4]].includes(point.time))
    const data = buildPatternChartData(report, coin, { hours })
    assert.deepEqual(data.coverage, { candles: hours - 3, volume: hours - 2 })
    assert.equal(data.points[1].candle, null)
    assert.ok(isFinite(data.points[1].volume))
    assert.equal(data.points[3].volume, null)
    assert.ok(data.points[3].candle)
    const svg = buildPatternChartSvg(report, coin, { hours })
    assertSvg(svg)
    assertHourlyBars(svg, data)
    assert.ok(visibleText(svg).includes(`price ${hours - 3}/${hours} · volume ${hours - 2}/${hours} · gaps preserved`))
    assert.doesNotMatch(svg, /<path\b/)
  })
}

test("invalid OHLC, volume and non-hourly timestamps become gaps, not interpolated samples", () => {
  const { report, coin } = fixture()
  coin.history.candles[5].close = NaN
  coin.history.candles[6].high = coin.history.candles[6].low
  coin.history.candles[7].open = 0
  coin.history.candles[8].time += 60
  coin.history.volume[3].value = null
  coin.history.volume[5].value = -1
  coin.history.volume[7].value = "700"
  coin.history.volume[9].time += 0.5
  for (const time of [null, NaN, Infinity, String(coin.history.candles.at(-1).time)]) {
    coin.history.candles.push({ time, open: 900, high: 1_000, low: 800, close: 950 })
    coin.history.volume.push({ time, value: 999_999 })
  }
  const data = buildPatternChartData(report, coin)
  assert.deepEqual(data.coverage, { candles: 164, volume: 164 })
  assert.ok([5, 6, 7, 8].every(index => data.points[index].candle === null))
  assert.ok([3, 5, 7, 9].every(index => data.points[index].volume === null))
  const svg = buildPatternChartSvg(report, coin)
  assertSvg(svg)
  assertHourlyBars(svg, data)
  assert.match(visibleText(svg), /price 164\/168 · volume 164\/168 · gaps preserved/)
})

for (const lastCandle of ["missing", "invalid"]) {
  test(`a ${lastCandle} last candle does not fall back to an earlier close`, () => {
    const { report, coin } = fixture()
    if (lastCandle === "missing") {
      coin.history.candles.pop()
    } else {
      coin.history.candles.at(-1).close = null
    }
    for (const hours of [168, 48]) {
      const data = buildPatternChartData(report, coin, { hours })
      assert.equal(data.price, null)
      assert.equal(data.coverage.candles, hours - 1)
      const svg = buildPatternChartSvg(report, coin, { hours })
      assertSvg(svg)
      assertHourlyBars(svg, data)
      assert.ok(metadata(svg).warnings.includes("Цена на срезе недоступна."))
      assert.doesNotMatch(svg, /stroke-dasharray=/)
    }
  })
}

for (const series of ["candles", "volume"]) {
  test(`an empty ${series} series reports actual coverage without empty panels or unrelated OI warnings`, () => {
    const { report, coin } = fixture()
    coin.history[series] = []
    const data = buildPatternChartData(report, coin)
    assert.deepEqual(data.coverage, { candles: series === "candles" ? 0 : 168, volume: series === "volume" ? 0 : 168 })
    const svg = buildPatternChartSvg(report, coin)
    assertSvg(svg)
    assertHourlyBars(svg, data)
    assert.ok(visibleText(svg).includes(`${series === "candles" ? "price" : "volume"} 0/168`))
    assert.match(visibleText(svg), /gaps preserved/)
    assert.doesNotMatch(svg, /OPEN INTEREST|oi-panel|Нет данных/)
  })
}

for (const [label, history] of [
  ["absent", undefined], ["null", null], ["empty", { candles: [], volume: [] }], ["non-array", { candles: {}, volume: "missing" }],
]) {
  test(`${label} history keeps an explicitly empty weekly grid with compact coverage`, () => {
    const { report, coin } = fixture()
    coin.history = history
    const data = buildPatternChartData(report, coin)
    assert.equal(data.points.length, 168)
    assert.deepEqual(data.coverage, { candles: 0, volume: 0 })
    const svg = buildPatternChartSvg(report, coin)
    assertSvg(svg)
    assert.match(visibleText(svg), /price 0\/168 · volume 0\/168 · gaps preserved · warnings 2/)
    assert.deepEqual(metadata(svg).coverage, { candles: 0, volume: 0 })
    assert.doesNotMatch(svg, /class="(?:candle|volume-bar)"|oi-panel|OPEN INTEREST|Нет данных/)
  })
}

test("zero volume is a covered observation, not missing data", () => {
  const { report, coin } = fixture()
  coin.history.volume = coin.history.volume.map(({ time }) => ({ time, value: 0 }))
  const data = buildPatternChartData(report, coin)
  assert.deepEqual(data.coverage, { candles: 168, volume: 168 })
  assert.deepEqual(data.warnings, [])
  const svg = buildPatternChartSvg(report, coin)
  assertSvg(svg)
  assertHourlyBars(svg, data)
  assert.ok(volumeBars(svg).every(bar => bar.height === 0))
  assert.doesNotMatch(visibleText(svg), /warnings|gaps preserved|Нет данных/)
})

for (const close of [100, 0.0000123456, 0.0000000123456]) {
  test(`flat candles at ${close} retain explicit doji and readable nonzero price ticks`, () => {
    const { report, coin } = fixture()
    coin.history.candles = coin.history.candles.map(({ time }) => ({ time, open: close, high: close, low: close, close }))
    const svg = buildPatternChartSvg(report, coin)
    assertSvg(svg)
    assertHourlyBars(svg, buildPatternChartData(report, coin))
    assert.equal([...svg.matchAll(/<line class="doji"/g)].length, 168)
    assert.doesNotMatch(svg, /<rect class="body"/)
    const axis = svg.match(/<g id="price-axis">([\s\S]*?)<\/g>/)[1]
    const ticks = [...axis.matchAll(/<text\b[^>]*>([^<]+)<\/text>/g)].map(([, value]) => Number(value))
    assert.ok(ticks.length >= 2)
    assert.ok(ticks.every(value => isFinite(value) && value > 0))
  })
}

for (const hours of [168, 48]) {
  test(`old data and candles opening at closedAt or later never affect the ${hours}-hour SVG`, () => {
    const { report, coin } = fixture()
    const expected = buildPatternChartSvg(report, coin, { hours })
    const data = buildPatternChartData(report, coin, { hours })
    const extended = structuredClone(coin)
    for (const time of [data.asOf - hours * 3_600, data.closedAt, data.closedAt + 3_600]) {
      extended.history.candles.push({ time, open: 900_000, high: 999_999, low: 800_000, close: 950_000 })
      extended.history.volume.push({ time, value: 999_999_999 })
    }
    extended.history.candles.reverse()
    extended.history.volume.reverse()
    assert.deepEqual(buildPatternChartData(report, extended, { hours }), { ...data, coin: extended })
    assert.equal(buildPatternChartSvg(report, extended, { hours }), expected)
  })
}

test("data, SVG and PNG are deterministic and do not mutate frozen inputs", () => {
  const { report, coin } = fixture()
  coin.history.candles.at(-3).close = NaN
  coin.history.volume.splice(160, 1)
  coin.history.candles.reverse()
  coin.history.volume.reverse()
  coin.history.warning = "История неполная & требует проверки"
  const before = structuredClone({ report, coin })
  deepFreeze(report)
  deepFreeze(coin)
  for (const hours of [168, 48]) {
    const data = buildPatternChartData(report, coin, { hours })
    const svg = buildPatternChartSvg(report, coin, { hours })
    assertSvg(svg)
    assertHourlyBars(svg, data)
    assert.deepEqual(buildPatternChartData(report, coin, { hours }), data)
    assert.equal(buildPatternChartSvg(report, coin, { hours }), svg)
    assert.deepEqual(renderSvgPng(svg), renderSvgPng(svg))
  }
  assert.deepEqual({ report, coin }, before)
})

test("source warnings are compactly signalled and untrusted names/warnings stay escaped inside metadata", () => {
  const { report, coin } = fixture()
  coin.symbol = "</title><script>1</script>"
  coin.name = "<image href='x' onload='1'/>"
  coin.marketSymbol = "MARKET:<unsafe>&\"'"
  coin.history.warning = "Источник требует проверки & </desc><script>2</script>\u0000\u0008"
  assert.deepEqual(buildPatternChartData(report, coin).coverage, { candles: 168, volume: 168 })
  const svg = buildPatternChartSvg(report, coin)
  assertSvg(svg)
  assert.equal(metadata(svg).symbol, coin.symbol)
  assert.equal(metadata(svg).name, coin.name)
  assert.equal(metadata(svg).marketSymbol, coin.marketSymbol)
  assert.deepEqual(metadata(svg).warnings, [coin.history.warning])
  assert.match(svg, /MARKET:&lt;unsafe&gt;&amp;&quot;&apos;/)
  assert.match(visibleText(svg), /warnings 1/)
  assert.doesNotMatch(visibleText(svg), /MARKET|script|image|Источник|gaps preserved|168\/168/)
  assert.equal([...svg.matchAll(/<title>/g)].length, 1)
  assert.equal([...svg.matchAll(/<desc>/g)].length, 1)
  assert.doesNotMatch(svg, /<\/?(?:script|image|foreignObject)\b|<[^>]*\s(?:on\w+|(?:xlink:)?href)\s*=/i)
  assert.ok(!svg.includes("\u0000") && !svg.includes("\u0008"))
})

test("non-hourly or misaligned report cutoffs are rejected instead of shifted", () => {
  const { report, coin } = fixture()
  for (const patch of [
    { timeframe: "15m" }, { asOf: "invalid" }, { asOf: "2026-09-30T23:30:00.000Z" }, { asOf: "2026-09-30T23:00:00.500Z" },
  ]) {
    assert.throws(() => buildHourlyChartData({ ...report, ...patch }, coin), /closed hourly report/)
    assert.throws(() => buildPatternChartData({ ...report, ...patch }, coin), /closed hourly report/)
    assert.throws(() => buildPatternChartSvg({ ...report, ...patch }, coin), /closed hourly report/)
  }
})

test("pattern windows accept only 168 or 48 hours and common windows require a positive integer", () => {
  const { report, coin } = fixture()
  for (const hours of [0, -1, 1.5, "48", null, NaN, Infinity]) {
    assert.throws(() => buildHourlyChartData(report, coin, { hours }), /positive integer/)
  }
  for (const hours of [0, 24, 72, 48.5, "48", null, NaN, Infinity]) {
    assert.throws(() => buildPatternChartData(report, coin, { hours }), /168 or 48/)
    assert.throws(() => buildPatternChartSvg(report, coin, { hours }), /168 or 48/)
  }
})

for (const hours of [168, 48]) {
  for (const observations of [hours, 24, 0]) {
    test(`shared PNG rendering handles ${observations} observations in a ${hours}-hour machine chart`, () => {
      const { report, coin } = fixture()
      coin.history.candles = observations ? coin.history.candles.slice(-observations) : []
      coin.history.volume = observations ? coin.history.volume.slice(-observations) : []
      const svg = buildPatternChartSvg(report, coin, { hours })
      const png = renderSvgPng(svg)
      assert.ok(Buffer.isBuffer(png))
      assert.deepEqual(png.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      assert.equal(png.toString("ascii", 12, 16), "IHDR")
      assert.equal(png.readUInt32BE(16), 1400)
      assert.equal(png.readUInt32BE(20), 800)
      assert.ok(png.includes(Buffer.from("IDAT")))
      assert.equal(png.toString("ascii", png.length - 8, png.length - 4), "IEND")
      assert.deepEqual(renderSvgPng(svg), png)
      const renamed = buildPatternChartSvg(report, { ...coin, symbol: "ДРУГАЯ", name: "Другое имя", marketSymbol: "OTHER:PAIR" }, { hours })
      assert.notEqual(renamed, svg)
      assert.deepEqual(renderSvgPng(renamed), png, "Identity belongs only to metadata, not to the raster")
    })
  }
}
