import assert from "node:assert/strict"
import test from "node:test"

import { buildAltMarketBackground } from "../src/steps/step4-feature-metrics/build-alt-market-background.js"

function createInput (closes = [100, 125, 90, 115, 110]) {
  const asOf = "2026-09-16T08:00:00.000Z"
  const asOfTimestamp = Date.parse(asOf) / 1_000

  return {
    asOf,
    breadth4h: 0.6,
    marketData: {
      source: "tradingview",
      timeframe: "1h",
      collectedAt: "2026-09-16T09:37:00.000Z",
      requestedHours: 2_400,
      series: {
        total3es: {
          symbol: "CRYPTOCAP:TOTAL3ES",
          periods: closes.map((close, index) => ({
            time: asOfTimestamp - (4 - index) * 3_600,
            open: 100,
            max: 200,
            min: 80,
            close,
          })),
        },
      },
    },
  }
}

function assertMissingChange (result, warning) {
  assert.deepEqual({ ...result, warning: null }, {
    status: "unavailable",
    change4hPct: null,
    breadth4h: 0.6,
    warning: null,
  })
  assert.match(result.warning, /TOTAL3ES недоступен/)
  assert.match(result.warning, warning)
}

test("classifies both directions, strict 55/45 thresholds, conflicts, flat prices and breadth endpoints", async (t) => {
  for (const [change, breadth4h, status] of [
    [10, 0.6, "up"],
    [-10, 0.4, "down"],
    [10, 0.55, "mixed"],
    [-10, 0.45, "mixed"],
    [10, 0.55 + Number.EPSILON, "up"],
    [10, 0.55 - Number.EPSILON, "mixed"],
    [-10, 0.45 - Number.EPSILON, "down"],
    [-10, 0.45 + Number.EPSILON, "mixed"],
    [10, 0.45, "mixed"],
    [-10, 0.55, "mixed"],
    [10, 0.4, "mixed"],
    [-10, 0.6, "mixed"],
    [10, 0.5, "mixed"],
    [-10, 0.5, "mixed"],
    [0, 0.6, "mixed"],
    [0, 0.4, "mixed"],
    [0, 0, "mixed"],
    [0, 1, "mixed"],
    [10, 1, "up"],
    [-10, 0, "down"],
    [10, 0, "mixed"],
    [-10, 1, "mixed"],
  ]) {
    await t.test(`${change}% with breadth ${breadth4h}`, () => {
      const input = createInput([100, 125, 90, 115, 100 + change])
      input.breadth4h = breadth4h

      assert.deepEqual(buildAltMarketBackground(input), { status, change4hPct: change, breadth4h, warning: null })
    })
  }
})

test("does not round small changes or rescale breadth before classification", async (t) => {
  for (const [lastClose, breadth4h, status] of [
    [100 + 1e-10, 0.55 + Number.EPSILON, "up"],
    [100 - 1e-10, 0.45 - Number.EPSILON, "down"],
  ]) {
    await t.test(status, () => {
      const input = createInput([100, 125, 90, 115, lastClose])
      input.breadth4h = breadth4h
      const result = buildAltMarketBackground(input)

      assert.deepEqual(result, {
        status,
        change4hPct: (lastClose - 100) / 100 * 100,
        breadth4h,
        warning: null,
      })
      assert.notEqual(result.change4hPct, 0)
      assert.ok(Math.abs(result.change4hPct) < 1e-6)
    })
  }
})

test("uses the exact four-hour offset, not four candles or the last saved row", () => {
  const input = createInput([100, 200, 190, 180, 150])
  const periods = input.marketData.series.total3es.periods
  input.marketData.collectedAt = "2099-01-01T00:00:00.000Z"
  input.marketData.series.total3es.periods = [
    { time: periods[0].time - 3_600, close: 1 },
    ...periods.toReversed(),
    { time: periods[4].time + 3_600, close: 1_000 },
  ]

  assert.deepEqual(buildAltMarketBackground(input), { status: "up", change4hPct: 50, breadth4h: 0.6, warning: null })
})

test("ignores invalid closes, duplicates and off-grid times strictly outside the required interval", () => {
  const input = createInput()
  const periods = input.marketData.series.total3es.periods
  periods.push(
    { time: periods[0].time - 1, close: null },
    { time: periods[0].time - 1, close: "invalid" },
    { time: periods[4].time + 0.5, close: NaN },
    { time: periods[4].time + 3_600, close: -1 },
    { time: periods[4].time + 3_600, close: Infinity },
  )

  assert.deepEqual(buildAltMarketBackground(input), { status: "up", change4hPct: 10, breadth4h: 0.6, warning: null })
})

test("requires only TOTAL3ES closes, not unrelated OHLC fields, series or requestedHours", () => {
  const input = createInput()
  delete input.marketData.requestedHours
  input.marketData.series.total = { symbol: "CRYPTOCAP:TOTAL", periods: [] }
  input.marketData.series.total3es.periods = input.marketData.series.total3es.periods.map(({ time, close }) => ({ time, close }))

  assert.deepEqual(buildAltMarketBackground(input), { status: "up", change4hPct: 10, breadth4h: 0.6, warning: null })
})

test("invalid breadth stays null without hiding a known valid change", async (t) => {
  for (const breadth4h of [undefined, null, "0.6", "", NaN, Infinity, -Infinity, -0.01, 1.01, 60, true, false, [], {}, Object(0.6)]) {
    await t.test(String(breadth4h), () => {
      const input = createInput()
      input.breadth4h = breadth4h
      const result = buildAltMarketBackground(input)

      assert.deepEqual({ ...result, warning: null }, {
        status: "unavailable", change4hPct: 10, breadth4h: null, warning: null,
      })
      assert.match(result.warning, /Ширина рынка.*от 0 до 1/)
    })
  }
})

test("rejects invalid and non-hourly snapshots rather than rounding or substituting the time", async (t) => {
  for (const asOf of [
    undefined, null, "", "invalid", 1_789_545_600, NaN, Infinity, new Date("2026-09-16T08:00:00Z"),
    "2026-09-16T08:01:00.000Z", "2026-09-16T08:00:00.001Z",
  ]) {
    await t.test(String(asOf), () => {
      const input = createInput()
      input.asOf = asOf
      assertMissingChange(buildAltMarketBackground(input), /asOf.*начало часовой свечи/)
    })
  }
})

test("accepts equivalent ISO timestamps and collection exactly at the close boundary", () => {
  const input = createInput()
  input.asOf = "2026-09-16T11:00:00+03:00"
  input.marketData.collectedAt = "2026-09-16T12:00:00+03:00"

  assert.deepEqual(buildAltMarketBackground(input), { status: "up", change4hPct: 10, breadth4h: 0.6, warning: null })
})

test("rejects any missing, duplicate or shifted required hour, including duplicate replacement", async (t) => {
  for (let index = 0; index < 5; index += 1) {
    for (const kind of ["missing", "duplicate", "replacement", "off-grid"]) {
      await t.test(`${kind} at hour ${index}`, () => {
        const input = createInput()
        const periods = input.marketData.series.total3es.periods

        if (kind === "missing") {
          periods.splice(index, 1)
        } else if (kind === "duplicate") {
          periods.push({ ...periods[index] })
        } else if (kind === "replacement") {
          periods[index] = { ...periods[(index + 1) % 5] }
        } else {
          periods[index].time += index === 4 ? -1 : 1
        }

        assertMissingChange(buildAltMarketBackground(input), /5 часовых свечей.*пропусков, дубликатов и сдвигов/)
      })
    }
  }
})

test("rejects extra off-grid or unidentifiable rows inside an otherwise complete window", async (t) => {
  for (const time of [undefined, null, "1789545600", NaN, Infinity, -Infinity, "bad-time", 1_789_545_599.5]) {
    await t.test(String(time), () => {
      const input = createInput()
      input.marketData.series.total3es.periods.push({ time, close: 100 })
      assertMissingChange(buildAltMarketBackground(input), /5 часовых свечей/)
    })
  }
})

test("requires finite positive native numeric closes at all five hours", async (t) => {
  for (const close of [undefined, null, "100", 0, -1, NaN, Infinity, -Infinity, true, [], {}, Object(100)]) {
    for (let index = 0; index < 5; index += 1) {
      await t.test(`${String(close)} at hour ${index}`, () => {
        const input = createInput()
        input.marketData.series.total3es.periods[index].close = close
        assertMissingChange(buildAltMarketBackground(input), /цены закрытия.*конечными положительными числами/)
      })
    }
  }
})

test("rejects an overflowing percentage even when both endpoint closes are positive and finite", () => {
  const input = createInput([Number.MIN_VALUE, 1, 1, 1, Number.MAX_VALUE])
  assertMissingChange(buildAltMarketBackground(input), /не удалось вычислить конечное изменение/)
})

test("missing or corrupt market context, series and periods remain unavailable", async (t) => {
  for (const marketData of [undefined, null, {}, [], "invalid", 42]) {
    await t.test(`context ${String(marketData)}`, () => {
      const input = createInput()
      input.marketData = marketData
      assertMissingChange(buildAltMarketBackground(input), /tradingview.*1h.*CRYPTOCAP:TOTAL3ES/)
    })
  }

  for (const series of [undefined, null, {}, { total3es: null }]) {
    await t.test(`series ${JSON.stringify(series)}`, () => {
      const input = createInput()
      input.marketData.series = series
      assertMissingChange(buildAltMarketBackground(input), /CRYPTOCAP:TOTAL3ES/)
    })
  }

  for (const periods of [undefined, null, {}, "invalid", [], [null]]) {
    await t.test(`periods ${JSON.stringify(periods)}`, () => {
      const input = createInput()
      input.marketData.series.total3es.periods = periods
      assertMissingChange(buildAltMarketBackground(input), /часов/)
    })
  }
})

test("rejects wrong or missing source, timeframe and symbol without using another series", async (t) => {
  for (const [key, values] of [
    ["source", [undefined, null, "other"]],
    ["timeframe", [undefined, null, "4h", "60", 60]],
    ["symbol", [undefined, null, "CRYPTOCAP:TOTAL3", "CRYPTOCAP:TOTAL2ES"]],
  ]) {
    for (const value of values) {
      await t.test(`${key}: ${String(value)}`, () => {
        const input = createInput()
        const target = key === "symbol" ? input.marketData.series.total3es : input.marketData
        target[key] = value
        assertMissingChange(buildAltMarketBackground(input), /tradingview.*1h.*CRYPTOCAP:TOTAL3ES/)
      })
    }
  }
})

test("does not substitute the nearest available window when saved candles are older or newer", async (t) => {
  for (const offset of [-3_600, 3_600]) {
    await t.test(`offset ${offset}`, () => {
      const input = createInput()
      input.marketData.collectedAt = "2026-09-17T09:00:00.000Z"
      input.marketData.series.total3es.periods.forEach(period => period.time += offset)
      assertMissingChange(buildAltMarketBackground(input), /5 часовых свечей/)
    })
  }
})

test("invalid collection timestamps cannot certify a closed snapshot", async (t) => {
  for (const collectedAt of [undefined, null, "", "invalid", "1789545600", 1_789_545_600, NaN, Infinity, new Date("2026-09-16T09:00:00Z")]) {
    await t.test(String(collectedAt), () => {
      const input = createInput()
      input.marketData.collectedAt = collectedAt
      assertMissingChange(buildAltMarketBackground(input), /некорректное время сбора collectedAt/)
    })
  }
})

test("rejects stale collection and a forming asOf bar, even one millisecond before its close", async (t) => {
  for (const collectedAt of [
    "2026-09-16T07:59:59.999Z",
    "2026-09-16T08:00:00.000Z",
    "2026-09-16T08:30:00.000Z",
    "2026-09-16T08:59:59.999Z",
  ]) {
    await t.test(collectedAt, () => {
      const input = createInput()
      input.marketData.collectedAt = collectedAt
      assertMissingChange(buildAltMarketBackground(input), /устарел.*не закрылась.*collectedAt/)
    })
  }
})

test("reports both missing metrics when invalid breadth accompanies missing market data", () => {
  const input = createInput()
  input.breadth4h = null
  input.marketData = null
  const result = buildAltMarketBackground(input)

  assert.deepEqual({ ...result, warning: null }, {
    status: "unavailable", change4hPct: null, breadth4h: null, warning: null,
  })
  assert.match(result.warning, /Ширина рынка.*TOTAL3ES недоступен.*CRYPTOCAP:TOTAL3ES/)
})

test("returns a synchronous, deterministic result without mutating inputs, candle order or values", () => {
  const input = createInput()
  const periods = input.marketData.series.total3es.periods
  periods.reverse()
  const before = structuredClone(input)
  periods.forEach(Object.freeze)
  Object.freeze(periods)
  Object.freeze(input.marketData.series.total3es)
  Object.freeze(input.marketData.series)
  Object.freeze(input.marketData)
  Object.freeze(input)
  const result = buildAltMarketBackground(input)

  assert.deepEqual(result, { status: "up", change4hPct: 10, breadth4h: 0.6, warning: null })
  assert.deepEqual(buildAltMarketBackground(input), result)
  assert.deepEqual(input, before)
})
