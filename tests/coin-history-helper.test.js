import assert from "node:assert/strict"
import path from "node:path"
import test from "node:test"

import { buildCoinHistory, readCoinHistory } from "../src/helpers/coin-history-helper.js"

function createInput () {
  const coin = { symbol: "COTI", baseCurrencyId: "XTVCCOTI", marketSymbol: "BINANCE:COTIUSDT.P" }
  const asOfTimestamp = Date.parse("2026-09-15T09:00:00.000Z") / 1_000
  const periods = Array.from({ length: 168 }, (_, index) => ({
    time: asOfTimestamp - (167 - index) * 3_600,
    open: 100 + index,
    max: 102 + index,
    min: 99 + index,
    close: 101 + index,
    volume: 1_000 + index,
  }))

  return {
    coin,
    asOfTimestamp,
    data: {
      coin: { ...coin },
      timeframe: "1h",
      chart: { info: { fullName: coin.marketSymbol }, periods },
      studies: { openInterest: { periods: periods.map(({ time }, index) => ({ time, close: 10_000 + index })) } },
    },
  }
}

test("includes OI by default and preserves the weekly history without mutating data", () => {
  const { data, coin, asOfTimestamp } = createInput()
  const before = structuredClone(data)
  const history = buildCoinHistory(data, coin, asOfTimestamp)

  assert.deepEqual(history, {
    candles: data.chart.periods.map(({ time, open, max, min, close }) => ({ time, open, high: max, low: min, close })),
    volume: data.chart.periods.map(({ time, volume }) => ({ time, value: volume })),
    openInterest: data.studies.openInterest.periods.map(({ time, close }) => ({ time, value: close })),
    warning: null,
  })
  assert.deepEqual(buildCoinHistory(data, coin, asOfTimestamp, { includeOpenInterest: true }), history)
  assert.deepEqual(data, before)
})

test("disabled OI is omitted and causes no warnings for missing or malformed studies", () => {
  const { data, coin, asOfTimestamp } = createInput()
  const baseline = buildCoinHistory(data, coin, asOfTimestamp)

  for (const studies of [
    undefined,
    null,
    {},
    { openInterest: { periods: null } },
    { openInterest: { periods: [
      { time: "invalid", close: 123 },
      { time: asOfTimestamp - 60, close: 123 },
      { time: asOfTimestamp, close: -1 },
    ] } },
  ]) {
    data.studies = studies

    assert.deepEqual(buildCoinHistory(data, coin, asOfTimestamp, { includeOpenInterest: false }), {
      candles: baseline.candles,
      volume: baseline.volume,
      warning: null,
    })
    assert.match(buildCoinHistory(data, coin, asOfTimestamp).warning, /Open Interest/)
  }
})

test("disabled OI never accesses studies, openInterest or periods getters", async (t) => {
  for (const fields of [["studies"], ["studies", "openInterest"], ["studies", "openInterest", "periods"]]) {
    await t.test(fields.join("."), async () => {
      const { data, coin, asOfTimestamp } = createInput()
      const target = fields.slice(0, -1).reduce((value, field) => value[field], data)
      Object.defineProperty(target, fields.at(-1), {
        get () {
          throw new Error("OI must not be read")
        },
      })

      const history = buildCoinHistory(data, coin, asOfTimestamp, { includeOpenInterest: false })
      assert.deepEqual(Object.keys(history), ["candles", "volume", "warning"])
      assert.equal(history.candles.length, 168)
      assert.equal(history.volume.length, 168)
      assert.equal(history.warning, null)
      assert.deepEqual(await readCoinHistory(coin, asOfTimestamp, {
        readCoinData: async () => data,
        includeOpenInterest: false,
      }), history)
      assert.throws(() => buildCoinHistory(data, coin, asOfTimestamp), /OI must not be read/)
    })
  }
})

test("disabled OI keeps the 168-hour window, sorts, deduplicates and excludes future candles", () => {
  const { data, coin, asOfTimestamp } = createInput()
  const original = structuredClone(data.chart.periods)
  const duplicate = { ...original[12], open: 20, max: 22, min: 19, close: 21, volume: 432 }
  data.chart.periods = [
    { ...original[0], time: original[0].time - 3_600, close: null },
    ...original.toReversed(),
    { ...original.at(-1), time: asOfTimestamp + 3_600, close: null },
    { ...original[15], time: original[15].time + 60 },
    { ...original[15], time: "invalid" },
    duplicate,
  ]
  const before = structuredClone(data)
  const history = buildCoinHistory(data, coin, asOfTimestamp, { includeOpenInterest: false })
  const times = original.map(period => period.time)

  assert.deepEqual(history.candles.map(candle => candle.time), times)
  assert.deepEqual(history.volume.map(point => point.time), times)
  assert.equal(history.candles[0].time, asOfTimestamp - 167 * 3_600)
  assert.equal(history.candles.at(-1).time, asOfTimestamp)
  assert.deepEqual(history.candles[12], { time: duplicate.time, open: 20, high: 22, low: 19, close: 21 })
  assert.deepEqual(history.volume[12], { time: duplicate.time, value: 432 })
  assert.equal(Object.hasOwn(history, "openInterest"), false)
  assert.match(history.warning, /дубликаты/)
  assert.match(history.warning, /часовой сетки/)
  assert.match(history.warning, /отметки времени/)
  assert.doesNotMatch(history.warning, /Open Interest|Неполная неделя|OHLC/)
  assert.deepEqual(data, before)
})

test("disabled OI retains candle and volume warnings without filling or extending gaps", () => {
  const { data, coin, asOfTimestamp } = createInput()
  const original = structuredClone(data.chart.periods)
  data.chart.periods[0].volume = 0
  data.chart.periods[1].min = 1_000
  data.chart.periods[2].time += 60
  data.chart.periods[3] = null
  data.chart.periods[10].volume = -1
  data.chart.periods.splice(4, 1)
  data.chart.periods.unshift({ ...original[0], time: original[0].time - 3_600 })
  const history = buildCoinHistory(data, coin, asOfTimestamp, { includeOpenInterest: false })
  const omittedTimes = original.slice(1, 5).map(period => period.time)
  const times = original.map(period => period.time).filter(time => !omittedTimes.includes(time))

  assert.deepEqual(history.candles.map(candle => candle.time), times)
  assert.deepEqual(history.volume.map(point => point.time), times)
  assert.deepEqual(history.volume[0], { time: original[0].time, value: 0 })
  assert.deepEqual(history.volume.find(point => point.time === original[10].time), { time: original[10].time })
  assert.match(history.warning, /164 из 168/)
  assert.match(history.warning, /OHLC/)
  assert.match(history.warning, /часовой сетки/)
  assert.match(history.warning, /отметки времени/)
  assert.match(history.warning, /Объём/)
  assert.doesNotMatch(history.warning, /Open Interest/)
})

test("disabled OI accepts a short current history without filling gaps", () => {
  const { data, coin, asOfTimestamp } = createInput()
  data.chart.periods = data.chart.periods.slice(-3)
  const history = buildCoinHistory(data, coin, asOfTimestamp, { includeOpenInterest: false })

  assert.equal(history.candles.length, 3)
  assert.equal(history.volume.length, 3)
  assert.equal(history.candles.at(-1).time, asOfTimestamp)
  assert.equal(history.warning, "Неполная неделя: 3 из 168 часовых свечей, пропуски не заполнены")
})

test("disabled OI still requires valid OHLC at the last closed hour's opening timestamp", async (t) => {
  for (const [name, change] of [
    ["missing asOf", (data) => {
      data.chart.periods.pop()
    }],
    ["future cannot replace asOf", (data) => {
      data.chart.periods.at(-1).time += 3_600
    }],
    ["invalid asOf OHLC", (data) => {
      data.chart.periods.at(-1).close = null
    }],
    ["last duplicate overrides valid asOf", (data) => {
      data.chart.periods.push({ ...data.chart.periods.at(-1), max: 1 })
    }],
  ]) {
    await t.test(name, async () => {
      const { data, coin, asOfTimestamp } = createInput()
      change(data)

      assert.throws(() => buildCoinHistory(data, coin, asOfTimestamp, { includeOpenInterest: false }), /на asOf/)
      assert.deepEqual(await readCoinHistory(coin, asOfTimestamp, {
        readCoinData: async () => data,
        includeOpenInterest: false,
      }), {
        candles: [],
        volume: [],
        warning: "История недоступна: нет корректной свечи на asOf: история устарела или неполна",
      })
    })
  }
})

test("disabled OI preserves metadata, timeframe and chart validation", async (t) => {
  for (const [name, change, message] of [
    ["wrong symbol", data => data.coin.symbol = "OTHER", /не совпадают/],
    ["wrong base currency", data => data.coin.baseCurrencyId = "OTHER", /не совпадают/],
    ["wrong market", data => data.coin.marketSymbol = "OTHER:COTIUSD", /не совпадают/],
    ["wrong chart market", data => data.chart.info.fullName = "OTHER:COTIUSD", /не совпадают/],
    ["wrong timeframe", data => data.timeframe = "4h", /интервал 1h/],
    ["missing chart", data => delete data.chart, /свечи отсутствуют/],
    ["empty chart", data => data.chart.periods = [], /свечи отсутствуют/],
  ]) {
    await t.test(name, () => {
      const { data, coin, asOfTimestamp } = createInput()
      change(data)
      assert.throws(() => buildCoinHistory(data, coin, asOfTimestamp, { includeOpenInterest: false }), message)
    })
  }
})

test("readCoinHistory uses the bootstrap path and forwards the OI option", async () => {
  const { data, coin, asOfTimestamp } = createInput()

  for (const options of [{}, { includeOpenInterest: false }]) {
    const requestedPaths = []
    const history = await readCoinHistory(coin, asOfTimestamp, {
      ...options,
      readCoinData: async (relativePath) => {
        requestedPaths.push(relativePath)
        return data
      },
    })

    assert.deepEqual(requestedPaths, [path.join("step2-data-bootstrap", "COTI--XTVCCOTI", "data.json")])
    assert.deepEqual(history, buildCoinHistory(data, coin, asOfTimestamp, options))
  }
})

test("readCoinHistory catches failures with empty arrays and omits OI only when disabled", async (t) => {
  const { coin, asOfTimestamp } = createInput()

  for (const includeOpenInterest of [true, false]) {
    for (const [name, readCoinData, message] of [
      ["read failure", async () => {
        throw new Error("ENOENT: missing data.json")
      }, "ENOENT: missing data.json"],
      ["parse failure", () => {
        throw new SyntaxError("Invalid JSON")
      }, "Invalid JSON"],
      ["non-Error failure", async () => {
        throw null
      }, "не удалось прочитать данные"],
      ["missing data", async () => undefined, "монета или рынок в истории не совпадают с кандидатом"],
    ]) {
      await t.test(`${name}, OI ${includeOpenInterest}`, async () => {
        assert.deepEqual(await readCoinHistory(coin, asOfTimestamp, { readCoinData, includeOpenInterest }), {
          candles: [],
          volume: [],
          ...(includeOpenInterest ? { openInterest: [] } : {}),
          warning: `История недоступна: ${message}`,
        })
      })
    }
  }
})
