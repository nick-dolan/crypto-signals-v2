import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import { indexCoinPeers, readCoinPeers } from "../src/helpers/coin-peers-helper.js"
import { buildPeerContext } from "../src/steps/step4-feature-metrics/build-peer-context.js"

function assertClose (actual, expected) {
  assert.ok(Math.abs(actual - expected) < 1e-10, `${actual} != ${expected}`)
}

function coin (id, last = 804) {
  const times = Array.from({ length: last + 1 }, (_, index) => index * 3_600)
  return {
    coin: { baseCurrencyId: id, symbol: id, rank: 1 },
    times,
    close: times.map(() => 100),
    hourlyData: {
      chart: {
        periods: times.map(time => ({ time, close: 100, max: 101, min: 99, volume: 100 })),
      },
    },
  }
}

function setClose (baseCoin, index, value, volume = 100) {
  baseCoin.close[index] = value
  baseCoin.hourlyData.chart.periods[index] = {
    time: baseCoin.times[index], close: value, max: value + 1, min: value - 1, volume,
  }
}

function jump (baseCoin, index = 800, value = 106) {
  for (let current = index; current < baseCoin.times.length; current += 1) {
    setClose(baseCoin, current, value, current === index ? 600 : 100)
  }
}

function registry (pairs = [["TARGET", "LEADER"]], extraCoins = []) {
  return {
    schemaVersion: 1,
    generatedAt: "2026-09-22T16:02:05.780Z",
    universe: {
      coins: [...new Set([...pairs.flat(), ...extraCoins])].map(baseCurrencyId => ({
        baseCurrencyId, reviewStatus: "reviewed",
      })),
    },
    relations: pairs.map(coinIds => ({
      coinIds, type: "competitor", basis: "Shared product", caveat: "Different token economics",
    })),
  }
}

function fixture (last = 804) {
  const coins = ["TARGET", "LEADER", "MARKET1", "MARKET2", "MARKET3"].map(id => coin(id, last))
  jump(coins[1])
  return { coins, graph: registry() }
}

function target (fixture) {
  return buildPeerContext(fixture.coins, fixture.graph).get("TARGET")
}

test("peer context reports a fresh direct leader and freezes trigger evidence before the move", () => {
  const input = fixture()
  for (let index = 800; index < input.coins[0].close.length; index += 1) {
    setClose(input.coins[0], index, 101)
  }
  input.coins[1].coin.symbol = "READABLE"
  const before = structuredClone(input)
  const context = target(input)

  assert.equal(context.status, "available")
  assert.equal(context.registryGeneratedAt, input.graph.generatedAt)
  assert.equal(context.peerCount, 1)
  assert.equal(context.availablePeerCount, 1)
  assert.equal(context.benchmarkCoinCount, 3)
  assert.equal(context.freshLeaderCount, 1)
  assert.equal(context.fadingLeaderCount, 0)
  const [leader] = context.leaders
  assert.equal(leader.symbol, "READABLE")
  assert.equal(leader.baseCurrencyId, "LEADER")
  assert.equal(leader.ageHours, 4)
  assert.equal(leader.detectedAt, new Date(801 * 3_600_000).toISOString())
  assert.equal(leader.windowStartedAt, new Date(797 * 3_600_000).toISOString())
  assert.equal(leader.type, "competitor")
  assert.equal(leader.basis, "Shared product")
  assertClose(leader.move4hAtr, 3)
  assertClose(leader.marketExcess4hAtr, 3)
  assertClose(leader.relativeVolume4h, (30_000 + 106 * 600) / 40_000)
  assertClose(leader.return4h, 0.06)
  assertClose(leader.returnSinceStart, 0.06)
  assertClose(leader.coinReturnSinceStart, 0.01)
  assertClose(leader.coinMoveSinceStartAtr, 0.5)
  assert.equal(leader.retainedFraction, 1)
  assert.deepEqual(input, before)
})

test("event timestamps use candle closes while snapshot labels use candle opens", () => {
  const input = fixture(800)
  const [leader] = target(input).leaders
  const snapshotOpen = input.coins[0].times.at(-1) * 1_000
  const snapshotClose = snapshotOpen + 3_600_000

  assert.equal(Date.parse(leader.detectedAt), snapshotClose)
  assert.equal(Date.parse(leader.windowStartedAt), snapshotClose - 4 * 3_600_000)
  assert.equal(leader.ageHours, (snapshotClose - Date.parse(leader.detectedAt)) / 3_600_000)
  assert.equal(leader.ageHours, 0)
})

test("freshness boundaries are inclusive at four and twelve hours", () => {
  for (const [last, fresh, fading] of [[800, 1, 0], [804, 1, 0], [805, 0, 1], [812, 0, 1], [813, 0, 0]]) {
    const context = target(fixture(last))
    assert.equal(context.freshLeaderCount, fresh, `last=${last}`)
    assert.equal(context.fadingLeaderCount, fading, `last=${last}`)
  }
})

test("new highs do not renew the first detection or retain an expired episode", () => {
  const input = fixture(816)
  for (let index = 801; index <= 816; index += 1) {
    setClose(input.coins[1], index, 106 + (index - 800) * 4, 600)
  }
  assert.equal(target(input).leaders.length, 0)
  for (const baseCoin of input.coins) {
    baseCoin.times = baseCoin.times.slice(0, 805)
    baseCoin.close = baseCoin.close.slice(0, 805)
    baseCoin.hourlyData.chart.periods = baseCoin.hourlyData.chart.periods.slice(0, 805)
  }
  const [leader] = target(input).leaders
  assert.equal(leader.ageHours, 4)
  assertClose(leader.return4h, 0.06)
  assertClose(leader.move4hAtr, 3)
  assertClose(leader.returnSinceStart, 0.22)
})

test("retention uses peak closes and accepts exactly half", () => {
  const input = fixture()
  setClose(input.coins[1], 801, 108)
  for (const value of [104, 103.9]) {
    setClose(input.coins[1], 804, value)
    const context = target(input)
    assert.equal(context.leaders.length, value === 104 ? 1 : 0)
    if (value === 104) {
      assertClose(context.leaders[0].retainedFraction, 0.5)
    }
  }
})

test("a peak close inside the detection window can invalidate an event immediately", () => {
  const input = fixture(800)
  setClose(input.coins[1], 797, 114)
  assert.equal(target(input).status, "available")
  assert.deepEqual(target(input).leaders, [])

  setClose(input.coins[1], 797, 112)
  assertClose(target(input).leaders[0].retainedFraction, 0.5)
})

test("a collapsed episode cannot revive on a bounce without four quiet hours", () => {
  const input = fixture(803)
  setClose(input.coins[1], 801, 102)
  setClose(input.coins[1], 802, 106, 600)
  setClose(input.coins[1], 803, 107, 600)
  assert.equal(target(input).leaders.length, 0)
})

test("a new impulse after four quiet hours receives its own window and age", () => {
  const input = fixture(808)
  jump(input.coins[1], 808, 114)
  const [leader] = target(input).leaders
  assert.equal(leader.ageHours, 0)
  assert.equal(leader.windowStartedAt, new Date(805 * 3_600_000).toISOString())
  assertClose(leader.returnSinceStart, 114 / 106 - 1)
})

test("price, excess and four-hour seasonal volume are all required", () => {
  const tooSmall = fixture(800)
  jump(tooSmall.coins[1], 800, 104.9)
  assert.equal(target(tooSmall).leaders.length, 0)

  const noVolume = fixture(800)
  setClose(noVolume.coins[1], 800, 106, 100)
  assert.equal(target(noVolume).leaders.length, 0)

  const marketMove = fixture(800)
  for (const benchmark of marketMove.coins.slice(2)) {
    jump(benchmark, 800, 105)
  }
  assert.equal(target(marketMove).leaders.length, 0)

  const negative = fixture(800)
  jump(negative.coins[1], 800, 90)
  assert.equal(target(negative).leaders.length, 0)
})

test("the market benchmark excludes candidate and every direct neighbor", () => {
  const input = fixture(800)
  const extraPeer = coin("PEER2", 800)
  jump(extraPeer, 800, 150)
  jump(input.coins[0], 800, 150)
  input.coins.push(extraPeer)
  input.graph = registry([["TARGET", "LEADER"], ["TARGET", "PEER2"]])
  const context = target(input)
  assert.equal(context.benchmarkCoinCount, 3)
  assert.equal(context.freshLeaderCount, 2)
  assertClose(context.leaders.find(leader => leader.symbol === "LEADER").marketExcess4hAtr, 3)
})

test("benchmark uses the median, not mean or BTC alone", () => {
  const input = fixture(800)
  jump(input.coins[2], 800, 150)
  input.coins[2].coin.symbol = "BTC"
  const context = target(input)
  assert.equal(context.freshLeaderCount, 1)
  assertClose(context.leaders[0].marketExcess4hAtr, 3)
})

test("seasonality compares complete four-hour windows with the same ending hour", () => {
  const input = fixture(800)
  for (const baseCoin of input.coins) {
    for (let index = 0; index < baseCoin.times.length; index += 1) {
      const period = baseCoin.hourlyData.chart.periods[index]
      period.volume = index % 24 >= 5 && index % 24 <= 8 ? 1_000 : 100
    }
  }
  setClose(input.coins[1], 800, 106, 1_000)
  assert.equal(target(input).leaders.length, 0)
  setClose(input.coins[1], 800, 106, 4_000)
  const [leader] = target(input).leaders
  assertClose(leader.relativeVolume4h, (300_000 + 106 * 4_000) / 400_000)
})

test("a zero seasonal volume baseline is unavailable rather than infinite activity", () => {
  const input = fixture(800)
  for (const period of input.coins[1].hourlyData.chart.periods.slice(0, 800)) {
    period.volume = 0
  }
  const context = target(input)
  assert.equal(context.status, "insufficient_data")
  assert.equal(context.leaders, null)
  assert.equal(context.freshLeaderCount, null)
})

test("coverage distinguishes absent registry, unknown coin, unreviewed and confirmed no peers", () => {
  const input = fixture()
  input.graph = null
  assert.equal(target(input).status, "unavailable")
  assert.equal(target(input).peerCount, null)
  assert.equal(target(input).leaders, null)

  input.graph = registry([["OTHER", "LEADER"]])
  assert.equal(target(input).status, "not_covered")
  assert.equal(target(input).freshLeaderCount, null)

  input.graph = registry([], ["TARGET"])
  assert.equal(target(input).status, "no_peers")
  assert.equal(target(input).peerCount, 0)
  assert.deepEqual(target(input).leaders, [])

  input.graph.universe.coins[0].reviewStatus = "insufficient_evidence"
  assert.equal(target(input).status, "unreviewed")
  assert.equal(target(input).freshLeaderCount, null)
})

test("missing listed neighbors and missing OHLCV reduce coverage without inventing zero signals", () => {
  const input = fixture()
  input.graph = registry([["TARGET", "LEADER"], ["TARGET", "MISSING"]])
  const partial = target(input)
  assert.equal(partial.status, "partial")
  assert.equal(partial.peerCount, 2)
  assert.equal(partial.availablePeerCount, 1)
  assert.equal(partial.freshLeaderCount, 1)

  input.coins[1].hourlyData.chart.periods.at(-1).volume = null
  const unavailable = target(input)
  assert.equal(unavailable.status, "insufficient_data")
  assert.equal(unavailable.availablePeerCount, 0)
  assert.equal(unavailable.freshLeaderCount, null)
  assert.equal(unavailable.leaders, null)
})

test("partial coverage with no observed leaders is not full quiet coverage", () => {
  const input = fixture()
  input.coins[1] = coin("LEADER")
  input.graph = registry([["TARGET", "LEADER"], ["TARGET", "MISSING"]])
  const context = target(input)
  assert.equal(context.status, "partial")
  assert.equal(context.freshLeaderCount, 0)
  assert.deepEqual(context.leaders, [])
})

test("fewer than three outside coins or an incomplete benchmark makes context unavailable", () => {
  const input = fixture()
  input.coins.pop()
  assert.equal(target(input).status, "insufficient_data")
  assert.equal(target(input).benchmarkCoinCount, 2)
  assert.equal(target(input).leaders, null)

  input.coins.push(coin("MARKET3"))
  input.coins.at(-1).close[803] = null
  assert.equal(target(input).status, "insufficient_data")
})

test("direct links are symmetric but never transitively expanded", () => {
  const input = fixture()
  input.graph = registry([["LEADER", "TARGET"], ["LEADER", "MARKET1"]])
  jump(input.coins[2])
  const contexts = buildPeerContext(input.coins, input.graph)
  assert.equal(contexts.get("TARGET").peerCount, 1)
  assert.deepEqual(contexts.get("TARGET").leaders.map(leader => leader.symbol), ["LEADER"])
  assert.equal(contexts.get("LEADER").peerCount, 2)
})

test("observations start only after complete history, without left-censored fresh events", () => {
  const short = fixture(730)
  jump(short.coins[1], 726, 106)
  assert.equal(target(short).status, "insufficient_data")

  const input = fixture(750)
  for (let index = 720; index <= 750; index += 1) {
    setClose(input.coins[1], index, 100 + (index - 719) * 10, 600)
  }
  assert.equal(target(input).status, "available")
  assert.equal(target(input).leaders.length, 0)
})

test("new ranks and symbols do not change matching by baseCurrencyId", () => {
  const input = fixture()
  input.graph.universe.coins.forEach((item) => {
    item.rank = 999
    item.symbol = "OLD"
  })
  input.coins[1].coin.symbol = "CURRENT"
  assert.equal(target(input).leaders[0].symbol, "CURRENT")
})

test("registry rejects ambiguous, self, external and unreviewed edges", () => {
  for (const mutate of [
    (data) => {
      data.schemaVersion = 2
    },
    (data) => {
      data.generatedAt = "invalid"
    },
    (data) => {
      data.universe.coins.push(data.universe.coins[0])
    },
    (data) => {
      data.relations.push({ ...data.relations[0], coinIds: ["LEADER", "TARGET"] })
    },
    (data) => {
      data.relations[0].coinIds = ["TARGET", "TARGET"]
    },
    (data) => {
      data.relations[0].coinIds = ["TARGET", "EXTERNAL"]
    },
    (data) => {
      data.relations[0].type = "unverified"
    },
    (data) => {
      data.universe.coins[0].reviewStatus = "not_reviewed"
    },
  ]) {
    const data = registry()
    mutate(data)
    assert.throws(() => indexCoinPeers(data), /Invalid coin peers/)
  }
})

test("reader distinguishes an absent accepted file from corrupt data", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "coin-peers-"))
  const filename = path.join(directory, "coin-peers.json")
  try {
    assert.equal(await readCoinPeers(filename), null)
    await fs.writeFile(filename, JSON.stringify(registry()))
    assert.deepEqual(await readCoinPeers(filename), registry())
    await fs.writeFile(filename, "{")
    await assert.rejects(readCoinPeers(filename), SyntaxError)
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
  }
})
