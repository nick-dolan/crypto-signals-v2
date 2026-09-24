import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { promisify } from "node:util"

import {
  createBootstrapDataRelativePath,
  createBootstrapHourlyData,
} from "../src/steps/step2-data-bootstrap/check-coin-data-coverage.js"
import { buildPeerRadarHistories } from "../src/steps/step13-report/build-peer-radar-histories.js"

function createCoin (symbol = "TARGET", marketSymbol = `BINANCE:${symbol}USDT.P`) {
  return { baseCurrencyId: `XTVC${symbol}`, symbol, marketSymbol }
}

function leaderReference ({ baseCurrencyId, symbol }) {
  return { baseCurrencyId, symbol }
}

function createReport (observations) {
  return {
    asOf: "2026-09-24T06:00:00.000Z",
    snapshotClosedAt: "2026-09-24T07:00:00.000Z",
    timeframe: "1h",
    observations: observations ?? [{
      coin: createCoin(),
      verdict: "watch",
      leaders: [leaderReference(createCoin("LEADER"))],
    }],
  }
}

function createBootstrap (coin, data = createReport()) {
  return createBootstrapHourlyData({
    chart: {
      info: { fullName: coin.marketSymbol, baseCurrencyId: coin.baseCurrencyId },
      periods: Array.from({ length: 169 }, (_, index) => ({
        time: Date.parse(data.asOf) / 1_000 - (168 - index) * 3_600,
        close: 100 + index,
      })),
    },
    studies: {},
  }, {
    ...coin,
    name: coin.symbol,
    tradingViewSymbol: `CRYPTO:${coin.symbol}USD`,
    market: { tradingViewSymbol: coin.marketSymbol },
  }, {
    fetchHours: 169,
    nowTimestamp: Date.parse(data.snapshotClosedAt) / 1_000,
    socialCoverage: { status: "unavailable" },
  })
}

function createReader (entries, requested = []) {
  const files = new Map(entries.map(([coin, source]) => [createBootstrapDataRelativePath(coin), source]))
  return async (filename) => {
    requested.push(filename)
    if (!files.has(filename)) {
      throw Object.assign(new Error("Missing bootstrap file"), { code: "ENOENT" })
    }
    return files.get(filename)
  }
}

async function loadCandidate (source, data = createReport()) {
  const leader = createCoin("LEADER", "OKX:LEADERUSDT.P")
  return buildPeerRadarHistories(data, {
    readCoinData: createReader([
      [data.observations[0].coin, source],
      [leader, createBootstrap(leader)],
    ]),
  })
}

function assertHealthyLeader (histories) {
  assert.equal(histories.XTVCLEADER.marketSymbol, "OKX:LEADERUSDT.P")
  assert.equal(histories.XTVCLEADER.points.length, 169)
  assert.equal(histories.XTVCLEADER.warning, null)
}

test("reads every candidate and outsider leader once from saved bootstrap files, including limited candidates", { timeout: 20_000 }, async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "peer-radar-histories-"))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  const target = createCoin()
  const shared = createCoin("SHARED", "BYBIT:SHAREDUSDT.P")
  const outsider = createCoin("OUTSIDER", "OKX:OUTSIDERUSDT.P")
  const limited = createCoin("LIMITED", "KRAKEN:LIMITEDUSD")
  const data = createReport([
    { coin: target, verdict: "watch", leaders: [leaderReference(shared), leaderReference(outsider)] },
    { coin: shared, verdict: "limited", leaders: [leaderReference(target), leaderReference(outsider)] },
    { coin: limited, verdict: "limited", leaders: [leaderReference(outsider), leaderReference(shared)] },
  ])
  const before = structuredClone(data)
  const coins = [target, shared, outsider, limited]
  await Promise.all(coins.map(async (coin) => {
    const filename = path.join(directory, "tmp", createBootstrapDataRelativePath(coin))
    await fs.mkdir(path.dirname(filename), { recursive: true })
    await fs.writeFile(filename, JSON.stringify(createBootstrap(coin, data)))
  }))
  const requested = []
  const histories = await buildPeerRadarHistories(data, {
    readCoinData: async (filename) => {
      requested.push(filename)
      return JSON.parse(await fs.readFile(path.join(directory, "tmp", filename), "utf8"))
    },
  })

  assert.deepEqual(requested.sort(), coins.map(createBootstrapDataRelativePath).sort())
  assert.deepEqual(Object.keys(histories).sort(), coins.map(coin => coin.baseCurrencyId).sort())
  for (const coin of coins) {
    assert.deepEqual(histories[coin.baseCurrencyId], {
      ...coin,
      points: createBootstrap(coin, data).chart.periods.map(period => ({ time: period.time + 3_600, value: period.close })),
      warning: null,
    })
  }
  assert.deepEqual(data, before)
  assert.deepEqual(JSON.parse(JSON.stringify(histories)), histories)

  await fs.writeFile(path.join(directory, "radar.json"), JSON.stringify(data))
  const { stdout } = await promisify(execFile)(process.execPath, ["--input-type=module", "--eval", `
    import fs from "node:fs/promises"
    import { buildPeerRadarHistories } from ${JSON.stringify(new URL("../src/steps/step13-report/build-peer-radar-histories.js", import.meta.url).href)}
    const data = JSON.parse(await fs.readFile("radar.json", "utf8"))
    process.stdout.write(JSON.stringify(await buildPeerRadarHistories(data)))
  `], { cwd: directory, timeout: 10_000 })
  assert.deepEqual(JSON.parse(stdout), histories)
})

test("keeps a candidate's expected market when that ID first appears as a leader", async () => {
  const target = createCoin()
  const shared = createCoin("SHARED", "BYBIT:SHAREDUSDT.P")
  const data = createReport([
    { coin: target, leaders: [leaderReference(shared)] },
    { coin: shared, leaders: [leaderReference(target)] },
  ])
  const requested = []
  const histories = await buildPeerRadarHistories(data, {
    readCoinData: createReader([
      [target, createBootstrap(target)],
      [shared, createBootstrap({ ...shared, marketSymbol: "BINANCE:SHAREDUSDT.P" })],
    ], requested),
  })

  assert.equal(requested.length, 2)
  assert.equal(histories.XTVCTARGET.warning, null)
  assert.equal(histories.XTVCSHARED.marketSymbol, shared.marketSymbol)
  assert.deepEqual(histories.XTVCSHARED.points, [])
  assert.match(histories.XTVCSHARED.warning, /рынок.*не совпадает/)
})

test("uses one sorted 169-close UTC window and clips older, current and future candles without mutating inputs", async () => {
  const data = createReport()
  const source = createBootstrap(createCoin(), data)
  const leader = createCoin("LEADER", "OKX:LEADERUSDT.P")
  const leaderSource = createBootstrap(leader, data)
  const expected = source.chart.periods.map(period => ({ time: period.time + 3_600, value: period.close }))
  source.chart.periods.push(
    { time: source.chart.periods[0].time - 3_600, close: 999 },
    { time: Date.parse(data.snapshotClosedAt) / 1_000, close: 999 },
    { time: Date.parse(data.asOf) / 1_000 + 24 * 3_600, close: 999 },
  )
  source.chart.periods.reverse()
  leaderSource.chart.periods = leaderSource.chart.periods.slice(10, -1).reverse()
  const before = structuredClone([data, source, leaderSource])
  const histories = await buildPeerRadarHistories(data, {
    readCoinData: createReader([[createCoin(), source], [leader, leaderSource]]),
  })

  assert.deepEqual(histories.XTVCTARGET.points, expected)
  assert.equal(histories.XTVCTARGET.warning, null)
  assert.equal(expected[0].time, Date.parse(data.snapshotClosedAt) / 1_000 - 168 * 3_600)
  assert.equal(expected.at(-1).time, Date.parse(data.snapshotClosedAt) / 1_000)
  assert.equal(histories.XTVCLEADER.points.length, 169)
  assert.deepEqual(histories.XTVCLEADER.points.map(point => point.time), expected.map(point => point.time))
  assert.deepEqual(histories.XTVCLEADER.points[0], { time: expected[0].time })
  assert.deepEqual(histories.XTVCLEADER.points.at(-1), { time: expected.at(-1).time })
  assert.match(histories.XTVCLEADER.warning, /11 из 169/)
  assert.deepEqual([data, source, leaderSource], before)
})

test("missing anchors, internal and final hours and invalid closes remain whitespace, never zero or forward-filled", async () => {
  const source = createBootstrap(createCoin())
  const missing = new Set([0, 60, 168])
  for (const [index, value] of [undefined, null, 0, -1, NaN, Infinity, -Infinity, "12", true, {}, []].entries()) {
    source.chart.periods[index + 10].close = value
    missing.add(index + 10)
  }
  source.chart.periods[1].close = Number.MIN_VALUE
  source.chart.periods[167].close = Number.MAX_VALUE
  const expected = source.chart.periods.map((period, index) => (
    missing.has(index) ? { time: period.time + 3_600 } : { time: period.time + 3_600, value: period.close }
  ))
  source.chart.periods = source.chart.periods.filter((_, index) => ![0, 60, 168].includes(index))
  const histories = await loadCandidate(source)

  assert.deepEqual(histories.XTVCTARGET.points, expected)
  assert.match(histories.XTVCTARGET.warning, /14 из 169/)
  assertHealthyLeader(histories)
})

test("an empty or entirely nonpositive price series preserves the common grid with a warning", async () => {
  for (const periods of [[], createBootstrap(createCoin()).chart.periods.map(period => ({ ...period, close: 0 }))]) {
    const source = createBootstrap(createCoin())
    source.chart.periods = periods
    const histories = await loadCandidate(source)
    assert.deepEqual(histories.XTVCTARGET.points, createBootstrap(createCoin()).chart.periods.map(period => ({ time: period.time + 3_600 })))
    assert.match(histories.XTVCTARGET.warning, /169 из 169/)
    assertHealthyLeader(histories)
  }
})

test("only positive closes are needed; OHLC, volume, derivatives and social data are not required", async () => {
  for (const info of [undefined, null, {}, { fullName: null, baseCurrencyId: null }]) {
    const source = createBootstrap(createCoin())
    delete source.studies
    delete source.availability
    source.chart.info = info
    const histories = await loadCandidate(source)
    assert.equal(histories.XTVCTARGET.points.length, 169)
    assert.equal(histories.XTVCTARGET.warning, null)
    assertHealthyLeader(histories)
  }
})

for (const [name, change, warning] of [
  ["missing coin", source => source.coin = null, /формат/],
  ["missing chart", source => source.chart = null, /формат/],
  ["missing periods", source => delete source.chart.periods, /формат/],
  ["non-array periods", source => source.chart.periods = {}, /формат/],
  ["invalid chart info", source => source.chart.info = [], /формат/],
  ["wrong timeframe", source => source.timeframe = "4h", /таймфрейм/],
  ["missing timeframe", source => delete source.timeframe, /таймфрейм/],
  ["wrong ID", source => source.coin.baseCurrencyId = "OTHER", /ID или символ/],
  ["wrong symbol", source => source.coin.symbol = "OTHER", /ID или символ/],
  ["missing symbol", source => delete source.coin.symbol, /ID или символ/],
  ["different market", source => source.coin.marketSymbol = "BYBIT:TARGETUSDT.P", /рынок.*не совпадает/],
  ["missing market", source => delete source.coin.marketSymbol, /не указан рынок/],
  ["blank market", source => source.coin.marketSymbol = "  ", /не указан рынок/],
  ["inconsistent full symbol", source => source.chart.info.fullName = "BYBIT:TARGETUSDT.P", /метаданные графика/],
  ["invalid full symbol", source => source.chart.info.fullName = 123, /метаданные графика/],
  ["inconsistent chart ID", source => source.chart.info.baseCurrencyId = "OTHER", /метаданные графика/],
]) {
  test(`rejects bootstrap ${name} for only the affected coin`, async () => {
    const source = createBootstrap(createCoin())
    change(source)
    const histories = await loadCandidate(source)
    assert.deepEqual(histories.XTVCTARGET.points, [])
    assert.equal(histories.XTVCTARGET.marketSymbol, "BINANCE:TARGETUSDT.P")
    assert.match(histories.XTVCTARGET.warning, warning)
    assert.match(histories.XTVCTARGET.warning, /История TARGET недоступна/)
    assertHealthyLeader(histories)
  })
}

test("malformed root data is isolated rather than rejecting the radar", async () => {
  for (const source of [null, undefined, [], "bad data", 123]) {
    const histories = await loadCandidate(source)
    assert.deepEqual(histories.XTVCTARGET.points, [])
    assert.match(histories.XTVCTARGET.warning, /формат/)
    assertHealthyLeader(histories)
  }
})

test("an outsider leader gets no guessed market when file identity or market metadata cannot be verified", async () => {
  for (const change of [
    source => source.coin.baseCurrencyId = "OTHER",
    source => source.coin.symbol = "OTHER",
    source => delete source.coin.marketSymbol,
    source => source.chart.info.fullName = "BINANCE:LEADERUSDT.P",
    source => source.chart.info.baseCurrencyId = "OTHER",
  ]) {
    const leader = createCoin("LEADER", "OKX:LEADERUSDT.P")
    const source = createBootstrap(leader)
    change(source)
    const histories = await buildPeerRadarHistories(createReport(), {
      readCoinData: createReader([[createCoin(), createBootstrap(createCoin())], [leader, source]]),
    })
    assert.equal(histories.XTVCTARGET.warning, null)
    assert.deepEqual(histories.XTVCLEADER.points, [])
    assert.equal(histories.XTVCLEADER.marketSymbol, null)
    assert.match(histories.XTVCLEADER.warning, /История LEADER недоступна/)
  }
})

for (const [name, change] of [
  ["duplicate", periods => periods.push({ ...periods[84] })],
  ["conflicting duplicate", periods => periods.push({ ...periods[84], close: 999 })],
  ["duplicate without a close", periods => periods.push({ time: periods[84].time })],
  ["off-grid", periods => periods[84].time += 1],
  ["fractional", periods => periods[84].time += 0.5],
  ["numeric string", periods => periods[84].time = String(periods[84].time)],
  ["ISO string", periods => periods[84].time = new Date(periods[84].time * 1_000).toISOString()],
  ["null", periods => periods[84].time = null],
  ["missing", periods => delete periods[84].time],
  ["NaN", periods => periods[84].time = NaN],
  ["infinite", periods => periods[84].time = Infinity],
  ["unsafe integer", periods => periods[84].time = Number.MAX_SAFE_INTEGER + 1],
  ["invalid period", periods => periods[84] = null],
  ["array period", periods => periods[84] = []],
  ["off-grid before the window", periods => periods.push({ time: periods[0].time - 3_601, close: 1 })],
  ["duplicate after the snapshot", periods => periods.push(
    { time: periods.at(-1).time + 3_600, close: 1 },
    { time: periods.at(-1).time + 3_600, close: 2 },
  )],
]) {
  test(`rejects ${name} timestamps without rounding or choosing an arbitrary candle`, async () => {
    const source = createBootstrap(createCoin())
    change(source.chart.periods)
    const histories = await loadCandidate(source)
    assert.deepEqual(histories.XTVCTARGET.points, [])
    assert.match(histories.XTVCTARGET.warning, /временн/)
    assertHealthyLeader(histories)
  })
}

test("conflicting symbols for the same ID do not select a series in either reference order", async () => {
  const target = createCoin()
  const shared = createCoin("SHARED")
  for (const observations of [
    [{ coin: target, leaders: [leaderReference(shared)] }, { coin: { ...shared, symbol: "RENAMED" }, leaders: [leaderReference(target)] }],
    [{ coin: target, leaders: [leaderReference(shared), { ...leaderReference(shared), symbol: "RENAMED" }] }],
  ]) {
    for (const ordered of [observations, [...observations].reverse()]) {
      const requested = []
      const histories = await buildPeerRadarHistories(createReport(ordered), {
        readCoinData: createReader([[target, createBootstrap(target)], [shared, createBootstrap(shared)]], requested),
      })
      assert.deepEqual(requested, [createBootstrapDataRelativePath(target)])
      assert.equal(histories.XTVCTARGET.warning, null)
      assert.deepEqual(histories.XTVCSHARED.points, [])
      assert.match(histories.XTVCSHARED.warning, /противоречивые/)
    }
  }
})

test("conflicting known markets for one ID do not silently choose the first market", async () => {
  const target = createCoin()
  const data = createReport([
    { coin: target, leaders: [leaderReference(createCoin("LEADER"))] },
    { coin: { ...target, marketSymbol: "BYBIT:TARGETUSDT.P" }, leaders: [] },
  ])
  const histories = await loadCandidate(createBootstrap(target), data)
  assert.deepEqual(histories.XTVCTARGET.points, [])
  assert.equal(histories.XTVCTARGET.marketSymbol, null)
  assert.match(histories.XTVCTARGET.warning, /противоречивые/)
  assertHealthyLeader(histories)
})

test("read, JSON and unexpected errors leave other coins available", async () => {
  for (const error of [
    Object.assign(new Error("File missing"), { code: "ENOENT" }),
    Object.assign(new Error("Permission denied"), { code: "EACCES" }),
    new SyntaxError("Invalid JSON"),
    "unexpected failure",
    null,
  ]) {
    const requested = []
    const leader = createCoin("LEADER", "OKX:LEADERUSDT.P")
    const histories = await buildPeerRadarHistories(createReport(), {
      readCoinData: (filename) => {
        requested.push(filename)
        if (filename === createBootstrapDataRelativePath(createCoin())) {
          throw error
        }
        return Promise.resolve(createBootstrap(leader))
      },
    })
    assert.equal(requested.length, 2)
    assert.deepEqual(histories.XTVCTARGET.points, [])
    assert.match(histories.XTVCTARGET.warning, /История TARGET недоступна/)
    assertHealthyLeader(histories)
  }
  const histories = await buildPeerRadarHistories(createReport(), {
    readCoinData: createReader([[createCoin(), createBootstrap(createCoin())]]),
  })
  assert.equal(histories.XTVCTARGET.warning, null)
  assert.equal(histories.XTVCLEADER.marketSymbol, null)
  assert.deepEqual(histories.XTVCLEADER.points, [])
  assert.match(histories.XTVCLEADER.warning, /История LEADER недоступна/)
})

test("prototype-like and path-like IDs remain safe dictionary keys and use the bootstrap path helper", async () => {
  const coins = ["__proto__", "constructor", "toString", "hasOwnProperty", "../../outside", "bad/id", "bad\\id"].map((baseCurrencyId, index) => ({
    ...createCoin(index === 4 ? "../T:AR/GET?" : `COIN${index}`), baseCurrencyId,
  }))
  const data = createReport(coins.map(coin => ({ coin, leaders: [leaderReference(coins[0])] })))
  const requested = []
  const histories = await buildPeerRadarHistories(data, {
    readCoinData: createReader(coins.map(coin => [coin, createBootstrap(coin)]), requested),
  })

  assert.equal(Object.getPrototypeOf(histories), Object.prototype)
  assert.equal(requested.length, coins.length)
  for (const coin of coins) {
    assert.ok(Object.hasOwn(histories, coin.baseCurrencyId))
    assert.equal(histories[coin.baseCurrencyId].baseCurrencyId, coin.baseCurrencyId)
    assert.equal(histories[coin.baseCurrencyId].warning, null)
    assert.equal(histories[coin.baseCurrencyId].points.length, 169)
  }
  for (const filename of requested) {
    assert.equal(path.isAbsolute(filename), false)
    assert.equal(path.dirname(path.dirname(filename)), "step2-data-bootstrap")
    assert.equal(path.basename(filename), "data.json")
  }
  assert.deepEqual(requested.sort(), coins.map(createBootstrapDataRelativePath).sort())
  assert.deepEqual(JSON.parse(JSON.stringify(histories)), histories)
})

test("sanitized path collisions cannot substitute a different coin's series", async () => {
  const first = { ...createCoin(), baseCurrencyId: "coin/a" }
  const second = { ...first, baseCurrencyId: "coin\\a" }
  assert.equal(createBootstrapDataRelativePath(first), createBootstrapDataRelativePath(second))
  const requested = []
  const histories = await buildPeerRadarHistories(createReport([{ coin: first, leaders: [leaderReference(second)] }]), {
    readCoinData: createReader([[first, createBootstrap(first)]], requested),
  })
  assert.equal(requested.length, 2)
  assert.equal(histories[first.baseCurrencyId].warning, null)
  assert.deepEqual(histories[second.baseCurrencyId].points, [])
  assert.equal(histories[second.baseCurrencyId].marketSymbol, null)
  assert.match(histories[second.baseCurrencyId].warning, /ID или символ/)
})

test("unusable path segments fail locally without reading an unsafe path", async () => {
  for (const coin of [{ ...createCoin(), baseCurrencyId: ".." }, { ...createCoin(), symbol: "." }]) {
    const leader = createCoin("LEADER", "OKX:LEADERUSDT.P")
    const requested = []
    const histories = await buildPeerRadarHistories(createReport([{ coin, leaders: [leaderReference(leader)] }]), {
      readCoinData: createReader([[leader, createBootstrap(leader)]], requested),
    })
    assert.deepEqual(requested, [createBootstrapDataRelativePath(leader)])
    assert.deepEqual(histories[coin.baseCurrencyId].points, [])
    assert.match(histories[coin.baseCurrencyId].warning, /недоступна/)
    assertHealthyLeader(histories)
  }
})

test("does not round a misaligned report snapshot onto another hour", async () => {
  const data = createReport()
  data.asOf = "2026-09-24T06:30:00.000Z"
  data.snapshotClosedAt = "2026-09-24T07:30:00.000Z"
  const histories = await loadCandidate(createBootstrap(createCoin()), data)
  for (const history of Object.values(histories)) {
    assert.deepEqual(history.points, [])
    assert.match(history.warning, /время среза.*часовой сетке/)
  }
})

test("an empty radar report returns an empty dictionary without reading anything", async () => {
  let readCount = 0
  const histories = await buildPeerRadarHistories(createReport([]), {
    readCoinData: async () => {
      readCount += 1
      throw new Error("Unexpected read")
    },
  })
  assert.deepEqual(histories, {})
  assert.equal(readCount, 0)
})
