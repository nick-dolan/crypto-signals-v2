import assert from "node:assert/strict"
import test from "node:test"
import { fileURLToPath } from "node:url"
import { inflateSync } from "node:zlib"
import { Resvg } from "@resvg/resvg-js"

import { isArray, isFinite, isObject, isString } from "../src/helpers/utils.typed.js"
import { buildCoinCardData } from "../src/reports/coin-card/build-coin-card-data.js"
import { buildCoinCardSvg, renderCoinCardPng } from "../src/reports/coin-card/render-coin-card.js"

function fixture () {
  const report = {
    asOf: "2026-09-30T23:00:00.000Z", timeframe: "1h", demo: true,
    reportCreatedAt: "2026-10-01T06:15:00.000Z",
  }
  const asOf = Date.parse(report.asOf) / 1_000
  const candles = Array.from({ length: 168 }, (_, index) => {
    const close = ({ 143: 200, 163: 120, 167: 150 })[index] ?? 100 + index
    return { time: asOf - (167 - index) * 3_600, open: close - 1, high: close + 2, low: close - 2, close }
  })
  const coin = {
    symbol: "ТЕСТ", name: "Синтетическая монета", marketSymbol: "SYNTH:TESTUSDT",
    topRank: 3, movementProbability: 0.75, estimateConfidence: "high",
    features: { relVolume: 2.5, coingeckoTrending: true },
    history: {
      candles,
      volume: candles.map(({ time }, index) => ({ time, value: 1_000 + index })),
      openInterest: candles.map(({ time }, index) => ({ time, value: ({ 163: 1_000, 167: 750 })[index] ?? 500 + index })),
    },
  }
  return { report, coin }
}

function textAfter (svg, label) {
  const texts = [...svg.matchAll(/<text\b[^>]*>([^<]*)<\/text>/g)].map(([, text]) => text)
  const index = texts.indexOf(label)
  assert.notEqual(index, -1, `Missing label: ${label}`)
  return texts[index + 1]
}

function assertSvg (svg) {
  assert.ok(isString(svg))
  const root = svg.match(/^<svg\b[^>]*>/)?.[0]
  assert.ok(root, "Expected an SVG root")
  assert.match(root, /\bwidth="1200"/)
  assert.match(root, /\bheight="1280"/)
  assert.match(root, /\bviewBox="0 0 1200 1280"/)
  assert.doesNotMatch(svg, /NaN|Infinity/)
  for (const [, name, value] of svg.matchAll(/\b(x|y|x1|x2|y1|y2|cx|cy|r|rx|width|height|stroke-width|font-size|opacity)="([^"]*)"/g)) {
    assert.ok(value !== "" && isFinite(Number(value)), `Non-finite ${name}=${value}`)
  }
}

function assertHourlyBars (svg, data) {
  const candles = [...svg.matchAll(/<g class="candle" data-time="(\d+)"[^>]*>\s*<line x1="([^"]+)" x2="([^"]+)"[^>]*\/>\s*<rect x="([^"]+)"[^>]*width="([^"]+)"/g)]
    .map(([, time, x1, x2, x, width]) => {
      assert.equal(Number(x1), Number(x2), "Candle wicks must be vertical")
      return { time: Number(time), center: Number(x1), x: Number(x), width: Number(width) }
    })
  const volume = [...svg.matchAll(/<rect class="volume-bar" x="([^"]+)"[^>]*width="([^"]+)"/g)]
    .map(([, x, width]) => ({ x: Number(x), width: Number(width) }))
  const candlePoints = data.points.filter(point => point.candle)
  assert.deepEqual(candles.map(candle => candle.time), candlePoints.map(point => point.time))

  for (const [rectangles, points] of [
    [candles, candlePoints],
    [volume, data.points.filter(point => point.volume !== null)],
  ]) {
    assert.equal(rectangles.length, points.length)
    for (const [index, rectangle] of rectangles.entries()) {
      const center = 76 + ((points[index].time - data.points[0].time) / 3_600 + 0.5) * 936 / 168
      assert.ok(rectangle.width > 0 && rectangle.width < 936 / 168, "Bars must be narrower than one hour")
      assert.ok(Math.abs(rectangle.x + rectangle.width / 2 - center) < 1e-9, "Bars must stay centered on their hour")
      if (index > 0) {
        assert.ok(rectangles[index - 1].x + rectangles[index - 1].width < rectangle.x, "Adjacent bars must not overlap")
      }
    }
  }
  for (const candle of candles) {
    assert.ok(Math.abs(candle.center - candle.x - candle.width / 2) < 1e-9, "Candle bodies must be centered on their wicks")
  }
}

function assertPng (png, width, height) {
  assert.ok(Buffer.isBuffer(png))
  assert.deepEqual(png.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  assert.equal(png.readUInt32BE(8), 13)
  assert.equal(png.toString("ascii", 12, 16), "IHDR")
  assert.equal(png.readUInt32BE(16), width)
  assert.equal(png.readUInt32BE(20), height)

  const chunks = []
  const imageData = []
  let offset = 8
  while (offset < png.length) {
    const length = png.readUInt32BE(offset)
    assert.ok(offset + length + 12 <= png.length, "Truncated PNG chunk")
    const type = png.toString("ascii", offset + 4, offset + 8)
    chunks.push(type)
    if (type === "IDAT") {
      imageData.push(png.subarray(offset + 8, offset + 8 + length))
    }
    offset += length + 12
  }
  assert.equal(offset, png.length)
  assert.equal(chunks.at(-1), "IEND")
  assert.equal(png.readUInt32BE(png.length - 12), 0)
  assert.ok(imageData.length > 0, "PNG must contain raster data")
  assert.ok(inflateSync(Buffer.concat(imageData)).length > 0, "PNG raster must decompress")
}

function deepFreeze (value) {
  if (isArray(value) || isObject(value)) {
    Object.values(value).forEach(deepFreeze)
    Object.freeze(value)
  }
  return value
}

test("the seven-day coin card uses exact hourly endpoints and labels the close, not asOf or report creation", () => {
  const { report, coin } = fixture()
  const data = buildCoinCardData(report, coin)

  assert.equal(data.asOf, Date.parse("2026-09-30T23:00:00.000Z") / 1_000)
  assert.equal(data.closedAt, Date.parse("2026-10-01T00:00:00.000Z") / 1_000)
  assert.equal(data.closedAt - data.asOf, 3_600)
  assert.equal(data.demo, true)
  assert.equal(data.points.length, 168)
  assert.equal(data.points[0].time, data.asOf - 167 * 3_600)
  assert.equal(data.points[0].time, Date.parse("2026-09-24T00:00:00.000Z") / 1_000)
  assert.equal(data.points.at(-1).time, data.asOf)
  assert.equal(data.closedAt - data.points[0].time, 7 * 24 * 3_600)
  assert.deepEqual(data.points, coin.history.candles.map((candle, index) => ({
    time: candle.time, candle, volume: 1_000 + index,
    openInterest: ({ 163: 1_000, 167: 750 })[index] ?? 500 + index,
  })))
  assert.deepEqual(data.coverage, { candles: 168, volume: 168, openInterest: 168 })
  assert.equal(data.price, 150)
  assert.equal(data.change4hPct, 25)
  assert.equal(data.change24hPct, -25)
  assert.equal(data.oiChange4hPct, -25)
  assert.equal(data.relativeVolume, 2.5)
  assert.deepEqual(data.warnings, [])

  const svg = buildCoinCardSvg(report, coin)
  assertSvg(svg)
  assert.equal(textAfter(svg, "Срез закрыт · МСК (UTC+3)"), "01.10.2026, 03:00")
  assert.equal(textAfter(svg, "Цена закрытия · USDT"), "150")
  assert.equal(textAfter(svg, "Изменение · 4ч"), "+25%")
  assert.equal(textAfter(svg, "Изменение · 24ч"), "-25%")
  assert.equal(textAfter(svg, "Изменение Open Interest · 4ч"), "-25%")
  assert.equal(textAfter(svg, "Объём 1ч / норма этого часа"), "2,5×")
  for (const label of ["ЦЕНА · USDT · 1ч", "ОБЪЁМ · ТЕСТ", "OPEN INTEREST · ТЕСТ"]) {
    assert.equal(textAfter(svg, label), "168/168 ч")
  }
  assert.equal(svg.match(/<desc>([\s\S]*?)<\/desc>/)?.[1], "Цена, объём и Open Interest за 7 дней из сохранённого отчёта.")
  assert.match(svg, /Окно: 7 дней · начало свечей на оси/)
  assert.doesNotMatch(svg, /Пропуски не заполнены/)
  assertHourlyBars(svg, data)
  assert.match(svg, /ДЕМО · СИНТЕТИЧЕСКИЕ ДАННЫЕ/)
})

test("candles and indicators outside the seven-day window, including the candle opening at closedAt, never affect data or SVG", () => {
  const { report, coin } = fixture()
  const expected = buildCoinCardData(report, coin)
  const expectedSvg = buildCoinCardSvg(report, coin)
  const extended = structuredClone(coin)

  for (const time of [expected.asOf - 168 * 3_600, expected.asOf + 3_600, expected.asOf + 7_200]) {
    extended.history.candles.push({ time, open: 900_000, high: 999_999, low: 800_000, close: 950_000 })
    extended.history.volume.push({ time, value: 999_999_999 })
    extended.history.openInterest.push({ time, value: 999_999_999 })
  }
  for (const series of Object.values(extended.history)) {
    series.reverse()
  }

  assert.deepEqual(buildCoinCardData(report, extended), { ...expected, coin: extended })
  assert.equal(buildCoinCardSvg(report, extended), expectedSvg)
})

test("a saved 72-hour history retains all observations and leaves 96 earlier gaps in the seven-day grid", () => {
  const { report, coin } = fixture()
  for (const key of ["candles", "volume", "openInterest"]) {
    coin.history[key] = coin.history[key].slice(-72)
  }
  const before = structuredClone({ report, coin })
  const data = buildCoinCardData(report, coin)
  assert.equal(data.points.length, 168)
  assert.deepEqual(data.points.slice(0, 96), Array.from({ length: 96 }, (_, index) => ({
    time: data.asOf - (167 - index) * 3_600, candle: null, volume: null, openInterest: null,
  })))
  assert.deepEqual(data.points.slice(96), coin.history.candles.map((candle, index) => ({
    time: candle.time, candle,
    volume: coin.history.volume[index].value,
    openInterest: coin.history.openInterest[index].value,
  })))
  assert.deepEqual(data.coverage, { candles: 72, volume: 72, openInterest: 72 })
  for (const [key, value] of Object.entries({ price: 150, change4hPct: 25, change24hPct: -25, oiChange4hPct: -25 })) {
    assert.equal(data[key], value, key)
  }
  assert.ok(data.warnings.includes("Есть пропуски; недостающие значения не восстановлены."))
  const svg = buildCoinCardSvg(report, coin)
  assertSvg(svg)
  for (const label of ["ЦЕНА · USDT · 1ч", "ОБЪЁМ · ТЕСТ", "OPEN INTEREST · ТЕСТ"]) {
    assert.equal(textAfter(svg, label), "72/168 ч")
  }
  assert.equal([...svg.matchAll(/<circle\b/g)].length, 72)
  assertHourlyBars(svg, data)
  assert.deepEqual({ report, coin }, before)
})

test("a single missing hour marks coverage as incomplete against all 168 hours", () => {
  const { report, coin } = fixture()
  for (const key of ["candles", "volume", "openInterest"]) {
    coin.history[key].shift()
  }
  const data = buildCoinCardData(report, coin)
  assert.deepEqual(data.coverage, { candles: 167, volume: 167, openInterest: 167 })
  assert.ok(data.warnings.includes("Есть пропуски; недостающие значения не восстановлены."))
  const svg = buildCoinCardSvg(report, coin)
  assertSvg(svg)
  for (const label of ["ЦЕНА · USDT · 1ч", "ОБЪЁМ · ТЕСТ", "OPEN INTEREST · ТЕСТ"]) {
    assert.equal(textAfter(svg, label), "167/168 ч")
  }
  assert.match(svg, /Данные неполные или с оговорками\. Пропуски не заполнены\./)
})

test("candle and volume bars keep seven-day hourly widths and centers across independent gaps", () => {
  const { report, coin } = fixture()
  for (const [key, missing] of [
    ["candles", [1, 2, 80, 81, 166]],
    ["volume", [3, 4, 90, 91, 160]],
  ]) {
    coin.history[key] = coin.history[key].filter((_, index) => !missing.includes(index))
  }
  const data = buildCoinCardData(report, coin)
  assert.deepEqual(data.coverage, { candles: 163, volume: 163, openInterest: 168 })
  const svg = buildCoinCardSvg(report, coin)
  assertSvg(svg)
  assertHourlyBars(svg, data)
})

test("the 168-hour grid preserves absent hours and normalizes invalid timestamps, OHLC and indicator values", () => {
  const { report, coin } = fixture()
  const before = structuredClone(coin.history)

  for (const [offset, value] of [null, NaN, Infinity, -1, "100", undefined, true].entries()) {
    coin.history.candles[11 + offset].close = value
    coin.history.volume[11 + offset].value = value
    coin.history.openInterest[11 + offset].value = value
  }
  for (const [offset, patch] of [
    { open: 0 }, { high: 1 }, { low: 1_000 }, { open: NaN }, { high: null }, { low: Infinity },
  ].entries()) {
    Object.assign(coin.history.candles[20 + offset], patch)
  }
  for (const [key, invalidTimePoint] of [
    ["candles", { open: 900, high: 1_000, low: 800, close: 950 }],
    ["volume", { value: 999_999 }],
    ["openInterest", { value: 999_999 }],
  ]) {
    coin.history[key] = coin.history[key].filter((_, index) => index !== 10)
    coin.history[key].push(null, invalidTimePoint, ...[
      null, undefined, NaN, Infinity, String(before.candles.at(-1).time),
      before.candles.at(-1).time - 1, before.candles.at(-1).time + 0.5,
    ].map(time => ({ ...invalidTimePoint, time })))
  }

  const data = buildCoinCardData(report, coin)
  assert.equal(data.points.length, 168)
  assert.deepEqual(data.points, before.candles.map((candle, index) => ({
    time: candle.time,
    candle: (index >= 10 && index <= 17) || (index >= 20 && index <= 25) ? null : candle,
    volume: index >= 10 && index <= 17 ? null : before.volume[index].value,
    openInterest: index >= 10 && index <= 17 ? null : before.openInterest[index].value,
  })))
  assert.deepEqual(data.coverage, { candles: 154, volume: 160, openInterest: 160 })
  assert.ok(data.warnings.some(warning => warning.includes("пропуски")))
  const svg = buildCoinCardSvg(report, coin)
  assertSvg(svg)
  assert.equal(textAfter(svg, "ЦЕНА · USDT · 1ч"), "154/168 ч")
  assert.equal(textAfter(svg, "ОБЪЁМ · ТЕСТ"), "160/168 ч")
  assert.equal(textAfter(svg, "OPEN INTEREST · ТЕСТ"), "160/168 ч")
})

for (const [series, index, metric] of [
  ["candles", 163, "change4hPct"],
  ["candles", 143, "change24hPct"],
  ["openInterest", 163, "oiChange4hPct"],
  ["openInterest", 167, "oiChange4hPct"],
]) {
  test(`${metric} is unavailable when its exact ${series} endpoint at hour ${index} is absent`, () => {
    const { report, coin } = fixture()
    coin.history[series].splice(index, 1)
    const data = buildCoinCardData(report, coin)
    const expected = { price: 150, change4hPct: 25, change24hPct: -25, oiChange4hPct: -25 }
    expected[metric] = null
    for (const [key, value] of Object.entries(expected)) {
      assert.equal(data[key], value, key)
    }
  })
}

for (const lastCandle of ["missing", "invalid"]) {
  test(`a ${lastCandle} last candle never falls back to an earlier price`, () => {
    const { report, coin } = fixture()
    if (lastCandle === "missing") {
      coin.history.candles.pop()
    } else {
      coin.history.candles.at(-1).close = NaN
    }
    const data = buildCoinCardData(report, coin)
    assert.equal(data.points.at(-2).candle.close, 266)
    assert.equal(data.points.at(-1).candle, null)
    assert.equal(data.price, null)
    assert.equal(data.change4hPct, null)
    assert.equal(data.change24hPct, null)
    assert.equal(data.oiChange4hPct, -25)
    assert.equal(data.coverage.candles, 167)
    assert.ok(data.warnings.includes("Цена на срезе недоступна."))

    const svg = buildCoinCardSvg(report, coin)
    assertSvg(svg)
    assert.equal(textAfter(svg, "Цена закрытия · USDT"), "Нет данных")
    assert.equal(textAfter(svg, "Изменение · 4ч"), "Нет данных")
    assert.equal(textAfter(svg, "Изменение · 24ч"), "Нет данных")
    assert.match(svg, /Цена на срезе недоступна\. Пропуски не заполнены\./)
    assert.doesNotMatch(svg, /stroke-dasharray=/)
    assert.equal([...svg.matchAll(/class="candle"/g)].length, 167)
  })
}

test("sparse history still computes returns from available exact endpoints without filling intermediate hours", () => {
  const { report, coin } = fixture()
  for (const key of ["candles", "volume", "openInterest"]) {
    coin.history[key] = coin.history[key].filter((_, index) => [143, 163, 167].includes(index))
  }
  const data = buildCoinCardData(report, coin)
  assert.equal(data.points.length, 168)
  assert.deepEqual(data.coverage, { candles: 3, volume: 3, openInterest: 3 })
  assert.equal(data.price, 150)
  assert.equal(data.change4hPct, 25)
  assert.equal(data.change24hPct, -25)
  assert.equal(data.oiChange4hPct, -25)
  assert.deepEqual(data.points[166], { time: data.asOf - 3_600, candle: null, volume: null, openInterest: null })
  const svg = buildCoinCardSvg(report, coin)
  assertSvg(svg)
  assertHourlyBars(svg, data)
})

test("zero volume and OI are covered observations but a zero change denominator is unavailable", () => {
  const { report, coin } = fixture()
  coin.features.relVolume = 0
  for (const series of [coin.history.volume, coin.history.openInterest]) {
    series.forEach((point) => {
      point.value = 0
    })
  }
  const data = buildCoinCardData(report, coin)
  assert.deepEqual(data.coverage, { candles: 168, volume: 168, openInterest: 168 })
  assert.ok(data.points.every(point => point.volume === 0 && point.openInterest === 0))
  assert.equal(data.oiChange4hPct, null)
  assert.equal(data.relativeVolume, 0)
  assert.deepEqual(data.warnings, [])

  const svg = buildCoinCardSvg(report, coin)
  assertSvg(svg)
  assert.equal(textAfter(svg, "Объём 1ч / норма этого часа"), "0×")
  assert.equal(textAfter(svg, "Изменение Open Interest · 4ч"), "Нет данных")
  const bars = [...svg.matchAll(/<rect class="volume-bar"[^>]*height="([^"]+)"/g)]
  assert.equal(bars.length, 168)
  assert.ok(bars.every(([, height]) => Number(height) === 0))
  assert.match(svg, /id="oi-line" d="M/)
  assert.equal([...svg.matchAll(/<circle\b/g)].length, 168)
})

test("a zero current OI with a positive baseline is a real -100% change", () => {
  const { report, coin } = fixture()
  coin.history.openInterest.at(-1).value = 0
  assert.equal(buildCoinCardData(report, coin).oiChange4hPct, -100)
  const svg = buildCoinCardSvg(report, coin)
  assertSvg(svg)
  assert.equal(textAfter(svg, "Изменение Open Interest · 4ч"), "-100%")
})

test("OI paths break at absent and invalid hours, retain isolated zero observations and keep hourly x positions", () => {
  const { report, coin } = fixture()
  const original = coin.history.openInterest
  coin.history.openInterest = [0, 1, 4, 5, 9, 166, 167].map(index => ({ ...original[index], value: index === 9 ? 0 : original[index].value }))
  coin.history.openInterest.push(...[null, NaN, -1].map((value, index) => ({ time: original[6 + index].time, value })))
  const data = buildCoinCardData(report, coin)
  assert.equal(data.coverage.openInterest, 7)
  const svg = buildCoinCardSvg(report, coin)
  assertSvg(svg)
  const centers = new Map([...svg.matchAll(/<g class="candle" data-time="(\d+)"[^>]*>\s*<line x1="([^"]+)"/g)]
    .map(([, time, x]) => [Number(time), Number(x)]))
  assert.equal(centers.size, 168)
  const path = svg.match(/<path id="oi-line" d="([^"]+)"/)?.[1]
  assert.ok(path, "Expected an OI line")
  const segments = [...path.matchAll(/M[^M]*/g)].map(([segment]) =>
    [...segment.matchAll(/[ML](-?[\d.]+),(-?[\d.]+)/g)].map(([, x]) => Number(x)),
  )
  assert.equal(segments.length, 4)
  // D3 serializes path coordinates to three decimals, unlike SVG attributes.
  assert.deepEqual(segments, [[0, 1], [4, 5], [9], [166, 167]]
    .map(indices => indices.map(index => Number(centers.get(original[index].time).toFixed(3)))))
  assert.deepEqual([...svg.matchAll(/<circle cx="([^"]+)"/g)].map(([, x]) => Number(Number(x).toFixed(3))), segments.flat())
})

test("untrusted names, badges and warning metadata remain escaped XML, never script or image elements", () => {
  const { report, coin } = fixture()
  coin.symbol = "</title><script>1</script>&\"'"
  coin.name = "<image href=\"x\" onload='1'/>&"
  coin.marketSymbol = "</text><script>2</script>&\"'"
  coin.topRank = "</text><image href='x'/>&\""
  coin.history.warning = "</desc><ScRiPt>3</ScRiPt><image href='x'/>&\"'\u0000\u0008\u000b\u000c\u001f"
  const data = buildCoinCardData(report, coin)
  assert.deepEqual(data.warnings, [coin.history.warning])
  const svg = buildCoinCardSvg(report, coin)
  assertSvg(svg)
  assert.equal(svg.match(/<title>([\s\S]*?)<\/title>/)?.[1],
    "ДЕМО · &lt;/title&gt;&lt;script&gt;1&lt;/script&gt;&amp;&quot;&apos; · срез 01.10.2026, 03:00 МСК")
  assert.equal(svg.match(/<desc>([\s\S]*?)<\/desc>/)?.[1],
    "&lt;/desc&gt;&lt;ScRiPt&gt;3&lt;/ScRiPt&gt;&lt;image href=&apos;x&apos;/&gt;&amp;&quot;&apos;")
  assert.ok(svg.includes("&lt;image href=&quot;x&quot; onload=&apos;1&apos;/&gt;&amp;"))
  assert.ok(svg.includes("&lt;/text&gt;&lt;script&gt;2&lt;/script&gt;&amp;&quot;&apos;"))
  assert.ok(svg.includes("ТОП &lt;/text&gt;&lt;image href=&apos;x&apos;/&gt;&amp;&quot;"))
  assert.equal([...svg.matchAll(/<title>/g)].length, 1)
  assert.equal([...svg.matchAll(/<desc>/g)].length, 1)
  assert.doesNotMatch(svg, /<\/?(?:script|image|img|foreignObject)\b/i)
  assert.doesNotMatch(svg, /<[^>]*\s(?:on\w+|(?:xlink:)?href)\s*=/i)
  for (const code of [0, 8, 11, 12, 31]) {
    assert.ok(!svg.includes(String.fromCharCode(code)), `XML control character ${code}`)
  }
})

for (const [label, history] of [
  ["absent", undefined],
  ["null", null],
  ["empty", { candles: [], volume: [], openInterest: [] }],
  ["non-array", { candles: {}, volume: null, openInterest: "missing" }],
]) {
  test(`${label} history produces an explicit empty 168-hour SVG without non-finite values`, () => {
    const { report, coin } = fixture()
    coin.history = history
    coin.features.relVolume = Infinity
    coin.movementProbability = NaN
    const data = buildCoinCardData(report, coin)
    assert.equal(data.points.length, 168)
    assert.deepEqual(data.coverage, { candles: 0, volume: 0, openInterest: 0 })
    assert.ok(data.points.every(point => point.candle === null && point.volume === null && point.openInterest === null))
    for (const key of ["price", "change4hPct", "change24hPct", "oiChange4hPct", "relativeVolume"]) {
      assert.equal(data[key], null, key)
    }
    const svg = buildCoinCardSvg(report, coin)
    assertSvg(svg)
    assert.equal([...svg.matchAll(/Нет данных на этом интервале/g)].length, 3)
    assert.equal([...svg.matchAll(/0\/168 ч/g)].length, 3)
    assert.doesNotMatch(svg, /class="(?:candle|volume-bar)"|id="oi-line"/)
    assert.equal(textAfter(svg, "Цена закрытия · USDT"), "Нет данных")
    assert.match(svg, /Нет данных<\/text>\s*<text\b[^>]*>Сильное движение · 4–12ч/)
    assert.equal(textAfter(svg, "Объём 1ч / норма этого часа"), "Нет данных")
  })
}

test("a single observation renders finite geometry without inventing return baselines", () => {
  const { report, coin } = fixture()
  for (const key of ["candles", "volume", "openInterest"]) {
    coin.history[key] = coin.history[key].slice(-1)
  }
  const data = buildCoinCardData(report, coin)
  assert.deepEqual(data.coverage, { candles: 1, volume: 1, openInterest: 1 })
  assert.equal(data.price, 150)
  assert.equal(data.change4hPct, null)
  assert.equal(data.change24hPct, null)
  assert.equal(data.oiChange4hPct, null)
  const svg = buildCoinCardSvg(report, coin)
  assertSvg(svg)
  assert.equal([...svg.matchAll(/class="candle"/g)].length, 1)
  assert.equal([...svg.matchAll(/class="volume-bar"/g)].length, 1)
  assert.equal([...svg.matchAll(/<circle\b/g)].length, 1)
  assert.match(svg, /id="oi-line" d="M[^"]+"/)
})

for (const [close, label] of [[100, "100"], [0.0000123456, "0,0000123456"], [0.0000000123456, "1,23456E-8"]]) {
  test(`flat candles at ${close} have visible finite bodies and nonzero price labels`, () => {
    const { report, coin } = fixture()
    coin.history.candles = coin.history.candles.map(({ time }) => ({ time, open: close, high: close, low: close, close }))
    const data = buildCoinCardData(report, coin)
    assert.equal(data.price, close)
    assert.equal(data.change4hPct, 0)
    assert.equal(data.change24hPct, 0)
    const svg = buildCoinCardSvg(report, coin)
    assertSvg(svg)
    assert.equal(textAfter(svg, "Цена закрытия · USDT"), label)
    const bodies = [...svg.matchAll(/<g class="candle"[^>]*>[\s\S]*?<rect[^>]*y="([^"]+)"[^>]*height="([^"]+)"/g)]
    assert.equal(bodies.length, 168)
    for (const [, y, height] of bodies) {
      assert.ok(Number(y) >= 462 && Number(y) + Number(height) <= 708)
      assert.ok(Number(height) > 0)
    }
    assert.equal(new Set(bodies.map(([, y]) => y)).size, 1)
    const axisLabels = [...svg.matchAll(/<text x="1032" y="([^"]+)"[^>]*>([^<]+)<\/text>/g)]
      .filter(([, y]) => Number(y) >= 462 && Number(y) <= 714)
    assert.ok(axisLabels.length >= 2, "Flat price scale needs readable ticks")
    for (const [, , text] of axisLabels) {
      const value = Number(text.replace(/\s/g, "").replace(",", ".").replace("−", "-"))
      assert.ok(isFinite(value) && value > 0, `Price tick was lost: ${text}`)
    }
  })
}

test("non-hourly or misaligned report cutoffs are rejected instead of silently shifted", () => {
  const { report, coin } = fixture()
  for (const patch of [
    { timeframe: "15m" }, { asOf: "invalid" }, { asOf: "2026-09-30T23:30:00.000Z" },
    { asOf: "2026-09-30T23:00:00.500Z" },
  ]) {
    assert.throws(() => buildCoinCardData({ ...report, ...patch }, coin), /closed hourly report/)
    assert.throws(() => buildCoinCardSvg({ ...report, ...patch }, coin), /closed hourly report/)
  }
})

test("native rasterization produces a real deterministic 1200x1280 PNG for the same input", () => {
  const { report, coin } = fixture()
  const svg = buildCoinCardSvg(report, coin)
  const png = renderCoinCardPng(svg)
  assertPng(png, 1200, 1280)
  assert.equal(buildCoinCardSvg(report, structuredClone(coin)), svg)
  assert.deepEqual(renderCoinCardPng(svg), png)
  const changedSvg = buildCoinCardSvg(report, { ...coin, symbol: "ДРУГАЯ" })
  assert.notDeepEqual(renderCoinCardPng(changedSvg), png)
})

test("bundled regular and bold Noto Sans rasterize Cyrillic without system fonts", () => {
  const images = [400, 700].map((weight) => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="80" font-family="Noto Sans">
      <text x="10" y="60" font-size="48" font-weight="${weight}">ЖЩЮЯё</text>
    </svg>`
    const expected = new Resvg(svg, {
      font: {
        loadSystemFonts: false,
        defaultFontFamily: "Noto Sans",
        fontFiles: [
          fileURLToPath(new URL("../src/reports/coin-card/fonts/NotoSans-Regular.ttf", import.meta.url)),
          fileURLToPath(new URL("../src/reports/coin-card/fonts/NotoSans-Bold.ttf", import.meta.url)),
        ],
      },
    }).render().asPng()
    const withoutFonts = new Resvg(svg, { font: { loadSystemFonts: false, fontFiles: [] } }).render().asPng()
    const png = renderCoinCardPng(svg)
    assertPng(png, 300, 80)
    assert.deepEqual(png, expected)
    assert.notDeepEqual(png, withoutFonts)
    assert.notDeepEqual(png, renderCoinCardPng(svg.replace("ЖЩЮЯё", "�".repeat(5))))
    return png
  })
  assert.notDeepEqual(images[0], images[1], "Bold Cyrillic must not fall back to regular")
})

test("data building, SVG rendering and native rasterization do not mutate frozen report or coin inputs", () => {
  const { report, coin } = fixture()
  coin.history.candles[5].close = NaN
  coin.history.volume.splice(8, 1)
  coin.history.openInterest[9].value = null
  for (const series of Object.values(coin.history)) {
    series.reverse()
  }
  coin.history.warning = "Синтетические пропуски & оговорки"
  const before = structuredClone({ report, coin })
  deepFreeze(report)
  deepFreeze(coin)
  const data = buildCoinCardData(report, coin)
  const svg = buildCoinCardSvg(report, coin)
  assertSvg(svg)
  assertPng(renderCoinCardPng(svg), 1200, 1280)
  assert.deepEqual(buildCoinCardData(report, coin), data)
  assert.equal(buildCoinCardSvg(report, coin), svg)
  assert.deepEqual({ report, coin }, before)
})
