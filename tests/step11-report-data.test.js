import assert from "node:assert/strict"
import path from "node:path"
import test from "node:test"

import { buildReportData } from "../src/steps/step11-report/build-report-data.js"

function createHistory (coin, asOf) {
  const asOfTimestamp = Date.parse(asOf) / 1_000
  const periods = Array.from({ length: 168 }, (_, index) => ({
    time: asOfTimestamp - (167 - index) * 3_600,
    open: 100 + index,
    max: 102 + index,
    min: 99 + index,
    close: 101 + index,
    volume: 1_000 + index,
  }))

  return {
    coin: { ...coin },
    timeframe: "1h",
    chart: { info: { fullName: coin.marketSymbol }, periods },
    studies: {
      openInterest: {
        periods: periods.map(({ time }, index) => ({ time, open: 1, close: 10_000 + index })),
      },
    },
  }
}

function createInput (symbols = ["COTI"]) {
  const shortlist = {
    asOf: "2026-09-15T09:00:00.000Z",
    timeframe: "1h",
    candidateCount: symbols.length,
    universeCoinCount: symbols.length + 20,
    candidates: symbols.map(symbol => ({
      coin: {
        symbol,
        name: `Coin ${symbol}`,
        baseCurrencyId: `XTVC${symbol}`,
        marketSymbol: `BINANCE:${symbol}USDT.P`,
      },
    })),
  }
  const payload = {
    schemaVersion: 10,
    asOf: shortlist.asOf,
    timeframe: "1h",
    objective: "P(|движение| > 2.5 ATR в следующие 4–12 часов)",
    candidateCount: symbols.length,
    marketContext: { breadth4h: 0.2 },
    marketDefinitions: { breadth4h: "Ширина рынка" },
    schema: {
      profile: [],
      volume: ["volumeZ"],
      derivatives: ["quietOi"],
      social: ["socialZ"],
    },
    definitions: {
      volumeZ: "Аномалия объёма",
      symbol: "Тикер",
      name: "Название",
      quietOi: "Тихий рост OI",
      flags: "Флаги",
      socialZ: "Внимание",
    },
    flagDefinitions: { coiling: "Сжатие" },
    candidates: symbols.map((symbol, index) => ({
      symbol,
      name: `Payload ${symbol}`,
      selectionRank: index + 1,
      profile: [],
      volume: [index + 0.1],
      derivatives: [false],
      social: [null],
      flags: ["coiling"],
    })),
  }
  const analysis = {
    asOf: shortlist.asOf,
    candidateCount: symbols.length,
    topCandidates: symbols.slice(0, 2).map(symbol => ({ symbol, explanation: `Выбор ${symbol}` })),
    assessments: symbols.map((symbol, index) => ({
      symbol,
      movementProbability: (index + 1) / 10,
      estimateConfidence: "medium",
      directionBias: "unclear",
      drivers: [`Драйвер ${symbol}`],
      counterSignals: [],
      tradingViewUrl: `https://www.tradingview.com/chart/?symbol=BINANCE:${symbol}USDT.P`,
    })),
  }
  const histories = shortlist.candidates.map(({ coin }) => createHistory(coin, shortlist.asOf))

  return {
    analysis,
    payload,
    shortlist,
    histories,
    readCoinData: async relativePath => histories.find(data => relativePath === path.join(
      "step2-data-bootstrap", `${data.coin.symbol}--${data.coin.baseCurrencyId}`, "data.json",
    )),
  }
}

function build (input, readCoinData = input.readCoinData) {
  return buildReportData(input.analysis, input.payload, input.shortlist, { readCoinData })
}

test("joins by symbol, preserves assessments and top order, and reads histories sequentially", async () => {
  const input = createInput(["COTI", "SOL", "MINA"])
  input.analysis.assessments = [
    input.analysis.assessments[1], input.analysis.assessments[2], input.analysis.assessments[0],
  ]
  input.analysis.assessments[1].explanation = "Не из topCandidates"
  input.payload.candidates.reverse()
  input.shortlist.candidates = [
    input.shortlist.candidates[2], input.shortlist.candidates[0], input.shortlist.candidates[1],
  ]

  const before = structuredClone([input.analysis, input.payload, input.shortlist, input.histories])
  const requestedPaths = []
  let reading = false
  const report = await build(input, async (relativePath) => {
    assert.equal(reading, false)
    reading = true
    requestedPaths.push(relativePath)
    await new Promise(resolve => setImmediate(resolve))
    reading = false
    return input.readCoinData(relativePath)
  })

  assert.deepEqual({ ...report, coins: [] }, {
    asOf: input.analysis.asOf,
    timeframe: "1h",
    objective: input.payload.objective,
    candidateCount: 3,
    universeCoinCount: 23,
    marketContext: input.payload.marketContext,
    altMarketBackground: null,
    marketDefinitions: input.payload.marketDefinitions,
    definitions: input.payload.definitions,
    flagDefinitions: input.payload.flagDefinitions,
    coins: [],
  })
  assert.deepEqual(report.coins.map(coin => coin.symbol), ["SOL", "MINA", "COTI"])
  assert.deepEqual(report.coins.map(coin => coin.topRank), [2, null, 1])
  assert.deepEqual(report.coins.map(coin => coin.explanation), ["Выбор SOL", "", "Выбор COTI"])
  assert.deepEqual(requestedPaths, ["SOL", "MINA", "COTI"].map(symbol => path.join(
    "step2-data-bootstrap", `${symbol}--XTVC${symbol}`, "data.json",
  )))

  for (const [index, { history, ...coin }] of report.coins.entries()) {
    const candidate = input.payload.candidates.find(candidate => candidate.symbol === coin.symbol)

    assert.deepEqual(coin, {
      ...input.analysis.assessments[index],
      explanation: input.analysis.topCandidates.find(top => top.symbol === coin.symbol)?.explanation ?? "",
      topRank: [2, null, 1][index],
      name: `Coin ${coin.symbol}`,
      marketSymbol: `BINANCE:${coin.symbol}USDT.P`,
      features: {
        volumeZ: candidate.volume[0],
        symbol: candidate.symbol,
        name: candidate.name,
        quietOi: candidate.derivatives[0],
        flags: candidate.flags,
        socialZ: candidate.social[0],
      },
    })
    assert.ok(!Object.hasOwn(coin.features, "selectionRank"))
    assert.equal(history.warning, null)
    assert.equal(history.candles.length, 168)
    assert.equal(history.volume.length, 168)
    assert.equal(history.openInterest.length, 168)
  }

  assert.deepEqual([input.analysis, input.payload, input.shortlist, input.histories], before)
})

for (const background of [
  { status: "up", change4hPct: 0.000000001, breadth4h: 0.550000001, warning: null },
  { status: "down", change4hPct: -0.000000001, breadth4h: 0.449999999, warning: null },
  { status: "mixed", change4hPct: 1.23456789, breadth4h: 0.55, warning: null },
  { status: "unavailable", change4hPct: null, breadth4h: 0.6, warning: "TOTAL3ES недоступен" },
  null,
]) {
  test(`report copies the saved ${background?.status ?? "legacy"} background without raw market reads`, async () => {
    const input = createInput([])
    input.payload.marketContext.altMarketBackground = background
    const before = structuredClone(input.payload)
    const report = await build(input, () => assert.fail("No raw data should be read"))

    assert.deepEqual(report.altMarketBackground, background)
    assert.deepEqual(input.payload, before)
  })
}

test("keeps exactly the last 168 clock hours, maps OHLC, sorts and deduplicates without future data", async () => {
  const input = createInput()
  const data = input.histories[0]
  const original = structuredClone(data.chart.periods)
  const duplicate = { ...original[12], open: 20, max: 22, min: 19, close: 21, volume: 432 }
  data.chart.periods = [
    { ...original[0], time: original[0].time - 3_600 },
    ...original.toReversed(),
    { ...original.at(-1), time: original.at(-1).time + 3_600 },
    duplicate,
  ]
  data.studies.openInterest.periods = [
    ...data.studies.openInterest.periods.toReversed(),
    { time: original.at(-1).time + 3_600, close: 999_999 },
    { time: duplicate.time, close: 321 },
  ]

  const { history } = (await build(input)).coins[0]

  assert.deepEqual(history.candles.map(candle => candle.time), original.map(period => period.time))
  assert.deepEqual(history.candles[0], {
    time: original[0].time, open: 100, high: 102, low: 99, close: 101,
  })
  assert.deepEqual(history.candles.at(-1), {
    time: original.at(-1).time, open: 267, high: 269, low: 266, close: 268,
  })
  assert.deepEqual(history.candles[12], {
    time: duplicate.time, open: 20, high: 22, low: 19, close: 21,
  })
  assert.deepEqual(history.volume[12], { time: duplicate.time, value: 432 })
  assert.deepEqual(history.openInterest[12], { time: duplicate.time, value: 321 })
  assert.deepEqual(history.openInterest.at(-1), { time: original.at(-1).time, value: 10_167 })
  assert.deepEqual(history.volume.map(point => point.time), original.map(period => period.time))
  assert.deepEqual(history.openInterest.map(point => point.time), original.map(period => period.time))
  assert.match(history.warning, /дубликаты/)
  assert.doesNotMatch(history.warning, /Неполная неделя/)
})

test("keeps tiny prices without tick metadata and uses whitespace for missing OI or invalid volume", async () => {
  const input = createInput()
  const data = input.histories[0]
  delete data.studies

  for (const period of data.chart.periods) {
    for (const field of ["open", "max", "min", "close"]) {
      period[field] *= 1e-14
    }
  }

  for (const [index, value] of [0, undefined, null, -1, NaN, Infinity, "12"].entries()) {
    data.chart.periods[index].volume = value
  }

  const { history } = (await build(input)).coins[0]

  assert.equal(history.candles.length, 168)
  assert.equal(history.candles[0].open, data.chart.periods[0].open)
  assert.equal(history.candles[0].high, data.chart.periods[0].max)
  assert.equal(history.candles[0].low, data.chart.periods[0].min)
  assert.equal(history.candles[0].close, data.chart.periods[0].close)
  assert.ok(history.candles[0].open > 0 && history.candles[0].open < 1e-10)
  assert.deepEqual(history.volume[0], { time: data.chart.periods[0].time, value: 0 })
  assert.deepEqual(history.volume.slice(1, 7), data.chart.periods.slice(1, 7).map(({ time }) => ({ time })))
  assert.deepEqual(history.openInterest, history.candles.map(({ time }) => ({ time })))
  assert.match(history.warning, /Объём/)
  assert.match(history.warning, /Open Interest/)
  assert.doesNotMatch(history.warning, /OHLC|Неполная неделя/)
  assert.deepEqual(JSON.parse(JSON.stringify(history)), history)
})

test("aligns OI by candle time and never fills gaps from nearby or future values", async () => {
  const input = createInput()
  const data = input.histories[0]
  const times = data.chart.periods.map(period => period.time)
  data.studies.openInterest.periods = [
    { time: times[9], close: 123 },
    ...[0, undefined, null, -1, NaN, Infinity, "12"].map((close, index) => ({ time: times[index], close })),
    { time: times.at(-1) + 3_600, close: 999 },
    { time: times[8] + 60, close: 456 },
    { time: "invalid", close: 456 },
  ]

  const { history } = (await build(input)).coins[0]

  assert.deepEqual(history.openInterest, times.map((time, index) => {
    if (index === 0 || index === 9) {
      return { time, value: index === 0 ? 0 : 123 }
    }

    return { time }
  }))
  assert.match(history.warning, /Open Interest/)
  assert.match(history.warning, /часовой сетки/)
  assert.match(history.warning, /отметки времени/)
  assert.equal(history.candles.length, 168)
})

test("omits missing or invalid candles without reaching outside the clock window", async () => {
  const input = createInput()
  const data = input.histories[0]
  const original = structuredClone(data.chart.periods)
  const omittedTimes = original.slice(1, 12).map(period => period.time)
  data.chart.periods[1] = null
  data.chart.periods[2].open = null
  data.chart.periods[3].max = 1
  data.chart.periods[4].min = 1_000
  data.chart.periods[5].close = NaN
  data.chart.periods[6].open = Infinity
  data.chart.periods[7].min = 0
  data.chart.periods[8].close = -1
  data.chart.periods[9].open = "109"
  data.chart.periods[10].time += 60
  data.chart.periods.splice(11, 1)
  data.chart.periods.unshift({ ...original[0], time: original[0].time - 3_600 })

  const { history } = (await build(input)).coins[0]
  const expectedTimes = original.map(period => period.time).filter(time => !omittedTimes.includes(time))

  assert.deepEqual(history.candles.map(candle => candle.time), expectedTimes)
  assert.deepEqual(history.volume.map(point => point.time), expectedTimes)
  assert.deepEqual(history.openInterest.map(point => point.time), expectedTimes)
  assert.match(history.warning, /157 из 168/)
  assert.match(history.warning, /OHLC/)
  assert.match(history.warning, /часовой сетки/)
  assert.match(history.warning, /отметки времени/)
})

test("shows a short but current history honestly", async () => {
  const input = createInput()
  input.histories[0].chart.periods = input.histories[0].chart.periods.slice(-3)

  const { history } = (await build(input)).coins[0]

  assert.equal(history.candles.length, 3)
  assert.equal(history.volume.length, 3)
  assert.equal(history.openInterest.length, 3)
  assert.equal(history.candles.at(-1).time, Date.parse(input.analysis.asOf) / 1_000)
  assert.match(history.warning, /Неполная неделя: 3 из 168/)
})

test("accepts an empty candidate set without reading any raw files", async () => {
  const input = createInput([])
  const report = await build(input, async () => assert.fail("Unexpected history read"))

  assert.equal(report.asOf, input.analysis.asOf)
  assert.equal(report.candidateCount, 0)
  assert.equal(report.universeCoinCount, 20)
  assert.deepEqual(report.coins, [])
})

test("uses empty explanations when the top candidate has none", async () => {
  const input = createInput()
  delete input.analysis.topCandidates[0].explanation

  const { explanation, topRank } = (await build(input)).coins[0]

  assert.equal(explanation, "")
  assert.equal(topRank, 1)
})

test("rejects mismatched or non-hourly snapshots before loading history", async (t) => {
  for (const source of ["analysis", "payload", "shortlist"]) {
    await t.test(source, async () => {
      const input = createInput()
      input[source].asOf = "2026-09-15T08:00:00.000Z"
      let readCount = 0

      await assert.rejects(build(input, async () => {
        readCount += 1
      }), /same closed hourly snapshot/)
      assert.equal(readCount, 0)
    })
  }

  for (const asOf of [null, "invalid", "2026-09-15T09:30:00.000Z", "2026-09-15T09:00:00.001Z"]) {
    await t.test(String(asOf), async () => {
      const input = createInput()

      for (const source of [input.analysis, input.payload, input.shortlist]) {
        source.asOf = asOf
      }

      await assert.rejects(build(input), /same closed hourly snapshot/)
    })
  }

  for (const source of ["payload", "shortlist"]) {
    await t.test(`${source} timeframe`, async () => {
      const input = createInput()
      input[source].timeframe = "4h"
      await assert.rejects(build(input), /same closed hourly snapshot/)
    })
  }
})

test("rejects incorrect candidate and universe counts", async (t) => {
  for (const source of ["analysis", "payload", "shortlist"]) {
    await t.test(source, async () => {
      const input = createInput()
      input[source].candidateCount += 1
      await assert.rejects(build(input), /candidate count/)
    })
  }

  for (const universeCoinCount of [0, -1, 1.5, undefined]) {
    await t.test(`universe ${universeCoinCount}`, async () => {
      const input = createInput()
      input.shortlist.universeCoinCount = universeCoinCount
      await assert.rejects(build(input), /universe coin count/)
    })
  }
})

test("rejects different candidate sets, duplicates and unknown top members", async (t) => {
  for (const [name, change, message] of [
    ["assessment set", (input) => {
      input.analysis.assessments[0].symbol = "OTHER"
    }, /candidate sets/],
    ["payload set", (input) => {
      input.payload.candidates[0].symbol = "OTHER"
    }, /candidate sets/],
    ["shortlist set", (input) => {
      input.shortlist.candidates[0].coin.symbol = "OTHER"
    }, /candidate sets/],
    ["shorter set", (input) => {
      input.analysis.assessments.pop()
      input.analysis.candidateCount -= 1
    }, /candidate sets/],
    ["duplicate assessments", (input) => {
      input.analysis.assessments[1] = input.analysis.assessments[0]
    }, /duplicate symbols/],
    ["duplicate payload candidates", (input) => {
      input.payload.candidates[1] = input.payload.candidates[0]
    }, /duplicate symbols/],
    ["duplicate shortlist", (input) => {
      input.shortlist.candidates[1] = input.shortlist.candidates[0]
    }, /duplicate symbols/],
    ["duplicate top", (input) => {
      input.analysis.topCandidates[1] = input.analysis.topCandidates[0]
    }, /duplicate symbols/],
    ["unknown top", (input) => {
      input.analysis.topCandidates[0].symbol = "OTHER"
    }, /must belong to assessments/],
    ["missing symbol", (input) => {
      delete input.analysis.assessments[0].symbol
    }, /invalid symbol/],
    ["missing assessments", (input) => {
      delete input.analysis.assessments
    }, /must be an array/],
    ["missing candidates", (input) => {
      delete input.shortlist.candidates
    }, /must be an array/],
    ["missing top", (input) => {
      delete input.analysis.topCandidates
    }, /must be an array/],
  ]) {
    await t.test(name, async () => {
      const input = createInput(["COTI", "SOL"])
      change(input)
      let readCount = 0

      await assert.rejects(build(input, async () => {
        readCount += 1
      }), message)
      assert.equal(readCount, 0)
    })
  }
})

test("rejects ambiguous schemas, malformed groups and missing coin metadata", async (t) => {
  for (const [name, change, message] of [
    ["missing schema", (input) => {
      delete input.payload.schema
    }, /Step 6 schema/],
    ["positional schema", (input) => {
      input.payload.schema = ["symbol", "volumeZ"]
    }, /Step 6 schema/],
    ["invalid schema group", (input) => {
      input.payload.schema.volume = null
    }, /Step 6 schema/],
    ["duplicate field within group", (input) => {
      input.payload.schema.volume.push("volumeZ")
    }, /Step 6 schema/],
    ["duplicate field across groups", (input) => {
      input.payload.schema.social[0] = "volumeZ"
    }, /Step 6 schema/],
    ...["symbol", "name", "selectionRank", "flags"].map(field => [
      `reserved ${field} field`, (input) => {
        input.payload.schema.volume[0] = field
      }, /Step 6 schema/,
    ]),
    ...[null, "", "  ", 1].map(field => [
      `invalid field ${String(field)}`, (input) => {
        input.payload.schema.volume[0] = field
      }, /Step 6 schema/,
    ]),
    ["short group", (input) => {
      input.payload.candidates[0].volume.pop()
    }, /Step 6 candidate.*schema length/],
    ["long group", (input) => {
      input.payload.candidates[0].volume.push(1)
    }, /Step 6 candidate.*schema length/],
    ["invalid group", (input) => {
      input.payload.candidates[0].volume = null
    }, /Step 6 candidate.*schema length/],
    ["missing group", (input) => {
      delete input.payload.candidates[0].volume
    }, /Step 6 candidate.*schema length/],
    ["extra group", (input) => {
      input.payload.candidates[0].unknown = []
    }, /Step 6 candidate.*schema length/],
    ["positional candidate", (input) => {
      input.payload.candidates[0] = [0.1, "COTI", "Payload COTI", false, ["coiling"], null]
    }, /Step 6 candidate.*schema length/],
    ["shortlist metadata", (input) => {
      delete input.shortlist.candidates[0].coin.marketSymbol
    }, /coin metadata/],
  ]) {
    await t.test(name, async () => {
      const input = createInput()
      change(input)
      await assert.rejects(build(input, async () => assert.fail("Unexpected history read")), message)
    })
  }
})

test("rejects missing candidate metadata", async (t) => {
  for (const field of ["symbol", "name", "selectionRank", "flags"]) {
    await t.test(field, async () => {
      const input = createInput()
      delete input.payload.candidates[0][field]
      await assert.rejects(build(input), /Step 6 candidate/)
    })
  }
})

test("rejects invalid candidate metadata", async (t) => {
  for (const [field, values] of [
    ["symbol", [null, "", "  ", 1]],
    ["name", [null, "", "  ", 1]],
    ["selectionRank", [null, 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, "1"]],
    ["flags", [null, "coiling", {}]],
  ]) {
    for (const value of values) {
      await t.test(`${field}: ${String(value)}`, async () => {
        const input = createInput()
        input.payload.candidates[0][field] = value
        await assert.rejects(build(input), /Step 6 candidate/)
      })
    }
  }
})

test("keeps assessments after raw read failures or missing files and continues to the next coin", async (t) => {
  for (const [name, readFailure, message] of [
    ["read failure", async () => {
      throw new Error("ENOENT: missing data.json")
    }, /ENOENT/],
    ["parse failure", async () => {
      throw new SyntaxError("Invalid JSON")
    }, /Invalid JSON/],
    ["non-Error failure", async () => {
      throw null
    }, /не удалось прочитать данные/],
    ["missing data", async () => undefined, /не совпадают/],
  ]) {
    await t.test(name, async () => {
      const input = createInput(["COTI", "SOL"])
      let readCount = 0
      const report = await build(input, async (relativePath) => {
        readCount += 1
        return readCount === 1 ? readFailure() : input.readCoinData(relativePath)
      })

      assert.equal(readCount, 2)
      assert.equal(report.coins.length, 2)
      assert.equal(report.coins[0].symbol, "COTI")
      assert.equal(report.coins[0].movementProbability, input.analysis.assessments[0].movementProbability)
      assert.equal(report.coins[0].explanation, input.analysis.topCandidates[0].explanation)
      assert.deepEqual(report.coins[0].history, {
        candles: [], volume: [], openInterest: [], warning: report.coins[0].history.warning,
      })
      assert.match(report.coins[0].history.warning, message)
      assert.equal(report.coins[1].history.warning, null)
      assert.equal(report.coins[1].history.candles.length, 168)
    })
  }
})

test("warns instead of plotting stale, missing or mismatched raw history", async (t) => {
  for (const [name, change, message] of [
    ["wrong symbol", (data) => {
      data.coin.symbol = "OTHER"
    }, /не совпадают/],
    ["wrong base currency", (data) => {
      data.coin.baseCurrencyId = "OTHER"
    }, /не совпадают/],
    ["wrong market", (data) => {
      data.coin.marketSymbol = "OTHER:COTIUSD"
    }, /не совпадают/],
    ["wrong chart market", (data) => {
      data.chart.info.fullName = "OTHER:COTIUSD"
    }, /не совпадают/],
    ["wrong timeframe", (data) => {
      data.timeframe = "4h"
    }, /интервал 1h/],
    ["missing chart", (data) => {
      delete data.chart
    }, /свечи отсутствуют/],
    ["empty chart", (data) => {
      data.chart.periods = []
    }, /свечи отсутствуют/],
    ["stale chart", (data) => {
      data.chart.periods.pop()
    }, /на asOf/],
    ["future without asOf", (data) => {
      data.chart.periods.push({ ...data.chart.periods.pop(), time: data.chart.periods.at(-1).time + 7_200 })
    }, /на asOf/],
    ["invalid asOf OHLC", (data) => {
      data.chart.periods.at(-1).close = null
    }, /на asOf/],
  ]) {
    await t.test(name, async () => {
      const input = createInput(["COTI", "SOL"])
      const data = input.histories[0]
      change(data)
      let readCount = 0
      const report = await build(input, async (relativePath) => {
        readCount += 1
        return readCount === 1 ? data : input.readCoinData(relativePath)
      })

      assert.equal(report.coins[0].symbol, "COTI")
      assert.deepEqual(report.coins[0].history, {
        candles: [], volume: [], openInterest: [], warning: report.coins[0].history.warning,
      })
      assert.match(report.coins[0].history.warning, message)
      assert.equal(report.coins[1].history.warning, null)
      assert.equal(readCount, 2)
    })
  }
})
