import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import { buildPriceCharacterReport, preparePriceCharacterPeriods } from "../src/research/price-character.js"
import { fetchProveSnapshot, runProveResearch } from "../src/research/prove-15m.js"

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
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} != ${expected}`)
}

test("90-day research uses closed candles, excludes warmup, and partitions weeks without overlap", () => {
  const data = snapshot()
  data.periods[96].max *= 2
  const before = structuredClone(data)
  const report = buildPriceCharacterReport(data)
  assert.deepEqual(report.coverage, { requestedDays: 90, analysisDays: 90, analysisBars: 8640, warmupBars: 97, totalBars: 8737, intervalSeconds: 900, missingBars: 0 })
  assert.deepEqual(report.warnings, [])
  assert.equal(report.startTime, data.endTime - 90 * 86400)
  assert.deepEqual(report.windows.map(window => window.bars), [672, 2880, 8640])
  assert.ok(report.windows.every(window => window.endTime === data.endTime))
  assert.equal(report.weeks.length, 13)
  assert.equal(report.weeks[0].days, 6)
  assert.equal(report.weeks.reduce((total, week) => total + week.bars, 0), 8640)
  report.weeks.slice(1).forEach((week, index) => assert.equal(week.startTime, report.weeks[index].endTime))
  assert.equal(report.weeks.at(-1).endTime, data.endTime)
  assert.equal(report.spikes.length, 0)
  for (const window of report.windows) {
    closeTo(window.efficiency4hMedian, 1)
    closeTo(window.efficiency12hMedian, 1)
    closeTo(window.rangeTailRatio, 1)
    assert.equal(window.spikeCount, 0)
    assert.equal(window.spikeEvaluatedBars, window.bars)
    closeTo(window.netReturnPct, 100 * Math.expm1(window.bars * 0.0001))
  }
  closeTo(report.windows[2].top1PctMovementSharePct, 100 * 87 / 8640)
  assert.deepEqual(data, before)
})

test("spikes and wicks use the preceding baseline, never the current candle or future data", () => {
  const data = snapshot()
  data.periods[500].max *= 1.15
  const first = buildPriceCharacterReport(data)
  data.periods[500].max *= 2
  data.periods[800].max *= 4
  const second = buildPriceCharacterReport(data)
  const originalEvent = first.spikes.find(event => event.time === data.periods[500].time)
  const changedEvent = second.spikes.find(event => event.time === data.periods[500].time)
  assert.ok(originalEvent.rangeMultiple > 100)
  assert.equal(originalEvent.baselineRangePct, changedEvent.baselineRangePct)
  assert.ok(changedEvent.rangeMultiple > originalEvent.rangeMultiple)
  closeTo(first.windows[2].longWickRatePct, 100 / 8640)
  closeTo(first.windows[2].spikeRatePct, 100 / 8640)
  assert.equal(first.windows[2].spikeCount, 1)
  assert.equal(first.windows[0].spikeCount, 0)
  assert.ok(second.spikes[0].rangeMultiple >= second.spikes[1].rangeMultiple)
})

test("true range includes gaps; absolute and relative spikes stay separate from directional efficiency", () => {
  const data = snapshot(index => index === 500 ? 0.2 : 0.0001)
  const report = buildPriceCharacterReport(data)
  assert.equal(report.windows[2].spikeCount, 1)
  assert.ok(report.windows[2].top1PctMovementSharePct > 15)
  closeTo(report.windows[2].efficiency4hMedian, 1)
  closeTo(report.windows[2].returnOver3PctRatePct, 100 / 8640)
  const gap = snapshot()
  Object.assign(gap.periods[500], { open: 200, close: 200, max: 200.01, min: 199.99 })
  const event = buildPriceCharacterReport(gap).spikes.find(row => row.time === gap.periods[500].time)
  assert.ok(event.rangePct > 80)
})

test("choppy movement has low efficiency; flat prices are not scored as perfectly smooth", () => {
  const choppy = buildPriceCharacterReport(snapshot(index => index % 2 ? 0.001 : -0.001))
  assert.ok(choppy.windows[2].efficiency4hMedian < 1e-10)
  assert.equal(choppy.windows[2].spikeCount, 0)
  const flat = buildPriceCharacterReport(snapshot(() => 0, 0)).windows[2]
  assert.equal(flat.medianRangePct, 0)
  assert.equal(flat.rangeTailRatio, null)
  assert.equal(flat.efficiency4hMedian, null)
  assert.equal(flat.efficiency12hMedian, null)
  assert.equal(flat.top1PctMovementSharePct, null)
  assert.equal(flat.spikeEvaluatedBars, 0)
  assert.equal(flat.spikeRatePct, null)
  assert.equal(flat.longWickRatePct, null)
  assert.equal(flat.zeroReturnRatePct, 100)
  assert.equal(flat.flatBarRatePct, 100)
})

test("price rescaling does not change the character metrics", () => {
  const data = snapshot(index => index % 5 ? 0.001 : -0.001)
  const original = buildPriceCharacterReport(data).windows[2]
  data.periods.forEach((period) => {
    for (const key of ["open", "close", "max", "min"]) {
      period[key] *= 1000
    }
    period.volume /= 1000
  })
  const scaled = buildPriceCharacterReport(data).windows[2]
  for (const key of ["medianRangePct", "medianAbsReturnPct", "rangeTailRatio", "spikeRatePct", "efficiency4hMedian", "top1PctMovementSharePct", "medianDailyTurnoverUsdt"]) {
    closeTo(original[key], scaled[key], 1e-6)
  }
})

test("normalization sorts data, excludes the open candle and rejects gaps, duplicates and malformed OHLCV", () => {
  const data = snapshot()
  const current = { ...data.periods.at(-1), time: data.endTime }
  assert.deepEqual(preparePriceCharacterPeriods([...data.periods, current].reverse(), data.endTime), data.periods)
  assert.throws(() => preparePriceCharacterPeriods(data.periods.slice(1), data.endTime), /Incomplete 15m history/)
  const duplicate = [...data.periods]
  duplicate[10] = duplicate[11]
  assert.throws(() => preparePriceCharacterPeriods(duplicate, data.endTime), /Invalid 15m grid/)
  for (const invalid of [{ volume: -1 }, { close: NaN }, { min: 1000 }, { time: 1_800_000_000 - 901 }]) {
    const periods = [...data.periods]
    periods[100] = { ...periods[100], ...invalid }
    assert.throws(() => preparePriceCharacterPeriods(periods, data.endTime), /Invalid/)
  }
  assert.throws(() => preparePriceCharacterPeriods(data.periods, data.endTime + 1), /boundary/)
  assert.throws(() => buildPriceCharacterReport({ ...data, timeframe: "1h" }), /native 15m/)
})

test("fetcher requests native 15m with fixed closed boundary and always disconnects", async () => {
  const data = snapshot()
  const client = {}
  let disconnected = 0
  const result = await fetchProveSnapshot({
    nowTimestamp: data.endTime + 123,
    connect: async () => client,
    disconnect: async () => disconnected++,
    fetchPeriods: async (receivedClient, options) => {
      assert.equal(receivedClient, client)
      assert.deepEqual(options, {
        symbol: "BINANCE:PROVEUSDT.P", timeframe: "15", range: 8738,
        to: data.endTime - 1, timeoutMs: 60_000, settleDelayMs: 1_000,
      })
      return [...data.periods].reverse()
    },
  })
  assert.equal(result.endTime, data.endTime)
  assert.deepEqual(result.periods, data.periods)
  assert.equal(disconnected, 1)
  await assert.rejects(fetchProveSnapshot({
    nowTimestamp: data.endTime,
    connect: async () => client,
    disconnect: async () => disconnected++,
    fetchPeriods: async () => [],
  }), /Incomplete 15m history/)
  assert.equal(disconnected, 2)
  await assert.rejects(fetchProveSnapshot({
    connect: async () => {
      throw new Error("No connection")
    },
    disconnect: async () => disconnected++,
  }), /No connection/)
  assert.equal(disconnected, 3)
})

test("short source history is explicitly labelled; missing bars are not disguised as shorter history", async () => {
  const data = snapshot()
  const options = {
    nowTimestamp: data.endTime,
    connect: async () => ({}),
    disconnect: async () => {},
    fetchPeriods: async () => data.periods.slice(-5705),
  }
  const result = await fetchProveSnapshot(options)
  assert.equal(result.requestedDays, 90)
  assert.equal(result.analysisDays, 58)
  assert.equal(result.receivedBars, 5705)
  assert.equal(result.periods.length, 58 * 96 + 97)
  const report = buildPriceCharacterReport(result)
  assert.deepEqual(report.windows.map(window => window.days), [7, 30, 58])
  assert.match(report.windows.at(-1).label, /доступно из 90/)
  assert.match(report.warnings[0], /58 полных дней/)
  assert.equal(report.weeks[0].days, 2)
  assert.equal(report.weeks.reduce((total, week) => total + week.days, 0), 58)
  assert.equal(report.coverage.missingBars, 0)
  await assert.rejects(fetchProveSnapshot({
    ...options,
    fetchPeriods: async () => data.periods.slice(-5705).filter((_, index) => index !== 500),
  }), /Incomplete 15m history/)
  await assert.rejects(fetchProveSnapshot({
    ...options,
    fetchPeriods: async () => data.periods.slice(-1000),
  }), /at least 30 days/)
  const minimum = buildPriceCharacterReport({ ...data, analysisDays: 30 })
  assert.deepEqual(minimum.windows.map(window => window.days), [7, 30])
  assert.throws(() => buildPriceCharacterReport({ ...data, analysisDays: 29 }), /between 30 and 90/)
  const aligned = buildPriceCharacterReport({ ...data, requestedDays: 58, analysisDays: 58 })
  assert.equal(aligned.coverage.requestedDays, 58)
  assert.deepEqual(aligned.warnings, [])
  assert.equal(aligned.windows.at(-1).label, "58 дней")
  assert.throws(() => buildPriceCharacterReport({ ...data, requestedDays: 30, analysisDays: 58 }), /Requested research days/)
})

test("runner saves a standalone report and reanalyses the unchanged cache without network calls", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "prove-research-"))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  const data = snapshot()
  await runProveResearch({ directory, loadSnapshot: async () => data })
  assert.deepEqual((await fs.readdir(directory)).sort(), ["candles.json", "report.html", "report.json", "report.md"])
  const rawBefore = await fs.readFile(path.join(directory, "candles.json"), "utf8")
  const result = await runProveResearch({ directory, cached: true, loadSnapshot: () => assert.fail("Unexpected network request") })
  assert.equal(await fs.readFile(path.join(directory, "candles.json"), "utf8"), rawBefore)
  assert.equal(result.coverage.analysisBars, 8640)
  assert.equal(JSON.parse(await fs.readFile(path.join(directory, "report.json"), "utf8")).endTime, data.endTime)
  const html = await fs.readFile(path.join(directory, "report.html"), "utf8")
  const payload = JSON.parse(html.match(/<script id="price-data" type="application\/json">([\s\S]*?)<\/script>/)[1])
  assert.equal(payload.candles.length, 8640)
  assert.equal(payload.candles[0].time, result.startTime)
  assert.equal(payload.candles.at(-1).time, result.endTime - 900)
  await assert.rejects(runProveResearch({ directory, loadSnapshot: async () => ({ ...data, symbol: "BTC" }) }), /Expected.*PROVE/)
})
