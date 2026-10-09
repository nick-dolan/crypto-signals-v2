import assert from "node:assert/strict"
import test from "node:test"

import { isError } from "../src/helpers/utils.typed.js"
import { buildReportChartSnapshots } from "../src/steps/step13-report/build-report-chart-snapshots.js"

function time (hours = 0) {
  return Date.parse("2026-10-06T08:00:00.000Z") / 1_000 + hours * 3_600
}

function createInput (symbols = ["COTI", "1000SHIB"]) {
  return {
    asOf: new Date(time() * 1_000).toISOString(),
    coins: symbols.map(symbol => ({
      symbol, marketSymbol: `BINANCE:${symbol}USDT.P`, movementProbability: 0.7,
      features: { atr: 2, volumeZ: 1.5 }, explanation: "Сохранённый анализ",
      history: {
        candles: [-1, 0].map(hour => ({ time: time(hour), open: 10, high: 12, low: 9, close: 11 })),
        volume: [-1, 0].map(hour => ({ time: time(hour), value: 100 })),
        openInterest: [-1, 0].map(hour => ({ time: time(hour), value: 20 })),
        warning: null,
      },
    })),
  }
}

function capture (coin) {
  return {
    history: {
      candles: [...coin.history.candles, ...[1, 2].map(hour => ({ time: time(hour), open: 11, high: 15, low: 10, close: 14 }))],
      volume: [...coin.history.volume, ...[1, 2].map(hour => ({ time: time(hour), value: 200 }))],
      openInterest: [...coin.history.openInterest, ...[1, 2].map(hour => ({ time: time(hour), value: 30 }))],
      warning: null,
    },
    updatedAt: new Date(time(2) * 1_000 + 1_800_000).toISOString(),
    formingTime: time(2), currentOiAt: new Date(time(2) * 1_000 + 1_799_000).toISOString(),
    sourceFrom: time(1), oiSourceFrom: time(1), limitReached: false,
  }
}

function quote (symbol = "COTIUSDT", price = "14.25", timestamp = time(2) * 1_000 + 1_799_123) {
  return { symbol, price, time: timestamp }
}

test("captures only continuation separately, then obtains one bulk quote snapshot without changing analysis", async () => {
  const { coins, asOf } = createInput()
  const before = structuredClone(coins)
  const completed = new Set()
  let quoteCalls = 0
  const results = await buildReportChartSnapshots(coins, asOf, {
    updateChartHistory: async (coin, timestamp) => {
      assert.equal(timestamp, asOf)
      await Promise.resolve()
      completed.add(coin.symbol)
      return capture(coin)
    },
    fetchQuotes: async () => {
      assert.equal(completed.size, coins.length)
      quoteCalls += 1
      return [quote(), quote("1000SHIBUSDT", "0.0000123")]
    },
  })

  assert.equal(quoteCalls, 1)
  assert.deepEqual(coins, before)
  assert.deepEqual(results.map(coin => coin.symbol), coins.map(coin => coin.symbol))
  for (const [index, { chartSnapshot, ...analysis }] of results.entries()) {
    assert.deepEqual(analysis, before[index])
    assert.equal(results[index].history, coins[index].history)
    assert.equal(chartSnapshot.warning, null)
    assert.equal(chartSnapshot.data.formingTime, time(2))
    assert.equal(chartSnapshot.data.currentOiAt, capture(coins[index]).currentOiAt)
    for (const key of ["candles", "volume", "openInterest"]) {
      assert.deepEqual(chartSnapshot.data.history[key], capture(coins[index]).history[key].filter(point => point.time > time()))
    }
    assert.deepEqual(chartSnapshot.quote, {
      price: index ? 0.0000123 : 14.25,
      at: "2026-10-06T10:29:59.123Z",
    })
  }
})

test("saved continuation never duplicates the analysis window or exceeds 168 hours", async () => {
  const { coins, asOf } = createInput(["COTI"])
  const full = capture(coins[0])
  for (const key of ["candles", "volume", "openInterest"]) {
    full.history[key].push({ ...full.history[key].at(-1), time: time(168) }, { ...full.history[key].at(-1), time: time(169) })
  }
  const before = structuredClone(full)
  const [result] = await buildReportChartSnapshots(coins, asOf, {
    updateChartHistory: async () => full,
    fetchQuotes: async () => [quote()],
  })
  for (const key of ["candles", "volume", "openInterest"]) {
    assert.deepEqual(result.chartSnapshot.data.history[key].map(point => point.time), [time(1), time(2), time(168)])
  }
  assert.deepEqual(full, before)
})

test("one failed chart does not discard other continuations, available quotes or the original assessments", async () => {
  const { coins, asOf } = createInput()
  const before = structuredClone(coins)
  const results = await buildReportChartSnapshots(coins, asOf, {
    updateChartHistory: async (coin) => {
      if (coin.symbol === "COTI") {
        throw new Error("HTTP 429")
      }
      return capture(coin)
    },
    fetchQuotes: async () => [quote(), quote("1000SHIBUSDT")],
  })
  assert.equal(results[0].chartSnapshot.data, null)
  assert.match(results[0].chartSnapshot.warning, /График при выпуске не обновлён: HTTP 429/)
  assert.equal(results[0].chartSnapshot.quote.price, 14.25)
  assert.equal(results[1].chartSnapshot.warning, null)
  assert.equal(results[1].chartSnapshot.data.formingTime, time(2))
  assert.deepEqual(results.map(({ chartSnapshot, ...coin }) => {
    assert.ok(chartSnapshot)
    return coin
  }), before)
  assert.deepEqual(coins, before)
})

for (const failure of [new Error("HTTP 418"), { symbol: "COTIUSDT", price: "14.25" }]) {
  test(`failed bulk quotes preserve the fresh graph and never substitute its candle close (${failure.message || "non-array"})`, async () => {
    const { coins, asOf } = createInput(["COTI"])
    const [result] = await buildReportChartSnapshots(coins, asOf, {
      updateChartHistory: async coin => capture(coin),
      fetchQuotes: async () => {
        if (isError(failure)) {
          throw failure
        }
        return failure
      },
    })
    assert.equal(result.chartSnapshot.data.formingTime, time(2))
    assert.equal(result.chartSnapshot.quote, null)
    assert.match(result.chartSnapshot.warning, /Цена при выпуске не получена/)
  })
}

for (const row of [
  quote("OTHERUSDT"),
  ...["", "invalid", null, 0, -1, Infinity].map(price => quote("COTIUSDT", price)),
  ...[undefined, null, 0, -1, "2026-10-06", NaN, 9e15].map(timestamp => ({ ...quote(), time: timestamp })),
]) {
  test(`missing or invalid quote stays unavailable: ${JSON.stringify(row)}`, async () => {
    const { coins, asOf } = createInput(["COTI"])
    const [result] = await buildReportChartSnapshots(coins, asOf, {
      updateChartHistory: async coin => capture(coin),
      fetchQuotes: async () => [row],
    })
    assert.equal(result.chartSnapshot.quote, null)
    assert.match(result.chartSnapshot.warning, /Нет корректной котировки Binance для BINANCE:COTIUSDT\.P/)
    assert.equal(result.chartSnapshot.data.formingTime, time(2))
  })
}

test("empty reports need no chart or quote requests", async () => {
  assert.deepEqual(await buildReportChartSnapshots([], createInput().asOf, {
    updateChartHistory: () => assert.fail("Unexpected chart request"),
    fetchQuotes: () => assert.fail("Unexpected quote request"),
  }), [])
})

test("default Binance requests include forming OHLCV and native OI, followed by a single last-trade ticker request", async (t) => {
  const { coins, asOf } = createInput()
  const before = structuredClone(coins)
  const calls = []
  t.mock.method(globalThis, "fetch", async (input) => {
    const url = new URL(input)
    calls.push(url)
    let payload
    if (url.pathname === "/fapi/v1/time") {
      payload = { serverTime: time(2) * 1_000 + 1_800_000 }
    } else if (url.pathname === "/fapi/v1/klines") {
      payload = [1, 2].map(hour => [time(hour) * 1_000, "11", "15", "10", "14", "200"])
    } else if (url.pathname === "/futures/data/openInterestHist") {
      payload = [{ symbol: url.searchParams.get("symbol"), timestamp: time(2) * 1_000, sumOpenInterest: "30" }]
    } else if (url.pathname === "/fapi/v1/openInterest") {
      payload = { symbol: url.searchParams.get("symbol"), time: time(2) * 1_000 + 1_799_000, openInterest: "35" }
    } else {
      assert.equal(url.pathname, "/fapi/v2/ticker/price")
      assert.equal(url.searchParams.size, 0)
      payload = [quote(), quote("1000SHIBUSDT", "0.0000123")]
    }
    return new Response(JSON.stringify(payload))
  })

  const results = await buildReportChartSnapshots(coins, asOf)
  assert.equal(calls.length, 9)
  assert.equal(calls.at(-1).pathname, "/fapi/v2/ticker/price")
  for (const [index, { chartSnapshot }] of results.entries()) {
    assert.equal(chartSnapshot.warning, null)
    assert.equal(chartSnapshot.data.formingTime, time(2))
    assert.deepEqual(chartSnapshot.data.history.candles.map(point => point.time), [time(1), time(2)])
    assert.deepEqual(chartSnapshot.data.history.openInterest, [{ time: time(1), value: 30 }, { time: time(2), value: 35 }])
    assert.equal(chartSnapshot.quote.price, index ? 0.0000123 : 14.25)
  }
  assert.deepEqual(coins, before)
})
