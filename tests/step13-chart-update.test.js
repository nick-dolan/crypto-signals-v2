import assert from "node:assert/strict"
import test from "node:test"
import vm from "node:vm"

import { isArray, isFinite, isSafeInteger, isString } from "../src/helpers/utils.typed.js"
import { createChartUpdater } from "../src/web/chart-update.js"

function time (hour = 0) {
  return Date.parse("2026-09-16T07:00:00.000Z") / 1_000 + hour * 3_600
}

function iso (hour = 0) {
  return new Date(time(hour) * 1_000).toISOString()
}

function createInput (asOfHour = 0) {
  const candles = [-1, 0].map(offset => ({
    time: time(asOfHour + offset), open: 1, high: 3, low: 0.5, close: 2,
  }))

  return {
    asOf: iso(asOfHour),
    coin: {
      symbol: "RAY",
      marketSymbol: "BINANCE:RAYSOLUSDT.P",
      history: {
        candles,
        volume: candles.map(({ time }) => ({ time, value: 123 })),
        openInterest: candles.map(({ time }) => ({ time, value: 456 })),
        warning: "Исходное предупреждение TV",
      },
    },
  }
}

function kline (hour, close = 101, volume = 1_000) {
  return [
    time(hour) * 1_000, "100", String(Math.max(102, close)), String(Math.min(99, close)),
    String(close), String(volume), time(hour + 1) * 1_000 - 1, "999999", 20, "1", "2", "0",
  ]
}

function oi (hour, value = 10_000 + hour) {
  return {
    symbol: "RAYSOLUSDT",
    timestamp: time(hour) * 1_000,
    sumOpenInterest: String(value),
    sumOpenInterestValue: "999999999999.99",
  }
}

function json (body, status = 200) {
  return new Response(JSON.stringify(body), { status })
}

function windowRows (rows, url, timestampOf) {
  return rows.filter(row => (
    timestampOf(row) >= Number(url.searchParams.get("startTime"))
    && timestampOf(row) <= Number(url.searchParams.get("endTime"))
  )).slice(0, Number(url.searchParams.get("limit")))
}

function createApi (overrides = {}) {
  const state = {
    now: time(3) * 1_000 + 30_000,
    candles: [kline(1), kline(2), kline(3)],
    oi: [oi(2), oi(3)],
    responses: {},
    ...overrides,
  }
  state.current = overrides.current ?? { symbol: "RAYSOLUSDT", openInterest: "3000", time: state.now - 1_000 }
  const calls = []

  return {
    state,
    calls,
    async fetch (url, options) {
      url = new URL(url)
      calls.push({ url, options })
      if (state.responses[url.pathname]) {
        return state.responses[url.pathname](url, options)
      }

      switch (url.pathname) {
        case "/fapi/v1/time":
          return json({ serverTime: state.now })
        case "/fapi/v1/klines":
          return json(windowRows(state.candles, url, row => row[0]))
        case "/futures/data/openInterestHist":
          return json(windowRows(state.oi, url, row => row.timestamp))
        case "/fapi/v1/openInterest":
          return json(state.current)
        default:
          assert.fail(`Unexpected endpoint: ${url.pathname}`)
      }
    },
  }
}

function createUpdater (api) {
  return createChartUpdater({ isArray, isFinite, isSafeInteger, isString, fetch: api.fetch })
}

function pointAt (series, hour) {
  return series.find(point => point.time === time(hour))
}

function freezeHistory (history) {
  for (const key of ["candles", "volume", "openInterest"]) {
    history[key].forEach(Object.freeze)
    Object.freeze(history[key])
  }
  Object.freeze(history)
}

function advanceHour (api) {
  api.state.now = time(4) * 1_000 + 30_000
  api.state.candles = [kline(3, 103, 1_003), kline(4, 104, 1_004)]
  api.state.oi = [oi(4, 4_321)]
  api.state.current = { symbol: "RAYSOLUSDT", openInterest: "4000", time: api.state.now - 1_000 }
  api.calls.length = 0
}

test("factory starts no requests and works from toString with injected, non-stringified type helpers", async () => {
  const api = createApi()
  const factory = vm.runInNewContext(`(${createChartUpdater.toString()})`, {
    URL, AbortController, setTimeout, clearTimeout, fetch: api.fetch,
  }, { timeout: 1_000 })
  const update = factory({ isArray, isFinite, isSafeInteger, isString })

  assert.equal(api.calls.length, 0)
  const { coin, asOf } = createInput()
  const result = structuredClone(await update(coin, asOf))

  assert.equal(result.sourceFrom, time(1))
  assert.deepEqual(pointAt(result.history.openInterest, 2), { time: time(2), value: 10_003 })
  assert.equal(api.calls.length, 4)
})

test("requests anonymous trade klines for the market alias and merges candles, volume and native OI", async () => {
  const { coin, asOf } = createInput()
  const before = structuredClone(coin)
  freezeHistory(coin.history)
  Object.freeze(coin)
  const api = createApi()
  const result = await createUpdater(api)(coin, asOf)

  assert.deepEqual(Object.keys(result).sort(), [
    "currentOiAt", "formingTime", "history", "limitReached", "oiSourceFrom", "sourceFrom", "updatedAt",
  ])
  assert.equal(result.updatedAt, new Date(api.state.now).toISOString())
  assert.equal(result.formingTime, time(3))
  assert.equal(result.limitReached, false)
  assert.equal(result.currentOiAt, new Date(api.state.current.time).toISOString())
  assert.equal(result.sourceFrom, time(1))
  assert.equal(result.oiSourceFrom, time(1))
  assert.equal(result.history.warning, coin.history.warning)
  assert.deepEqual(pointAt(result.history.candles, 1), {
    time: time(1), open: 100, high: 102, low: 99, close: 101,
  })
  assert.deepEqual(pointAt(result.history.volume, 1), { time: time(1), value: 1_000 })
  assert.deepEqual(pointAt(result.history.openInterest, 1), { time: time(1), value: 10_002 })
  assert.deepEqual(pointAt(result.history.openInterest, 3), { time: time(3), value: 3_000 })

  for (const { url, options } of api.calls) {
    assert.equal(url.origin, "https://fapi.binance.com")
    assert.equal(options.method, "GET")
    assert.equal(options.credentials, "omit")
    assert.equal(options.headers, undefined)
    assert.ok(options.signal instanceof AbortSignal)
    if (url.pathname !== "/fapi/v1/time") {
      assert.equal(url.searchParams.get("symbol"), "RAYSOLUSDT")
    }
  }
  const candleRequest = api.calls.find(call => call.url.pathname === "/fapi/v1/klines").url
  assert.equal(candleRequest.searchParams.get("interval"), "1h")
  assert.equal(candleRequest.searchParams.get("limit"), "1000")
  assert.equal(Number(candleRequest.searchParams.get("startTime")), time(1) * 1_000)
  assert.equal(Number(candleRequest.searchParams.get("endTime")), api.state.now)
  const oiRequest = api.calls.find(call => call.url.pathname === "/futures/data/openInterestHist").url
  assert.equal(oiRequest.searchParams.get("period"), "1h")
  assert.equal(oiRequest.searchParams.get("limit"), "500")
  assert.equal(Number(oiRequest.searchParams.get("startTime")), time(2) * 1_000)
  assert.equal(Number(oiRequest.searchParams.get("endTime")), time(3) * 1_000)

  for (const key of ["candles", "volume", "openInterest"]) {
    assert.deepEqual(result.history[key].filter(point => point.time <= time()), before.history[key])
    assert.notEqual(result.history[key], coin.history[key])
    assert.notEqual(result.history[key][0], coin.history[key][0])
  }
  assert.deepEqual(coin, before)
})

test("preserves 1000-prefixed symbols and uses neither the coin ticker nor notional OI", async () => {
  const { coin, asOf } = createInput()
  coin.symbol = "SHIB"
  coin.marketSymbol = "BINANCE:1000SHIBUSDT.P"
  const api = createApi({
    oi: [oi(2, 123.45), oi(3, 234.56)].map(row => ({
      ...row, symbol: "1000SHIBUSDT", sumOpenInterestValue: "not used",
    })),
  })
  api.state.current.symbol = "1000SHIBUSDT"
  const result = await createUpdater(api)(coin, asOf)

  assert.equal(pointAt(result.history.openInterest, 1).value, 123.45)
  assert.equal(pointAt(result.history.openInterest, 2).value, 234.56)
  assert.ok(api.calls.filter(call => call.url.searchParams.has("symbol"))
    .every(call => call.url.searchParams.get("symbol") === "1000SHIBUSDT"))
})

test("old reports request only the first 168 continuation candles and skip expired and current OI", async () => {
  const { coin, asOf } = createInput()
  const api = createApi({
    now: time(1_003) * 1_000 + 30_000,
    candles: Array.from({ length: 1_003 }, (_, index) => kline(index + 1, 101, index)),
    oi: Array.from({ length: 1_002 }, (_, index) => oi(index + 2)),
  })
  const result = await createUpdater(api)(coin, asOf)

  assert.deepEqual(api.calls.map(call => call.url.pathname), ["/fapi/v1/time", "/fapi/v1/klines"])
  const request = api.calls[1].url
  assert.equal(Number(request.searchParams.get("startTime")), time(1) * 1_000)
  assert.equal(Number(request.searchParams.get("endTime")), time(169) * 1_000 - 1)
  for (const key of ["candles", "volume", "openInterest"]) {
    assert.equal(result.history[key].length, 170)
    assert.equal(result.history[key].at(-1).time, time(168))
    assert.deepEqual(result.history[key].filter(point => point.time <= time()), coin.history[key])
  }
  assert.equal(pointAt(result.history.volume, 168).value, 167)
  assert.deepEqual(pointAt(result.history.openInterest, 168), { time: time(168) })
  assert.equal(result.sourceFrom, time(1))
  assert.equal(result.oiSourceFrom, null)
  assert.equal(result.limitReached, true)
  assert.equal(result.formingTime, null)
  assert.equal(result.currentOiAt, null)
  assert.match(result.history.warning, /30 дней/)
  assert.doesNotMatch(result.history.warning, /Текущая свеча|Текущий OI/)
})

test("partial bounded history leaves real gaps instead of looking for newer candles beyond the limit", async () => {
  const { coin, asOf } = createInput()
  const api = createApi({ now: time(1_003) * 1_000 + 30_000, candles: [kline(166), kline(168), kline(1_003)], oi: [] })
  const result = await createUpdater(api)(coin, asOf)

  assert.equal(api.calls.filter(call => call.url.pathname === "/fapi/v1/klines").length, 1)
  assert.deepEqual(result.history.candles.filter(point => point.time > time()).map(point => point.time), [
    time(166), time(168),
  ])
  assert.deepEqual(pointAt(result.history.volume, 167), { time: time(167) })
  assert.equal(result.sourceFrom, time(166))
  assert.equal(result.limitReached, true)
  assert.match(result.history.warning, /Свечи Binance: есть пропущенные/)
})

test("bounded OI includes the last candle's close and repeated clicks cannot advance the seven-day window", async () => {
  const { coin, asOf } = createInput()
  const api = createApi({
    now: time(240) * 1_000 + 30_000,
    candles: Array.from({ length: 240 }, (_, index) => kline(index + 1)),
    oi: Array.from({ length: 240 }, (_, index) => oi(index + 2)),
  })
  const update = createUpdater(api)
  const first = await update(coin, asOf)
  const request = api.calls.find(call => call.url.pathname === "/futures/data/openInterestHist").url

  assert.equal(Number(request.searchParams.get("startTime")), time(2) * 1_000)
  assert.equal(Number(request.searchParams.get("endTime")), time(169) * 1_000)
  assert.equal(pointAt(first.history.openInterest, 168).value, 10_169)
  assert.equal(first.history.warning, coin.history.warning)
  assert.equal(api.calls.some(call => call.url.pathname === "/fapi/v1/openInterest"), false)

  api.state.now = time(480) * 1_000
  api.calls.length = 0
  const second = await update(coin, asOf, first)
  assert.deepEqual(api.calls.map(call => call.url.pathname), ["/fapi/v1/time"])
  assert.deepEqual(second.history, first.history)
  assert.equal(second.limitReached, true)
  assert.equal(second.formingTime, null)
  assert.equal(second.currentOiAt, null)
})

test("the 168th candle remains refreshable until closed without adding a 169th candle or live OI", async () => {
  const { coin, asOf } = createInput()
  const api = createApi({
    now: time(168) * 1_000 + 30_000,
    candles: Array.from({ length: 168 }, (_, index) => kline(index + 1)),
    oi: Array.from({ length: 167 }, (_, index) => oi(index + 2)),
  })
  const update = createUpdater(api)
  const first = await update(coin, asOf)
  assert.equal(first.limitReached, false)
  assert.equal(first.formingTime, time(168))
  assert.equal(pointAt(first.history.openInterest, 168).value, 3_000)

  api.state.now = time(169) * 1_000
  api.state.candles = [kline(168, 222, 2_222), kline(169)]
  api.state.oi = [oi(169, 4_321), oi(170)]
  api.calls.length = 0
  const second = await update(coin, asOf, first)

  assert.deepEqual(api.calls.map(call => call.url.pathname), [
    "/fapi/v1/time", "/fapi/v1/klines", "/futures/data/openInterestHist",
  ])
  assert.equal(second.limitReached, true)
  assert.equal(second.formingTime, null)
  assert.equal(second.currentOiAt, null)
  assert.equal(pointAt(second.history.candles, 168).close, 222)
  assert.equal(pointAt(second.history.volume, 168).value, 2_222)
  assert.equal(pointAt(second.history.openInterest, 168).value, 4_321)
  for (const key of ["candles", "volume", "openInterest"]) {
    assert.equal(second.history[key].length, 170)
    assert.equal(second.history[key].at(-1).time, time(168))
  }
  assert.equal(second.history.warning, coin.history.warning)
  assert.equal(pointAt(first.history.openInterest, 168).value, 3_000)
})

test("a missing final close rejects atomically and does not freeze the provisional candle as closed", async () => {
  const { coin, asOf } = createInput()
  const api = createApi({ now: time(168) * 1_000 + 30_000, candles: [kline(168)] })
  const update = createUpdater(api)
  const first = await update(coin, asOf)
  const before = structuredClone(first)
  api.state.now = time(169) * 1_000
  api.state.candles = [kline(169)]

  await assert.rejects(update(coin, asOf, first), /не подтвердил закрытие прежней формирующейся свечи/)
  assert.deepEqual(first, before)
})

test("gaps inside the fixed window can still heal after its limit is reached", async () => {
  const { coin, asOf } = createInput()
  const api = createApi({
    now: time(240) * 1_000,
    candles: Array.from({ length: 168 }, (_, index) => kline(index + 1)).filter(row => row[0] !== time(99) * 1_000),
    oi: Array.from({ length: 168 }, (_, index) => oi(index + 2)).filter(row => row.timestamp !== time(100) * 1_000),
  })
  const update = createUpdater(api)
  const first = await update(coin, asOf)
  assert.equal(first.limitReached, true)
  assert.match(first.history.warning, /пропущенные закрытые часы/)

  api.state.candles = [kline(99)]
  api.state.oi = [oi(100)]
  api.calls.length = 0
  const second = await update(coin, asOf, first)
  assert.equal(second.history.warning, coin.history.warning)
  assert.equal(second.limitReached, true)
  assert.equal(pointAt(second.history.candles, 99).close, 101)
  assert.equal(pointAt(second.history.openInterest, 99).value, 10_100)
  assert.equal(Number(api.calls[1].url.searchParams.get("startTime")), time(99) * 1_000)
  assert.equal(Number(api.calls[1].url.searchParams.get("endTime")), time(169) * 1_000 - 1)
  assert.equal(Number(api.calls[2].url.searchParams.get("startTime")), time(100) * 1_000)
  assert.equal(Number(api.calls[2].url.searchParams.get("endTime")), time(169) * 1_000)
})

test("out-of-window API and cached points cannot extend any series or its provenance", async () => {
  const { coin, asOf } = createInput()
  const api = createApi({ now: time(240) * 1_000 })
  api.state.responses["/fapi/v1/klines"] = () => json([kline(1), kline(168), kline(169), kline(240)])
  api.state.responses["/futures/data/openInterestHist"] = () => json([oi(2), oi(169), oi(170), oi(240)])
  const previous = {
    history: {
      candles: [{ time: time(240), open: 1, high: 3, low: 1, close: 2 }],
      volume: [{ time: time(240), value: 1_000 }],
      openInterest: [{ time: time(240), value: 3_000 }],
    },
    formingTime: time(240),
    currentOiAt: iso(240),
    oiSourceFrom: time(240),
  }
  const before = structuredClone(previous)
  const result = await createUpdater(api)(coin, asOf, previous)

  for (const key of ["candles", "volume", "openInterest"]) {
    assert.equal(result.history[key].at(-1).time, time(168))
  }
  assert.equal(result.sourceFrom, time(1))
  assert.equal(result.oiSourceFrom, time(1))
  assert.equal(result.formingTime, null)
  assert.equal(result.currentOiAt, null)
  assert.deepEqual(previous, before)
})

test("no candles inside the allowed window rejects instead of fetching a newer week", async () => {
  const { coin, asOf } = createInput()
  const api = createApi({ now: time(240) * 1_000, candles: [kline(169), kline(240)] })
  await assert.rejects(createUpdater(api)(coin, asOf), /не вернул ни одной свечи/)
  assert.deepEqual(api.calls.map(call => call.url.pathname), ["/fapi/v1/time", "/fapi/v1/klines"])
  assert.equal(Number(api.calls[1].url.searchParams.get("endTime")), time(169) * 1_000 - 1)
})

test("sorts and deduplicates API hours with last response entry winning, without rewriting TV", async () => {
  const { coin, asOf } = createInput()
  const api = createApi()
  api.state.responses["/fapi/v1/klines"] = () => json([
    kline(3), kline(2), kline(1), kline(2, 222, 2_222), kline(0, 888),
  ])
  api.state.responses["/futures/data/openInterestHist"] = () => json([
    oi(3), oi(2), oi(3, 23_456), oi(1, 999),
  ])
  const result = await createUpdater(api)(coin, asOf)

  assert.equal(pointAt(result.history.candles, 2).close, 222)
  assert.equal(pointAt(result.history.volume, 2).value, 2_222)
  assert.equal(pointAt(result.history.openInterest, 2).value, 23_456)
  assert.deepEqual(pointAt(result.history.candles, 0), coin.history.candles.at(-1))
  assert.deepEqual(pointAt(result.history.openInterest, 0), coin.history.openInterest.at(-1))
  for (const key of ["candles", "volume", "openInterest"]) {
    const times = result.history[key].map(point => point.time)
    assert.ok(times.every(timestamp => isSafeInteger(timestamp) && timestamp % 3_600 === 0))
    assert.ok(times.every((timestamp, index) => index === 0 || timestamp > times[index - 1]))
  }
  assert.match(result.history.warning, /дубликаты/)
})

test("same-hour refresh updates only the forming continuation; next hour replaces provisional OI with history", async () => {
  const { coin, asOf } = createInput()
  const api = createApi()
  const update = createUpdater(api)
  const first = await update(coin, asOf)
  const before = structuredClone([coin, first])
  freezeHistory(first.history)
  Object.freeze(first)
  api.state.now += 15_000
  api.state.candles = [kline(3, 333, 3_333)]
  api.state.current = { ...api.state.current, time: api.state.now - 1_000, openInterest: "3333" }
  api.calls.length = 0
  const second = await update(coin, asOf, first)

  assert.equal(pointAt(second.history.candles, 3).close, 333)
  assert.equal(pointAt(second.history.volume, 3).value, 3_333)
  assert.equal(pointAt(second.history.openInterest, 3).value, 3_333)
  assert.equal(Number(api.calls.find(call => call.url.pathname === "/fapi/v1/klines").url.searchParams.get("startTime")), time(3) * 1_000)
  assert.equal(api.calls.some(call => call.url.pathname === "/futures/data/openInterestHist"), false)
  assert.deepEqual([coin, first], before)

  advanceHour(api)
  const third = await update(coin, asOf, second)
  assert.equal(pointAt(third.history.candles, 3).close, 103)
  assert.equal(pointAt(third.history.openInterest, 3).value, 4_321)
  assert.equal(pointAt(third.history.openInterest, 4).value, 4_000)
  assert.equal(third.formingTime, time(4))
  assert.equal(third.currentOiAt, new Date(api.state.current.time).toISOString())
  assert.equal(third.sourceFrom, first.sourceFrom)
  assert.equal(third.oiSourceFrom, first.oiSourceFrom)
  assert.equal(Number(api.calls.find(call => call.url.pathname === "/futures/data/openInterestHist").url.searchParams.get("startTime")), time(4) * 1_000)
  assert.equal(pointAt(second.history.openInterest, 3).value, 3_333)
})

test("missing closed snapshots remove provisional OI, retain provenance, and are retried until gaps heal", async () => {
  const { coin, asOf } = createInput()
  const api = createApi({ oi: [] })
  const update = createUpdater(api)
  const first = await update(coin, asOf)
  assert.equal(first.oiSourceFrom, time(3))

  advanceHour(api)
  api.state.oi = []
  api.state.current.openInterest = null
  const second = await update(coin, asOf, first)
  assert.deepEqual(pointAt(second.history.openInterest, 3), { time: time(3) })
  assert.deepEqual(pointAt(second.history.openInterest, 4), { time: time(4) })
  assert.equal(second.currentOiAt, null)
  assert.equal(second.oiSourceFrom, time(3))
  assert.match(second.history.warning, /последнего закрытого часа/)
  assert.match(second.history.warning, /пустое значение/)
  assert.equal(pointAt(first.history.openInterest, 3).value, 3_000)

  api.state.oi = [oi(2), oi(3), oi(4)]
  api.state.current.openInterest = "0"
  const third = await update(coin, asOf, second)
  assert.equal(pointAt(third.history.openInterest, 1).value, 10_002)
  assert.equal(pointAt(third.history.openInterest, 3).value, 10_004)
  assert.equal(pointAt(third.history.openInterest, 4).value, 0)
  assert.equal(third.oiSourceFrom, time(1))
  assert.equal(third.history.warning, coin.history.warning)
})

for (const [label, timestamp, expectedWarning] of [
  ["stale in the same hour", time(3) * 1_000 + 1_000, /устарел/],
  ["fresh but in the previous hour", time(3) * 1_000 - 1_000, /другому часу/],
  ["in the next hour", time(4) * 1_000, /другому часу/],
  ["implausibly ahead of server time", time(3) * 1_000 + 900_000, /время ненадёжно/],
]) {
  test(`does not use current OI ${label}`, async () => {
    const { coin, asOf } = createInput()
    const api = createApi({ now: time(3) * 1_000 + (label.startsWith("fresh") ? 30_000 : 600_000) })
    api.state.current.time = timestamp
    const result = await createUpdater(api)(coin, asOf)

    assert.deepEqual(pointAt(result.history.openInterest, 3), { time: time(3) })
    assert.equal(result.currentOiAt, null)
    assert.equal(pointAt(result.history.openInterest, 2).value, 10_003)
    assert.match(result.history.warning, expectedWarning)
  })
}

test("does not keep the cached same-hour OI when the new current observation is stale", async () => {
  const { coin, asOf } = createInput()
  const api = createApi()
  const update = createUpdater(api)
  const first = await update(coin, asOf)
  api.state.now += 180_000
  const second = await update(coin, asOf, first)

  assert.deepEqual(pointAt(second.history.openInterest, 3), { time: time(3) })
  assert.equal(second.currentOiAt, null)
  assert.match(second.history.warning, /устарел/)
  assert.equal(pointAt(first.history.openInterest, 3).value, 3_000)
})

test("31-day report requests only retained OI inside its seven-day window and leaves older hours empty", async () => {
  const { coin, asOf } = createInput(-31 * 24)
  const api = createApi({
    candles: Array.from({ length: 168 }, (_, index) => kline(index - 743)),
    oi: Array.from({ length: 750 }, (_, index) => oi(index - 746)),
  })
  const result = await createUpdater(api)(coin, asOf)
  const firstRequest = api.calls.find(call => call.url.pathname === "/futures/data/openInterestHist").url
  const cutoff = Math.ceil((api.state.now - 30 * 24 * 3_600_000) / 3_600_000) * 3_600_000

  assert.equal(Number(firstRequest.searchParams.get("startTime")), cutoff)
  assert.equal(Number(firstRequest.searchParams.get("endTime")), time(-575) * 1_000)
  assert.equal(result.history.openInterest.at(-1).time, time(-576))
  assert.deepEqual(pointAt(result.history.openInterest, -31 * 24 + 1), { time: time(-31 * 24 + 1) })
  assert.deepEqual(pointAt(result.history.openInterest, -718), { time: time(-718) })
  assert.equal(pointAt(result.history.openInterest, -717).value, 10_000 - 716)
  assert.equal(result.oiSourceFrom, cutoff / 1_000 - 3_600)
  assert.match(result.history.warning, /30 дней/)
  assert.deepEqual(result.history.openInterest.filter(point => point.time <= time(-31 * 24)), coin.history.openInterest)
})

test("cached closed OI remains real data beyond retention, but an old provisional point does not", async () => {
  const { coin, asOf } = createInput(-31 * 24)
  const api = createApi({
    now: time(-730) * 1_000 + 30_000,
    candles: Array.from({ length: 14 }, (_, index) => kline(index - 743)),
    oi: Array.from({ length: 13 }, (_, index) => oi(index - 742)),
  })
  const update = createUpdater(api)
  const first = await update(coin, asOf)
  api.state.now = time(3) * 1_000 + 30_000
  api.state.candles = Array.from({ length: 734 }, (_, index) => kline(index - 730))
  api.state.oi = Array.from({ length: 720 }, (_, index) => oi(index - 716))
  api.state.current = { ...api.state.current, time: api.state.now - 1_000 }
  const second = await update(coin, asOf, first)

  assert.deepEqual(pointAt(second.history.openInterest, -743), pointAt(first.history.openInterest, -743))
  assert.deepEqual(pointAt(second.history.openInterest, -730), { time: time(-730) })
  assert.equal(second.sourceFrom, first.sourceFrom)
  assert.equal(second.oiSourceFrom, first.oiSourceFrom)
  assert.match(second.history.warning, /30 дней/)
})

test("empty saved history can receive a continuation; fully unavailable OI stays whitespace with null provenance", async () => {
  const { coin, asOf } = createInput()
  coin.history = { candles: [], volume: [], openInterest: [], warning: null }
  const api = createApi({ oi: [] })
  api.state.current.openInterest = ""
  const result = await createUpdater(api)(coin, asOf)

  assert.equal(result.history.candles.length, 3)
  assert.equal(result.sourceFrom, time(1))
  assert.equal(result.oiSourceFrom, null)
  assert.equal(result.currentOiAt, null)
  assert.deepEqual(result.history.openInterest, [1, 2, 3].map(hour => ({ time: time(hour) })))
  assert.match(result.history.warning, /Исходная история TradingView отсутствует/)
  assert.match(result.history.warning, /пропущенные закрытые часы/)
})

test("no first Binance candle rejects rather than inventing sourceFrom; empty refresh preserves prior candles honestly", async () => {
  const { coin, asOf } = createInput()
  const empty = createApi({ candles: [] })
  await assert.rejects(createUpdater(empty)(coin, asOf), /не вернул ни одной свечи/)

  const api = createApi()
  const update = createUpdater(api)
  const first = await update(coin, asOf)
  api.state.candles = []
  const second = await update(coin, asOf, first)
  assert.deepEqual(second.history.candles, first.history.candles)
  assert.equal(second.sourceFrom, first.sourceFrom)
  assert.equal(second.formingTime, time(3))
  assert.match(second.history.warning, /Текущая свеча Binance не получена/)

  advanceHour(api)
  api.state.candles = [kline(4)]
  const before = structuredClone(second)
  await assert.rejects(update(coin, asOf, second), /не подтвердил закрытие прежней формирующейся свечи/)
  assert.deepEqual(second, before)
})

test("tracks current OI by its own timestamp even when no forming price candle was returned", async () => {
  const { coin, asOf } = createInput()
  const api = createApi({ candles: [kline(1), kline(2)] })
  const update = createUpdater(api)
  const first = await update(coin, asOf)
  assert.equal(first.formingTime, null)
  assert.equal(first.currentOiAt, new Date(api.state.current.time).toISOString())
  assert.equal(pointAt(first.history.openInterest, 3).value, 3_000)

  advanceHour(api)
  api.state.oi = []
  const second = await update(coin, asOf, first)
  assert.deepEqual(pointAt(second.history.openInterest, 3), { time: time(3) })
  assert.equal(second.formingTime, time(4))
  assert.match(second.history.warning, /последнего закрытого часа/)
})

test("no closed continuation yet skips OI history and never modifies the last TV hour", async () => {
  const { coin, asOf } = createInput()
  const api = createApi({ now: time(1) * 1_000 + 30_000, candles: [kline(1)], oi: [] })
  const result = await createUpdater(api)(coin, asOf)

  assert.equal(api.calls.some(call => call.url.pathname === "/futures/data/openInterestHist"), false)
  assert.equal(result.sourceFrom, time(1))
  assert.equal(result.oiSourceFrom, time(1))
  assert.deepEqual(pointAt(result.history.openInterest, 0), coin.history.openInterest.at(-1))
})

test("cached TV values cannot replace the original report snapshot", async () => {
  const { coin, asOf } = createInput()
  const api = createApi()
  const update = createUpdater(api)
  const first = await update(coin, asOf)
  first.history.candles[0].close = 999
  first.history.volume[0].value = 999
  first.history.openInterest[0].value = 999
  const before = structuredClone(first)
  const second = await update(coin, asOf, first)

  for (const key of ["candles", "volume", "openInterest"]) {
    assert.deepEqual(second.history[key].filter(point => point.time <= time()), coin.history[key])
  }
  assert.deepEqual(first, before)
})

for (const market of ["BYBIT:BTCUSDT.P", "BINANCE:BTCUSD.P", "BINANCE:BTCUSDT", "BINANCE:BTCUSDT.P?x=1", "", null]) {
  test(`rejects unsupported market ${market} before any request`, async () => {
    const { coin, asOf } = createInput()
    coin.marketSymbol = market
    const api = createApi()
    await assert.rejects(createUpdater(api)(coin, asOf), /Некорректный рынок/)
    assert.equal(api.calls.length, 0)
  })
}

test("rejects invalid asOf, non-array input history, and an asOf not closed according to server time", async () => {
  const { coin } = createInput()
  const api = createApi()
  const update = createUpdater(api)
  for (const asOf of [null, "invalid", "2026-09-16T07:01:00.000Z"]) {
    await assert.rejects(update(coin, asOf), /Некорректный asOf/)
  }
  await assert.rejects(update({ ...coin, history: { ...coin.history, candles: null } }, iso()), /история графика/)
  assert.equal(api.calls.length, 0)
  await assert.rejects(update(coin, iso(3)), /не является закрытым часом/)
  assert.equal(api.calls.length, 1)
})

for (const endpoint of ["/fapi/v1/time", "/fapi/v1/klines", "/futures/data/openInterestHist", "/fapi/v1/openInterest"]) {
  for (const kind of ["network", "HTTP 429", "invalid JSON", "invalid shape"]) {
    test(`${endpoint} ${kind} rejects atomically, leaving the coin and cached result untouched`, async () => {
      const { coin, asOf } = createInput()
      const api = createApi()
      const update = createUpdater(api)
      const previous = await update(coin, asOf)
      const before = structuredClone([coin, previous])
      freezeHistory(coin.history)
      freezeHistory(previous.history)
      Object.freeze(previous)
      advanceHour(api)
      api.state.responses[endpoint] = () => {
        if (kind === "network") {
          throw new TypeError("Failed to fetch")
        }
        if (kind === "HTTP 429") {
          return json({ code: -1003, msg: "Too many requests" }, 429)
        }
        if (kind === "invalid JSON") {
          return new Response("not JSON")
        }
        return json({ unexpected: true })
      }

      await assert.rejects(update(coin, asOf, previous), kind === "network"
        ? /сети или CORS/
        : kind === "HTTP 429" ? /лимит запросов.*429/ : /Некорректные данные Binance/)
      assert.deepEqual([coin, previous], before)
    })
  }
}

for (const [label, endpoint, payload] of [
  ["non-integer server time", "/fapi/v1/time", { serverTime: 1.5 }],
  ["out-of-range server date", "/fapi/v1/time", { serverTime: Number.MAX_SAFE_INTEGER }],
  ["non-hour candle", "/fapi/v1/klines", [[time(1) * 1_000 + 1, "1", "2", "1", "2", "1"]]],
  ["bad OHLC bounds", "/fapi/v1/klines", [[time(1) * 1_000, "100", "90", "80", "101", "1"]]],
  ["missing volume", "/fapi/v1/klines", [[time(1) * 1_000, "1", "2", "1", "2"]]],
  ["null volume", "/fapi/v1/klines", [[time(1) * 1_000, "1", "2", "1", "2", null]]],
  ["negative volume", "/fapi/v1/klines", [[time(1) * 1_000, "1", "2", "1", "2", "-1"]]],
  ["wrong OI market", "/futures/data/openInterestHist", [{ ...oi(2), symbol: "BTCUSDT" }]],
  ["non-hour OI snapshot", "/futures/data/openInterestHist", [{ ...oi(2), timestamp: time(2) * 1_000 + 1 }]],
  ["invalid OI quantity", "/futures/data/openInterestHist", [{ ...oi(2), sumOpenInterest: "NaN" }]],
  ["notional without quantity", "/futures/data/openInterestHist", [{ symbol: "RAYSOLUSDT", timestamp: time(2) * 1_000, sumOpenInterestValue: "123" }]],
  ["wrong current market", "/fapi/v1/openInterest", { symbol: "BTCUSDT", time: time(3) * 1_000, openInterest: "1" }],
  ["missing current quantity", "/fapi/v1/openInterest", { symbol: "RAYSOLUSDT", time: time(3) * 1_000 }],
  ["invalid even when stale current", "/fapi/v1/openInterest", { symbol: "RAYSOLUSDT", time: time(1) * 1_000, openInterest: "Infinity" }],
  ["null current timestamp", "/fapi/v1/openInterest", { symbol: "RAYSOLUSDT", time: null, openInterest: null }],
]) {
  test(`rejects ${label} instead of silently accepting corrupt API data`, async () => {
    const { coin, asOf } = createInput()
    const api = createApi()
    api.state.responses[endpoint] = () => json(payload)
    await assert.rejects(createUpdater(api)(coin, asOf), /Некорректные данные Binance/)
  })
}

test("reports invalid symbols, ordinary HTTP errors and Binance error codes even with HTTP 200", async () => {
  const { coin, asOf } = createInput()
  for (const [status, body, pattern] of [
    [400, { code: -1121, msg: "Invalid symbol" }, /рынок не найден/],
    [503, { msg: "Unavailable" }, /HTTP 503/],
    [200, { code: -1130, msg: "Invalid startTime" }, /код -1130/],
  ]) {
    const api = createApi()
    api.state.responses["/fapi/v1/openInterest"] = () => json(body, status)
    await assert.rejects(createUpdater(api)(coin, asOf), pattern)
  }
})

test("aborts a timed out fetch and clears its timer", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] })
  const { coin, asOf } = createInput()
  let signal
  const update = createUpdater({
    fetch (_url, options) {
      signal = options.signal
      return new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("Aborted")), { once: true })
      })
    },
  })
  const rejected = assert.rejects(update(coin, asOf), /время ожидания \(15 секунд\)/)
  context.mock.timers.tick(15_000)
  await rejected
  assert.equal(signal.aborted, true)
})

test("timeout also covers a stalled JSON body on the final endpoint", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] })
  const { coin, asOf } = createInput()
  const api = createApi()
  const reading = Promise.withResolvers()
  api.state.responses["/fapi/v1/openInterest"] = (_url, { signal }) => ({
    ok: true,
    status: 200,
    json () {
      reading.resolve()
      return new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("Aborted")), { once: true })
      })
    },
  })
  const rejected = assert.rejects(createUpdater(api)(coin, asOf), /openInterest.*время ожидания/)
  await reading.promise
  context.mock.timers.tick(15_000)
  await rejected
})
