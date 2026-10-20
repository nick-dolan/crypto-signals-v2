import assert from "node:assert/strict"
import test from "node:test"

import { buildPeerRadar } from "../src/steps/step11-peer-radar/build-peer-radar.js"

function createInput (last = 804) {
  const times = Array.from({ length: last + 1 }, (_, index) => (
    Date.parse("2026-08-01T00:00:00.000Z") / 1_000 + index * 3_600
  ))
  const coins = ["TARGET", "LEADER", "MARKET1", "MARKET2", "MARKET3"].map((id, index) => ({
    baseCurrencyId: id,
    symbol: id,
    name: id,
    rank: index + 1,
    categories: [],
    tradingViewSymbol: `CRYPTO:${id}USD`,
    market: { tradingViewSymbol: `BINANCE:${id}USDT.P` },
  }))
  const input = {
    sourceCoinList: { generatedAt: new Date((times.at(-1) + 3_600) * 1_000).toISOString(), coins },
    coinData: coins.map(coin => ({
      coin: { baseCurrencyId: coin.baseCurrencyId, marketSymbol: coin.market.tradingViewSymbol },
      chart: { periods: times.map(time => ({ time, close: 100, max: 101, min: 99, volume: 100 })) },
    })),
    coinPeers: {
      schemaVersion: 1,
      generatedAt: "2026-07-31T00:00:00.000Z",
      coinList: { coins: coins.map(({ baseCurrencyId }) => ({ baseCurrencyId, reviewStatus: "reviewed" })) },
      relations: [{ coinIds: ["TARGET", "LEADER"], type: "competitor", basis: "Shared product", caveat: "Different token economics" }],
    },
  }
  setReaction(input, "LEADER", 106)
  return input
}

function setReaction (input, id, close) {
  const periods = input.coinData.find(data => data.coin.baseCurrencyId === id).chart.periods
  for (const period of periods.slice(800)) {
    Object.assign(period, { close, max: close + 1, min: close - 1, volume: 100 })
  }
  if (id === "LEADER") {
    periods[800].volume = 600
  }
}

function assertClose (actual, expected) {
  assert.ok(Math.abs(actual - expected) < 1e-10, `${actual} != ${expected}`)
}

test("radar selects a laggard against the fresh leader's current move, not its frozen trigger", () => {
  const input = createInput(801)
  Object.assign(input.coinData[1].chart.periods.at(-1), { close: 108, max: 109, min: 107 })
  setReaction(input, "TARGET", 103.5)
  const scan = buildPeerRadar(input)
  assert.deepEqual(scan.candidates.map(candidate => candidate.coin.baseCurrencyId), ["TARGET"])
  const [leader] = scan.candidates[0].leaders

  assert.equal(leader.baseCurrencyId, "LEADER")
  assert.equal(leader.status, "fresh")
  assert.equal(leader.ageHours, 1)
  assertClose(leader.returnSinceStartPct, 8)
  assertClose(leader.move4hAtr, 3)
  assertClose(leader.moveSinceStartAtr, 4)
  assertClose(leader.coinReturnSinceStartPct, 3.5)
  assertClose(leader.coinMoveSinceStartAtr, 1.75)
  assertClose(leader.responseRatio, 0.4375)
  assertClose(leader.gapAtr, 2.25)

  setReaction(input, "TARGET", 104.01)
  assert.deepEqual(buildPeerRadar(input).candidates, [])
})

test("collapsed and expired leader episodes do not produce candidates, even after new highs", () => {
  const collapsed = createInput(801)
  Object.assign(collapsed.coinData[1].chart.periods.at(-1), { close: 102, max: 103, min: 101 })
  const collapsedScan = buildPeerRadar(collapsed)
  assert.equal(collapsedScan.coverage.available, 2)
  assert.deepEqual(collapsedScan.candidates, [])

  const expired = createInput(813)
  for (const [index, period] of expired.coinData[1].chart.periods.slice(801).entries()) {
    const close = 110 + index * 4
    Object.assign(period, { close, max: close + 1, min: close - 1, volume: 600 })
  }
  const expiredScan = buildPeerRadar(expired)
  assert.equal(expiredScan.coverage.available, 2)
  assert.deepEqual(expiredScan.candidates, [])
})
