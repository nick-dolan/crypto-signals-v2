import assert from "node:assert/strict"
import test from "node:test"

import { buildPeerContext } from "../src/steps/step4-feature-metrics/build-peer-context.js"

function assertClose (actual, expected) {
  assert.ok(Math.abs(actual - expected) < 1e-10, `${actual} != ${expected}`)
}

function coin (id, last = 804) {
  const times = Array.from({ length: last + 1 }, (_, index) => index * 3_600)
  return {
    coin: { baseCurrencyId: id, symbol: id },
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

function registry (pairs = [["TARGET", "LEADER"]]) {
  return {
    schemaVersion: 1,
    generatedAt: "2026-09-22T16:02:05.780Z",
    coinList: {
      coins: [...new Set(pairs.flat())].map(baseCurrencyId => ({ baseCurrencyId, reviewStatus: "reviewed" })),
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

function target (input) {
  return buildPeerContext(input.coins, input.graph).get("TARGET")
}

test("new highs preserve the event's original evidence, pre-move ATR and age", () => {
  const input = fixture()
  jump(input.coins[0], 800, 101)
  for (let index = 801; index <= 804; index += 1) {
    setClose(input.coins[1], index, 106 + (index - 800) * 4, 600)
  }
  const context = target(input)
  const [leader] = context.leaders

  assert.equal(context.freshLeaderCount, 1)
  assert.equal(leader.baseCurrencyId, "LEADER")
  assert.equal(leader.status, "fresh")
  assert.equal(leader.ageHours, 4)
  assert.equal(leader.detectedAt, new Date(801 * 3_600_000).toISOString())
  assert.equal(leader.windowStartedAt, new Date(797 * 3_600_000).toISOString())
  assertClose(leader.return4h, 0.06)
  assertClose(leader.move4hAtr, 3)
  assertClose(leader.marketExcess4hAtr, 3)
  assertClose(leader.relativeVolume4h, (30_000 + 106 * 600) / 40_000)
  assertClose(leader.returnSinceStart, 0.22)
  assertClose(leader.coinReturnSinceStart, 0.01)
  assertClose(leader.coinMoveSinceStartAtr, 0.5)
  assert.equal(leader.retainedFraction, 1)
})

test("benchmark is the outside market median, excluding the candidate and all direct peers", () => {
  const input = fixture(800)
  const extraPeer = coin("PEER2", 800)
  jump(extraPeer, 800, 150)
  jump(input.coins[0], 800, 150)
  jump(input.coins[2], 800, 150)
  jump(input.coins[3], 800, 102)
  jump(input.coins[4], 800, 102)
  input.coins.push(extraPeer)
  input.graph = registry([["TARGET", "LEADER"], ["TARGET", "PEER2"]])
  const context = target(input)

  assert.equal(context.benchmarkCoinCount, 3)
  assert.equal(context.freshLeaderCount, 2)
  assertClose(context.leaders.find(leader => leader.baseCurrencyId === "LEADER").marketExcess4hAtr, 2)
})

test("insufficient market coverage and zero seasonal volume are unknown, not quiet signals", () => {
  const tooFew = fixture()
  tooFew.coins.pop()
  const missingBenchmark = target(tooFew)
  assert.equal(missingBenchmark.benchmarkCoinCount, 2)
  assert.equal(missingBenchmark.status, "insufficient_data")
  assert.equal(missingBenchmark.leaders, null)
  assert.equal(missingBenchmark.freshLeaderCount, null)

  const zeroVolume = fixture()
  zeroVolume.coins[1].hourlyData.chart.periods.slice(0, 800).forEach(period => period.volume = 0)
  const missingBaseline = target(zeroVolume)
  assert.equal(missingBaseline.status, "insufficient_data")
  assert.equal(missingBaseline.leaders, null)
  assert.equal(missingBaseline.freshLeaderCount, null)
})
