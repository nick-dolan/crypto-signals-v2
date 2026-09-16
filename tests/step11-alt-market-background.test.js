import assert from "node:assert/strict"
import test from "node:test"

import { buildAltMarketBackground } from "../src/steps/step11-report/build-alt-market-background.js"

function createInput (closes = [100, 125, 90, 115, 110]) {
  const snapshot = { asOf: "2026-09-16T08:00:00.000Z", breadth4h: 0.6 }
  const asOfTimestamp = Date.parse(snapshot.asOf) / 1_000
  const marketData = {
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
  }

  return { snapshot, marketData }
}

async function build (input, readMarketData = async () => input.marketData) {
  const calls = []
  const result = await buildAltMarketBackground(input.snapshot, {
    readMarketData: async (...args) => {
      calls.push(args)
      return readMarketData(...args)
    },
  })

  assert.deepEqual(calls, [["step3-market-context.json"]])
  return result
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
    await t.test(`${change}% with breadth ${breadth4h}`, async () => {
      const input = createInput([100, 125, 90, 115, 100 + change])
      input.snapshot.breadth4h = breadth4h

      assert.deepEqual(await build(input), { status, change4hPct: change, breadth4h, warning: null })
    })
  }
})

test("does not round small changes or rescale breadth before classification", async (t) => {
  for (const [lastClose, breadth4h, status] of [
    [100 + 1e-10, 0.55 + Number.EPSILON, "up"],
    [100 - 1e-10, 0.45 - Number.EPSILON, "down"],
  ]) {
    await t.test(status, async () => {
      const input = createInput([100, 125, 90, 115, lastClose])
      input.snapshot.breadth4h = breadth4h
      const result = await build(input)

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

test("uses the exact four-hour offset, not four candles or the last saved row", async () => {
  const input = createInput([100, 200, 190, 180, 150])
  const periods = input.marketData.series.total3es.periods
  input.marketData.collectedAt = "2099-01-01T00:00:00.000Z"
  input.marketData.series.total3es.periods = [
    { time: periods[0].time - 3_600, close: 1 },
    ...periods.toReversed(),
    { time: periods[4].time + 3_600, close: 1_000 },
  ]

  assert.deepEqual(await build(input), { status: "up", change4hPct: 50, breadth4h: 0.6, warning: null })
})

test("ignores invalid closes, duplicates and off-grid times strictly outside the required interval", async () => {
  const input = createInput()
  const periods = input.marketData.series.total3es.periods
  periods.push(
    { time: periods[0].time - 1, close: null },
    { time: periods[0].time - 1, close: "invalid" },
    { time: periods[4].time + 0.5, close: NaN },
    { time: periods[4].time + 3_600, close: -1 },
    { time: periods[4].time + 3_600, close: Infinity },
  )

  assert.deepEqual(await build(input), { status: "up", change4hPct: 10, breadth4h: 0.6, warning: null })
})

test("requires only TOTAL3ES closes, not unrelated OHLC fields, series or requestedHours", async () => {
  const input = createInput()
  delete input.marketData.requestedHours
  input.marketData.series.total = { symbol: "CRYPTOCAP:TOTAL", periods: [] }
  input.marketData.series.total3es.periods = input.marketData.series.total3es.periods.map(({ time, close }) => ({ time, close }))

  assert.deepEqual(await build(input), { status: "up", change4hPct: 10, breadth4h: 0.6, warning: null })
})

test("invalid breadth stays null without hiding a known valid change", async (t) => {
  for (const breadth4h of [undefined, null, "0.6", "", NaN, Infinity, -Infinity, -0.01, 1.01, 60, true, false, [], {}, Object(0.6)]) {
    await t.test(String(breadth4h), async () => {
      const input = createInput()
      input.snapshot.breadth4h = breadth4h
      const result = await build(input)

      assert.deepEqual({ ...result, warning: null }, {
        status: "unavailable", change4hPct: 10, breadth4h: null, warning: null,
      })
      assert.match(result.warning, /Ширина рынка.*от 0 до 1/)
    })
  }
})

test("rejects invalid and non-hourly report snapshots rather than rounding or substituting the time", async (t) => {
  for (const asOf of [
    undefined, null, "", "invalid", 1_789_545_600, NaN, Infinity, new Date("2026-09-16T08:00:00Z"),
    "2026-09-16T08:01:00.000Z", "2026-09-16T08:00:00.001Z",
  ]) {
    await t.test(String(asOf), async () => {
      const input = createInput()
      input.snapshot.asOf = asOf
      assertMissingChange(await build(input), /asOf.*начало часовой свечи/)
    })
  }
})

test("accepts equivalent ISO timestamps and collection exactly at the close boundary", async () => {
  const input = createInput()
  input.snapshot.asOf = "2026-09-16T11:00:00+03:00"
  input.marketData.collectedAt = "2026-09-16T12:00:00+03:00"

  assert.deepEqual(await build(input), { status: "up", change4hPct: 10, breadth4h: 0.6, warning: null })
})

test("rejects any missing, duplicate or shifted required hour, including duplicate replacement", async (t) => {
  for (let index = 0; index < 5; index += 1) {
    for (const kind of ["missing", "duplicate", "replacement", "off-grid"]) {
      await t.test(`${kind} at hour ${index}`, async () => {
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

        assertMissingChange(await build(input), /5 часовых свечей.*пропусков, дубликатов и сдвигов/)
      })
    }
  }
})

test("rejects extra off-grid or unidentifiable rows inside an otherwise complete window", async (t) => {
  for (const time of [undefined, null, "1789545600", NaN, Infinity, -Infinity, "bad-time", 1_789_545_599.5]) {
    await t.test(String(time), async () => {
      const input = createInput()
      input.marketData.series.total3es.periods.push({ time, close: 100 })
      assertMissingChange(await build(input), /5 часовых свечей/)
    })
  }
})

test("requires finite positive native numeric closes at all five hours", async (t) => {
  for (const close of [undefined, null, "100", 0, -1, NaN, Infinity, -Infinity, true, [], {}, Object(100)]) {
    for (let index = 0; index < 5; index += 1) {
      await t.test(`${String(close)} at hour ${index}`, async () => {
        const input = createInput()
        input.marketData.series.total3es.periods[index].close = close
        assertMissingChange(await build(input), /цены закрытия.*конечными положительными числами/)
      })
    }
  }
})

test("rejects an overflowing percentage even when both endpoint closes are positive and finite", async () => {
  const input = createInput([Number.MIN_VALUE, 1, 1, 1, Number.MAX_VALUE])
  assertMissingChange(await build(input), /не удалось вычислить конечное изменение/)
})

test("missing or corrupt saved context, series and periods remain unavailable", async (t) => {
  for (const marketData of [undefined, null, {}, [], "invalid", 42]) {
    await t.test(`context ${String(marketData)}`, async () => {
      const input = createInput()
      input.marketData = marketData
      assertMissingChange(await build(input), /tradingview.*1h.*CRYPTOCAP:TOTAL3ES/)
    })
  }

  for (const series of [undefined, null, {}, { total3es: null }]) {
    await t.test(`series ${JSON.stringify(series)}`, async () => {
      const input = createInput()
      input.marketData.series = series
      assertMissingChange(await build(input), /CRYPTOCAP:TOTAL3ES/)
    })
  }

  for (const periods of [undefined, null, {}, "invalid", [], [null]]) {
    await t.test(`periods ${JSON.stringify(periods)}`, async () => {
      const input = createInput()
      input.marketData.series.total3es.periods = periods
      assertMissingChange(await build(input), /часов/)
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
      await t.test(`${key}: ${String(value)}`, async () => {
        const input = createInput()
        const target = key === "symbol" ? input.marketData.series.total3es : input.marketData
        target[key] = value
        assertMissingChange(await build(input), /tradingview.*1h.*CRYPTOCAP:TOTAL3ES/)
      })
    }
  }
})

test("does not substitute the nearest available window when saved candles are older or newer", async (t) => {
  for (const offset of [-3_600, 3_600]) {
    await t.test(`offset ${offset}`, async () => {
      const input = createInput()
      input.marketData.collectedAt = "2026-09-17T09:00:00.000Z"
      input.marketData.series.total3es.periods.forEach(period => period.time += offset)
      assertMissingChange(await build(input), /5 часовых свечей/)
    })
  }
})

test("invalid collection timestamps cannot certify a closed snapshot", async (t) => {
  for (const collectedAt of [undefined, null, "", "invalid", "1789545600", 1_789_545_600, NaN, Infinity, new Date()]) {
    await t.test(String(collectedAt), async () => {
      const input = createInput()
      input.marketData.collectedAt = collectedAt
      assertMissingChange(await build(input), /некорректное время сбора collectedAt/)
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
    await t.test(collectedAt, async () => {
      const input = createInput()
      input.marketData.collectedAt = collectedAt
      assertMissingChange(await build(input), /устарел.*не закрылась.*collectedAt/)
    })
  }
})

test("file and JSON read failures do not escape or discard valid breadth", async (t) => {
  for (const [name, readMarketData, warning] of [
    ["missing file", async () => {
      throw Object.assign(new Error("ENOENT: tmp/step3-market-context.json"), { code: "ENOENT" })
    }, /ENOENT.*step3-market-context.json/],
    ["invalid JSON", async () => JSON.parse("{invalid"), /JSON/],
    ["unknown failure", async () => Promise.reject(null), /не удалось прочитать step3-market-context.json/],
  ]) {
    await t.test(name, async () => {
      assertMissingChange(await build(createInput(), readMarketData), warning)
    })
  }
})

test("reports both missing metrics when invalid breadth accompanies a read failure", async () => {
  const input = createInput()
  input.snapshot.breadth4h = null
  const result = await build(input, async () => {
    throw new Error("ENOENT")
  })

  assert.deepEqual({ ...result, warning: null }, {
    status: "unavailable", change4hPct: null, breadth4h: null, warning: null,
  })
  assert.match(result.warning, /Ширина рынка.*TOTAL3ES недоступен.*ENOENT/)
})

test("does not mutate report inputs, saved metadata, candle order or values", async () => {
  const input = createInput()
  const periods = input.marketData.series.total3es.periods
  periods.reverse()
  const before = structuredClone(input)
  Object.freeze(input.snapshot)
  periods.forEach(Object.freeze)
  Object.freeze(periods)
  Object.freeze(input.marketData.series.total3es)
  Object.freeze(input.marketData.series)
  Object.freeze(input.marketData)
  Object.freeze(input)

  assert.deepEqual(await build(input), { status: "up", change4hPct: 10, breadth4h: 0.6, warning: null })
  assert.deepEqual(input, before)
})
