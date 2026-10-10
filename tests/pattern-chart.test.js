import assert from "node:assert/strict"
import test from "node:test"

import { isArray, isFinite, isObject } from "../src/helpers/utils.typed.js"
import { buildPatternChartData } from "../src/reports/coin-card/build-coin-card-data.js"
import { buildPatternChartSvg, renderCoinCardPng } from "../src/reports/coin-card/render-coin-card.js"

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

function candleBars (svg) {
  return [...svg.matchAll(/<g class="candle" data-time="(\d+)"[^>]*>\s*<line x1="([^"]+)"[^>]*\/>\s*<rect x="([^"]+)"[^>]*width="([^"]+)"/g)]
    .map(([, time, center, x, width]) => ({ time: Number(time), center: Number(center), x: Number(x), width: Number(width) }))
}

function volumeBars (svg) {
  return [...svg.matchAll(/<rect class="volume-bar" x="([^"]+)"[^>]*width="([^"]+)" height="([^"]+)" fill="([^"]+)"/g)]
    .map(([, x, width, height, color]) => ({ x: Number(x), width: Number(width), height: Number(height), color }))
}

function assertSvg (svg) {
  assert.match(svg, /^<svg\b[^>]*width="1200"[^>]*height="1280"[^>]*viewBox="0 0 1200 1280"/)
  assert.doesNotMatch(svg, /NaN|Infinity/)
  for (const [, name, value] of svg.matchAll(/\b(x|y|x1|x2|y1|y2|width|height|stroke-width|font-size|opacity)="([^"]*)"/g)) {
    assert.ok(value !== "" && isFinite(Number(value)), `Non-finite ${name}=${value}`)
  }
}

function assertHourlyBars (svg, data) {
  const candles = candleBars(svg)
  assert.deepEqual(candles.map(candle => candle.time), data.points.filter(point => point.candle).map(point => point.time))
  for (const [bars, points] of [
    [candles, data.points.filter(point => point.candle)],
    [volumeBars(svg), data.points.filter(point => point.volume !== null)],
  ]) {
    assert.equal(bars.length, points.length)
    for (const [index, bar] of bars.entries()) {
      const center = 76 + ((points[index].time - data.points[0].time) / 3_600 + 0.5) * 936 / 168
      assert.ok(Math.abs(bar.width - 936 / 168 * 0.6) < 1e-9, "Gaps must not widen hourly bars")
      assert.ok(Math.abs(bar.x + bar.width / 2 - center) < 1e-9, "Bars must stay centered on the same hourly grid")
      if (index > 0) {
        assert.ok(bars[index - 1].x + bars[index - 1].width < bar.x, "Bars must not overlap")
      }
    }
  }
  for (const candle of candles) {
    assert.ok(Math.abs(candle.center - candle.x - candle.width / 2) < 1e-9, "Candle bodies and wicks must share their center")
  }
}

function deepFreeze (value) {
  if (isArray(value) || isObject(value)) {
    Object.values(value).forEach(deepFreeze)
    Object.freeze(value)
  }
  return value
}

test("neutral data uses exactly 168 closed hourly observations with no OI or derived assessments", () => {
  const { report, coin } = fixture()
  const data = buildPatternChartData(report, coin)
  assert.equal(data.asOf, Date.parse(report.asOf) / 1_000)
  assert.equal(data.closedAt, Date.parse("2026-10-01T00:00:00.000Z") / 1_000)
  assert.equal(data.points.length, 168)
  assert.equal(data.points[0].time, Date.parse("2026-09-24T00:00:00.000Z") / 1_000)
  assert.equal(data.points.at(-1).time, data.asOf)
  assert.equal(data.closedAt - data.points[0].time, 168 * 3_600)
  assert.deepEqual(data.points, coin.history.candles.map((candle, index) => ({
    time: candle.time, candle, volume: coin.history.volume[index].value,
  })))
  assert.deepEqual(data.coverage, { candles: 168, volume: 168 })
  assert.equal(data.price, coin.history.candles.at(-1).close)
  assert.deepEqual(data.warnings, [])
  for (const key of ["growthObjective", "change4hPct", "change24hPct", "oiChange4hPct", "relativeVolume"]) {
    assert.equal(data[key], undefined, key)
  }
})

test("the weekly SVG identifies the full market, candle OPEN and CLOSE in UTC and shares the time axis", () => {
  const { report, coin } = fixture()
  coin.marketSymbol = "BINANCE:VERYLONGEXACTMARKETIDENTIFIERUSDT.P"
  report.reportCreatedAt = "2035-01-01T12:34:56.000Z"
  const data = buildPatternChartData(report, coin)
  const svg = buildPatternChartSvg(report, coin)
  assertSvg(svg)
  assert.match(svg, /НЕДЕЛЬНЫЙ ГРАФИК · 1ч/)
  assert.match(svg, /<title>Недельный график · ТЕСТ · BINANCE:VERYLONGEXACTMARKETIDENTIFIERUSDT\.P · 1h · asOf 2026-09-30T23:00:00\.000Z<\/title>/)
  assert.match(svg, /<text x="48" y="189"[^>]*>BINANCE:VERYLONGEXACTMARKETIDENTIFIERUSDT\.P<\/text>/)
  assert.match(svg, /Открытие · 30\.09\.2026, 23:00/)
  assert.match(svg, /Закрытие · 01\.10\.2026, 00:00/)
  assert.match(svg, /Окно: 24\.09\.2026, 00:00 — 01\.10\.2026, 00:00 UTC · 168 ч/)
  assert.match(svg, /Окно: 7 дней · начало свечей на оси · UTC/)
  assert.doesNotMatch(svg, /2035-01-01|01\.01\.2035|МСК|USDT · 1ч|Нет данных|пропуски|неполные/i)
  assert.equal([...svg.matchAll(/168\/168 ч/g)].length, 2)
  assert.match(svg, /<g id="price-panel">\s*<rect[^>]*y="236"[^>]*height="740"/)
  assertHourlyBars(svg, data)
  const priceGrid = [...svg.matchAll(/<line x1="([^"]+)" x2="[^"]+" y1="296" y2="952"/g)].map(([, x]) => Number(x))
  const volumeGrid = [...svg.matchAll(/<line x1="([^"]+)" x2="[^"]+" y1="1046" y2="1144"/g)].map(([, x]) => Number(x))
  assert.ok(priceGrid.length > 0)
  assert.deepEqual(volumeGrid, priceGrid)
})

test("missing OI and added forecasts, ranks, sentiment and agent blocks cannot change the neutral SVG", () => {
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

test("neutral rendering never reads OI or fields belonging to Telegram assessments", () => {
  const { report, coin } = fixture()
  const expected = buildPatternChartSvg(report, coin)
  for (const [object, keys] of [
    [report, ["objective", "demo", "reportCreatedAt"]],
    [coin, ["topRank", "movementProbability", "estimateConfidence", "features", "socialSignificant", "socialSentiment"]],
    [coin.history, ["openInterest"]],
  ]) {
    for (const key of keys) {
      Object.defineProperty(object, key, { get: () => assert.fail(`Neutral chart must not read ${key}`) })
    }
  }
  assert.equal(buildPatternChartSvg(report, coin), expected)
})

test("a 72-hour history keeps 96 empty earlier hours instead of stretching the observations", () => {
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
  assert.equal([...svg.matchAll(/72\/168 ч/g)].length, 2)
  assert.match(svg, /Есть пропуски; недостающие значения не восстановлены\./)
  assert.doesNotMatch(svg, /oi-panel|OPEN INTEREST|Нет данных/)
})

test("independent candle and volume gaps retain exact hourly positions and independent coverage", () => {
  const { report, coin } = fixture()
  coin.history.candles = coin.history.candles.filter((_, index) => ![1, 2, 80, 81, 166].includes(index))
  coin.history.volume = coin.history.volume.filter((_, index) => ![3, 4, 90, 91].includes(index))
  const data = buildPatternChartData(report, coin)
  assert.deepEqual(data.coverage, { candles: 163, volume: 164 })
  assert.equal(data.points[1].candle, null)
  assert.equal(data.points[1].volume, 100)
  assert.equal(data.points[3].volume, null)
  assert.ok(data.points[3].candle)
  const svg = buildPatternChartSvg(report, coin)
  assertSvg(svg)
  assertHourlyBars(svg, data)
  assert.match(svg, /163\/168 ч/)
  assert.match(svg, /164\/168 ч/)
  assert.equal(volumeBars(svg)[1].color, "#92a3bc", "Volume without a candle must not invent a direction")
  assert.doesNotMatch(svg, /<path\b/)
})

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
  assert.match(svg, /Есть пропуски/)
})

for (const lastCandle of ["missing", "invalid"]) {
  test(`a ${lastCandle} last candle does not fall back to an earlier close`, () => {
    const { report, coin } = fixture()
    if (lastCandle === "missing") {
      coin.history.candles.pop()
    } else {
      coin.history.candles.at(-1).close = null
    }
    const data = buildPatternChartData(report, coin)
    assert.equal(data.price, null)
    assert.equal(data.coverage.candles, 167)
    const svg = buildPatternChartSvg(report, coin)
    assertSvg(svg)
    assertHourlyBars(svg, data)
    assert.match(svg, /Цена на срезе недоступна\./)
    assert.doesNotMatch(svg, /stroke-dasharray=/)
  })
}

for (const series of ["candles", "volume"]) {
  test(`an empty ${series} series warns only about actual missing price or volume data`, () => {
    const { report, coin } = fixture()
    coin.history[series] = []
    const data = buildPatternChartData(report, coin)
    assert.deepEqual(data.coverage, { candles: series === "candles" ? 0 : 168, volume: series === "volume" ? 0 : 168 })
    const svg = buildPatternChartSvg(report, coin)
    assertSvg(svg)
    assertHourlyBars(svg, data)
    assert.equal([...svg.matchAll(/Нет данных на этом интервале/g)].length, 1)
    assert.equal([...svg.matchAll(/0\/168 ч/g)].length, 1)
    assert.match(svg, /Есть пропуски/)
    assert.doesNotMatch(svg, /OPEN INTEREST|oi-panel/)
  })
}

for (const [label, history] of [
  ["absent", undefined], ["null", null], ["empty", { candles: [], volume: [] }], ["non-array", { candles: {}, volume: "missing" }],
]) {
  test(`${label} history renders two explicitly empty panels on the weekly grid`, () => {
    const { report, coin } = fixture()
    coin.history = history
    const data = buildPatternChartData(report, coin)
    assert.equal(data.points.length, 168)
    assert.deepEqual(data.coverage, { candles: 0, volume: 0 })
    const svg = buildPatternChartSvg(report, coin)
    assertSvg(svg)
    assert.equal([...svg.matchAll(/Нет данных на этом интервале/g)].length, 2)
    assert.equal([...svg.matchAll(/0\/168 ч/g)].length, 2)
    assert.doesNotMatch(svg, /class="(?:candle|volume-bar)"|oi-panel|OPEN INTEREST/)
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
  assert.doesNotMatch(svg, /Нет данных|Есть пропуски/)
})

test("old data and candles opening at closedAt or later never affect the weekly SVG", () => {
  const { report, coin } = fixture()
  const expected = buildPatternChartSvg(report, coin)
  const data = buildPatternChartData(report, coin)
  const extended = structuredClone(coin)
  for (const time of [data.asOf - 168 * 3_600, data.closedAt, data.closedAt + 3_600]) {
    extended.history.candles.push({ time, open: 900_000, high: 999_999, low: 800_000, close: 950_000 })
    extended.history.volume.push({ time, value: 999_999_999 })
  }
  extended.history.candles.reverse()
  extended.history.volume.reverse()
  assert.deepEqual(buildPatternChartData(report, extended), { ...data, coin: extended })
  assert.equal(buildPatternChartSvg(report, extended), expected)
})

test("neutral data and SVG are deterministic and do not mutate frozen inputs", () => {
  const { report, coin } = fixture()
  coin.history.candles[5].close = NaN
  coin.history.volume.splice(8, 1)
  coin.history.candles.reverse()
  coin.history.volume.reverse()
  coin.history.warning = "История неполная & требует проверки"
  const before = structuredClone({ report, coin })
  deepFreeze(report)
  deepFreeze(coin)
  const data = buildPatternChartData(report, coin)
  const svg = buildPatternChartSvg(report, coin)
  assertSvg(svg)
  assertHourlyBars(svg, data)
  assert.deepEqual(buildPatternChartData(report, coin), data)
  assert.equal(buildPatternChartSvg(report, coin), svg)
  assert.deepEqual(renderCoinCardPng(svg), renderCoinCardPng(svg))
  assert.deepEqual({ report, coin }, before)
})

test("history warnings remain visible even with full coverage, and untrusted metadata stays escaped XML", () => {
  const { report, coin } = fixture()
  coin.symbol = "</title><script>1</script>"
  coin.name = "<image href='x' onload='1'/>"
  coin.marketSymbol = "MARKET:<unsafe>&\"'"
  coin.history.warning = "Источник требует проверки & </desc><script>2</script>\u0000\u0008"
  assert.deepEqual(buildPatternChartData(report, coin).coverage, { candles: 168, volume: 168 })
  const svg = buildPatternChartSvg(report, coin)
  assertSvg(svg)
  assert.match(svg, /Источник требует проверки &amp;/)
  assert.match(svg, /MARKET:&lt;unsafe&gt;&amp;&quot;&apos;/)
  assert.match(svg, /&lt;image href=&apos;x&apos; onload=&apos;1&apos;\//)
  assert.match(svg, /<text x="48" y="1258"[^>]*>Источник требует проверки/)
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
    assert.throws(() => buildPatternChartData({ ...report, ...patch }, coin), /closed hourly report/)
    assert.throws(() => buildPatternChartSvg({ ...report, ...patch }, coin), /closed hourly report/)
  }
})

for (const hours of [168, 72, 0]) {
  test(`the existing PNG renderer rasterizes a deterministic ${hours}-hour neutral chart`, () => {
    const { report, coin } = fixture()
    coin.history.candles = hours ? coin.history.candles.slice(-hours) : []
    coin.history.volume = hours ? coin.history.volume.slice(-hours) : []
    const svg = buildPatternChartSvg(report, coin)
    const png = renderCoinCardPng(svg)
    assert.ok(Buffer.isBuffer(png))
    assert.deepEqual(png.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    assert.equal(png.toString("ascii", 12, 16), "IHDR")
    assert.equal(png.readUInt32BE(16), 1200)
    assert.equal(png.readUInt32BE(20), 1280)
    assert.ok(png.includes(Buffer.from("IDAT")))
    assert.equal(png.toString("ascii", png.length - 8, png.length - 4), "IEND")
    assert.deepEqual(renderCoinCardPng(svg), png)
    assert.notDeepEqual(renderCoinCardPng(svg.replaceAll("ТЕСТ", "ДРУГАЯ")), png)
  })
}
