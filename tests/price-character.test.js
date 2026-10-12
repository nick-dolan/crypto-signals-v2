import assert from "node:assert/strict"
import test from "node:test"

import { isFinite } from "../src/helpers/utils.typed.js"
import { buildPriceCharacterReport } from "../src/research/price-character.js"

function snapshot (change = () => 0.0001, wick = 0.00005) {
  let price = 100
  return {
    source: "tradingview",
    symbol: "PROVE",
    marketSymbol: "BINANCE:PROVEUSDT.P",
    timeframe: "15m",
    collectedAt: "2027-01-15T08:00:00.000Z",
    endTime: 1_800_000_000,
    periods: Array.from({ length: 8737 }, (_, index) => {
      const open = price
      price *= Math.exp(change(index))
      return {
        time: 1_800_000_000 - (8737 - index) * 900,
        open,
        close: price,
        max: Math.max(open, price) * (1 + wick),
        min: Math.min(open, price) / (1 + wick),
        volume: 100,
      }
    }),
  }
}

function closeTo (actual, expected, tolerance = 1e-9) {
  assert.ok(isFinite(actual) && Math.abs(actual - expected) <= tolerance, `${actual} != ${expected}`)
}

test("metrics use closed analysis candles, exclude warmup and reject missing history", () => {
  const data = snapshot()
  data.periods[96].max *= 2
  data.periods.push({ ...data.periods.at(-1), time: data.endTime, max: data.periods.at(-1).close * 100 })
  const report = buildPriceCharacterReport(data)

  assert.equal(report.coverage.analysisBars, 8640)
  assert.equal(report.startTime, data.endTime - 90 * 86400)
  assert.deepEqual(report.windows.map(window => window.bars), [672, 2880, 8640])
  assert.equal(report.spikes.length, 0)
  for (const window of report.windows) {
    assert.equal(window.endTime, data.endTime)
    closeTo(window.netReturnPct, 100 * Math.expm1(window.bars * 0.0001))
    closeTo(window.efficiency4hMedian, 1)
    closeTo(window.efficiency12hMedian, 1)
    closeTo(window.rangeTailRatio, 1)
    assert.equal(window.spikeEvaluatedBars, window.bars)
  }
  closeTo(report.windows[2].top1PctMovementSharePct, 100 * 87 / 8640)
  assert.throws(() => buildPriceCharacterReport({ ...data, periods: data.periods.slice(1) }), /Incomplete 15m history/)
})

test("spikes and long wicks use the preceding 96 candles, never the current candle or future data", () => {
  const data = snapshot(() => 0, 0)
  data.periods.forEach(period => Object.assign(period, { max: 101, min: 99 }))
  // The preceding ranges are 48 × 2% and 48 × 6%; including the spike would make the median 6%, not 4%.
  data.periods.slice(452, 500).forEach(period => Object.assign(period, { max: 103, min: 97 }))
  Object.assign(data.periods[500], { max: 120, min: 100 })
  const first = buildPriceCharacterReport(data)
  const originalEvent = first.spikes.find(event => event.time === data.periods[500].time)

  closeTo(originalEvent.baselineRangePct, 4)
  closeTo(originalEvent.rangePct, 20)
  closeTo(originalEvent.rangeMultiple, 5)
  closeTo(first.windows[2].longWickRatePct, 100 / 8640)
  closeTo(first.windows[2].spikeRatePct, 100 / 8640)
  assert.equal(first.windows[2].spikeCount, 1)

  data.periods[500].max = 140
  Object.assign(data.periods[800], { max: 200, min: 100 })
  const changedEvent = buildPriceCharacterReport(data).spikes.find(event => event.time === data.periods[500].time)
  closeTo(changedEvent.baselineRangePct, 4)
  closeTo(changedEvent.rangeMultiple, 10)
})

test("choppy movement has low efficiency and a flat price is not perfectly smooth", () => {
  const choppy = buildPriceCharacterReport(snapshot(index => index % 2 ? 0.001 : -0.001)).windows[2]
  closeTo(choppy.efficiency4hMedian, 0)
  closeTo(choppy.efficiency12hMedian, 0)

  const flat = buildPriceCharacterReport(snapshot(() => 0, 0)).windows[2]
  assert.equal(flat.medianRangePct, 0)
  assert.equal(flat.rangeTailRatio, null)
  assert.equal(flat.efficiency4hMedian, null)
  assert.equal(flat.efficiency12hMedian, null)
  assert.equal(flat.top1PctMovementSharePct, null)
  assert.equal(flat.spikeEvaluatedBars, 0)
  assert.equal(flat.spikeRatePct, null)
  assert.equal(flat.zeroReturnRatePct, 100)
  assert.equal(flat.flatBarRatePct, 100)
})
