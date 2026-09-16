import assert from "node:assert/strict"
import test from "node:test"
import { evaluateCoinCoverage } from "../src/steps/step2-data-bootstrap/evaluate-coin-coverage.js"
import { createCoverageStudyRequests } from "../src/steps/step2-data-bootstrap/coverage-study-definitions.js"

function createMarket () {
  return {
    baseCurrencyId: "XTVCBTC",
    tradingViewSymbol: "BINANCE:BTCUSDT.P",
  }
}

function createCoin () {
  return {
    rank: 1,
    baseCurrencyId: "XTVCBTC",
    symbol: "BTC",
    name: "Bitcoin",
    tradingViewSymbol: "CRYPTO:BTCUSD",
    categories: ["layer-1"],
    circulatingSupply: 20_000_000,
    marketCap: 1_500_000_000_000,
    fullyDilutedValuation: 1_575_000_000_000,
    market: createMarket(),
  }
}

function createPeriods (
  hours,
  createValues,
  nowTimestamp = 1_800_000_000,
) {
  const latestClosedTime = Math.floor(nowTimestamp / 3_600) * 3_600 - 3_600

  return Array.from({ length: hours }, (_, index) => ({
    time: latestClosedTime - (hours - index - 1) * 3_600,
    ...createValues(index),
  }))
}

function createChartData ({
  chartBaseCurrencyId = "XTVCBTC",
  emptyStudyKey,
  fetchHours = 4,
  nowTimestamp = 1_800_000_000,
  rejectedStudyKey,
  volumeDeltaHours = 3,
} = {}) {
  const requests = createCoverageStudyRequests("CRYPTO:BTCUSD")
  const studies = Object.fromEntries(requests.map((request) => {
    if (request.key === rejectedStudyKey) {
      return [request.key, {
        status: "rejected",
        reason: new Error("Study unavailable"),
      }]
    }

    const fields = Object.keys(request.fields)
    const periods = createPeriods(
      request.key === "volumeDelta" ? volumeDeltaHours : fetchHours,
      () => Object.fromEntries(fields.map(field => [
        field,
        request.key === emptyStudyKey ? null : 0,
      ])),
      nowTimestamp,
    )

    return [request.key, {
      status: "fulfilled",
      value: {
        fields: request.fields,
        periods,
        coverage: {
          sourcePeriodCount: periods.length,
        },
      },
    }]
  }))

  return {
    chart: {
      info: {
        fullName: "BINANCE:BTCUSDT.P",
        baseCurrencyId: chartBaseCurrencyId,
      },
      periods: createPeriods(fetchHours, () => ({
        open: 1,
        max: 2,
        min: 0.5,
        close: 1.5,
        volume: 0,
      }), nowTimestamp),
    },
    studies,
  }
}

function evaluate (chartData, coin = createCoin(), options = {}) {
  return evaluateCoinCoverage(
    coin,
    chartData,
    {
      fetchHours: 4,
      nowTimestamp: 1_800_000_000,
      volumeDeltaHours: 3,
      ...options,
    },
  )
}

function assertRecheckBoundary (chartData, key, recheckAfter, options = {}) {
  const result = evaluate(chartData, createCoin(), options)
  const coverage = key === "ohlcv" ? result.coverage.ohlcv : result.coverage.studies[key]
  const source = key === "ohlcv" ? chartData.chart : chartData.studies[key].value

  assert.equal(coverage.complete, false)
  assert.equal(coverage.recheckAfter, recheckAfter)

  for (const [offset, complete] of [[-1, false], [0, true]]) {
    const nowTimestamp = Date.parse(recheckAfter) / 1_000 + offset
    const shiftedData = createChartData({ ...options, nowTimestamp })
    const shiftedSource = key === "ohlcv" ? shiftedData.chart : shiftedData.studies[key].value

    shiftedSource.periods = [
      ...source.periods,
      ...shiftedSource.periods.filter(period => period.time > coverage.latestExpectedTime),
    ]

    const shiftedResult = evaluate(shiftedData, createCoin(), { ...options, nowTimestamp })
    const shiftedCoverage = key === "ohlcv"
      ? shiftedResult.coverage.ohlcv
      : shiftedResult.coverage.studies[key]

    assert.equal(shiftedCoverage.complete, complete)
    assert.equal(shiftedCoverage.recheckAfter, complete ? null : recheckAfter)
  }

  return result
}

test("coverage requires 2400 complete hours and 1666 Volume Delta hours", () => {
  const result = evaluateCoinCoverage(
    createCoin(),
    createChartData({
      fetchHours: 2_400,
      volumeDeltaHours: 1_666,
    }),
    { nowTimestamp: 1_800_000_000 },
  )

  assert.equal(result.complete, true)
  assert.equal(result.coverage.social.status, "available")
  assert.equal(result.coverage.ohlcv.completePeriodCount, 2_400)

  for (const coverage of [result.coverage.ohlcv, ...Object.values(result.coverage.studies)]) {
    assert.equal(coverage.recheckAfter, null)
  }

  assert.equal(
    result.coverage.studies.volumeDelta.completePeriodCount,
    1_666,
  )
  assert.equal(
    result.coverage.studies.openInterest.completePeriodCount,
    2_400,
  )
})

test("coverage accepts zero values and ignores the unfinished current hour", () => {
  const chartData = createChartData()

  chartData.chart.periods.push({
    time: 1_800_000_000,
    open: null,
    max: null,
    min: null,
    close: null,
    volume: null,
  })
  chartData.studies.premium.value.periods.push({
    time: 1_800_000_000,
    close: null,
  })

  const result = evaluate(chartData)

  assert.equal(result.complete, true)
  assert.equal(result.retryable, false)
  assert.deepEqual(result.reasonCodes, [])
  assert.equal(result.coverage.ohlcv.completePeriodCount, 4)
  assert.equal(result.coverage.studies.liquidations.completePeriodCount, 4)
})

test("coverage rejects a missing OHLCV hour", () => {
  const chartData = createChartData()
  chartData.chart.periods.splice(1, 1)

  const result = evaluate(chartData)

  assert.equal(result.complete, false)
  assert.equal(result.coverage.ohlcv.missingPeriodCount, 1)
  assert.ok(result.reasonCodes.includes("ohlcv:missing_hours"))
})

test("coverage rejects duplicate and off-grid OHLCV hours", () => {
  const duplicateData = createChartData()
  duplicateData.chart.periods.push({ ...duplicateData.chart.periods[1] })

  const duplicateResult = evaluate(duplicateData)

  assert.equal(duplicateResult.coverage.ohlcv.duplicatePeriodCount, 1)
  assert.ok(duplicateResult.reasonCodes.includes("ohlcv:duplicate_hours"))

  const offGridData = createChartData()
  offGridData.chart.periods[1].time += 1_800
  const offGridResult = evaluate(offGridData)

  assert.equal(offGridResult.coverage.ohlcv.offGridPeriodCount, 1)
  assert.ok(offGridResult.reasonCodes.includes("ohlcv:off_grid_hours"))
})

test("coverage rejects duplicate and invalid study timestamps", () => {
  const chartData = createChartData()
  const premium = chartData.studies.premium.value

  premium.periods.push({ ...premium.periods[1] })
  premium.coverage.duplicatePeriodCount = 1
  premium.coverage.invalidTimestampCount = 1

  const result = evaluate(chartData)

  assert.equal(result.complete, false)
  assert.equal(result.coverage.studies.premium.duplicatePeriodCount, 1)
  assert.equal(result.coverage.studies.premium.invalidTimestampCount, 1)
  assert.ok(result.reasonCodes.includes("premium:duplicate_hours"))
  assert.ok(result.reasonCodes.includes("premium:invalid_timestamps"))
})

test("coverage rejects null and NaN study values without treating them as zero", () => {
  const chartData = createChartData()
  chartData.studies.premium.value.periods[1].close = null
  chartData.studies.openInterest.value.periods[2].close = Number.NaN

  const result = evaluate(chartData)

  assert.equal(result.complete, false)
  assert.equal(
    result.coverage.studies.premium.fieldMissingValueCounts.close,
    1,
  )
  assert.equal(
    result.coverage.studies.openInterest.fieldMissingValueCounts.close,
    1,
  )
  assert.ok(result.reasonCodes.includes("premium:missing_values"))
  assert.ok(result.reasonCodes.includes("openInterest:missing_values"))
})

test("coverage requires numeric values for both Liquidations sides in every hour", () => {
  const chartData = createChartData()
  chartData.studies.liquidations.value.periods[1].short = null

  const result = evaluate(chartData)

  assert.equal(result.complete, false)
  assert.equal(
    result.coverage.studies.liquidations.fieldMissingValueCounts.short,
    1,
  )
  assert.ok(result.reasonCodes.includes("liquidations:missing_values"))
  assert.deepEqual(result.unavailableMetrics, [])
})

test("coverage marks a completely empty Liquidations study as unavailable", () => {
  const result = evaluate(createChartData({
    emptyStudyKey: "liquidations",
  }))

  assert.equal(result.complete, false)
  assert.equal(result.retryable, true)
  assert.deepEqual(result.unavailableMetrics, ["liquidations"])
  assert.ok(result.reasonCodes.includes("liquidations:missing_values"))
  assert.ok(result.reasonCodes.includes("liquidations:unavailable"))
  assert.equal(result.coverage.studies.liquidations.recheckAfter, null)
})

test("coverage accepts the shorter Volume Delta window but requires every hour in it", () => {
  const completeResult = evaluate(createChartData())

  assert.equal(completeResult.complete, true)
  assert.equal(
    completeResult.coverage.studies.volumeDelta.requiredHours,
    3,
  )

  const incompleteData = createChartData()
  incompleteData.studies.volumeDelta.value.periods.splice(1, 1)
  const incompleteResult = evaluate(incompleteData)

  assert.equal(incompleteResult.complete, false)
  assert.ok(incompleteResult.reasonCodes.includes("volumeDelta:missing_hours"))
})

test("coverage marks a completely absent dense metric as unavailable", () => {
  const result = evaluate(createChartData({ emptyStudyKey: "premium" }))

  assert.equal(result.complete, false)
  assert.equal(result.retryable, true)
  assert.deepEqual(result.unavailableMetrics, ["premium"])
  assert.ok(result.reasonCodes.includes("premium:missing_values"))
  assert.ok(result.reasonCodes.includes("premium:unavailable"))
  assert.equal(result.coverage.studies.premium.recheckAfter, null)
})

test("coverage does not permanently exclude a partially populated metric", () => {
  const chartData = createChartData({ emptyStudyKey: "premium" })
  const premium = chartData.studies.premium.value

  for (const field of Object.keys(premium.fields)) {
    premium.periods[1][field] = 0
  }

  const result = assertRecheckBoundary(
    chartData,
    "premium",
    new Date((1_800_000_000 + 4 * 3_600) * 1_000).toISOString(),
  )

  assert.equal(result.complete, false)
  assert.equal(result.retryable, false)
  assert.deepEqual(result.unavailableMetrics, [])
  assert.ok(result.reasonCodes.includes("premium:missing_values"))
})

test("coverage accepts a coin when one social study is rejected", () => {
  const result = evaluate(createChartData({
    rejectedStudyKey: "activeContributors",
  }))

  assert.equal(result.complete, true)
  assert.equal(result.retryable, false)
  assert.deepEqual(result.unavailableMetrics, [])
  assert.equal(result.coverage.social.status, "unavailable")
  assert.deepEqual(
    result.coverage.social.unavailableMetrics,
    ["activeContributors"],
  )
  assert.deepEqual(
    result.coverage.social.reasonCodes,
    ["activeContributors:request_failed"],
  )
})

test("coverage treats a partially populated social study as unavailable", () => {
  const chartData = createChartData()
  chartData.studies.interactions.value.periods[1].value = null

  const result = assertRecheckBoundary(
    chartData,
    "interactions",
    new Date((1_800_000_000 + 2 * 3_600) * 1_000).toISOString(),
  )

  assert.equal(result.complete, true)
  assert.equal(result.retryable, false)
  assert.deepEqual(result.reasonCodes, [])
  assert.deepEqual(result.unavailableMetrics, [])
  assert.equal(result.coverage.social.status, "unavailable")
  assert.deepEqual(result.coverage.social.unavailableMetrics, ["interactions"])
  assert.deepEqual(
    result.coverage.social.reasonCodes,
    ["interactions:missing_values"],
  )
})

test("coverage classifies a rejected Liquidations study as unavailable", () => {
  const result = evaluate(createChartData({
    rejectedStudyKey: "liquidations",
  }))

  assert.equal(result.complete, false)
  assert.equal(result.retryable, true)
  assert.deepEqual(result.unavailableMetrics, ["liquidations"])
  assert.ok(result.reasonCodes.includes("liquidations:request_failed"))
})

test("coverage does not blacklist metrics during a systemic study failure", () => {
  const chartData = createChartData()

  for (const key of Object.keys(chartData.studies)) {
    chartData.studies[key] = {
      status: "rejected",
      reason: new Error("Study subsystem unavailable"),
    }
  }

  const result = evaluate(chartData)

  assert.equal(result.complete, false)
  assert.equal(result.retryable, true)
  assert.deepEqual(result.unavailableMetrics, [])
})

test("coverage rejects a chart whose live baseCurrencyId differs", () => {
  const result = evaluate(createChartData({
    chartBaseCurrencyId: "XTVC1000BTC",
  }))

  assert.equal(result.complete, false)
  assert.ok(result.reasonCodes.includes("chart:identity_mismatch"))
})

test("coverage accepts missing optional chart identity when the exact symbol matches", () => {
  const result = evaluate(createChartData({ chartBaseCurrencyId: null }))

  assert.equal(result.complete, true)
  assert.equal(result.reasonCodes.includes("chart:identity_mismatch"), false)
})

test("coverage requires the loaded chart symbol", () => {
  const chartData = createChartData()
  chartData.chart.info.fullName = null

  const result = evaluate(chartData)

  assert.equal(result.complete, false)
  assert.ok(result.reasonCodes.includes("chart:symbol_missing"))
})

test("coverage allows empty categories but rejects missing required metadata", () => {
  const coin = createCoin()
  coin.categories = []
  coin.fullyDilutedValuation = null

  const result = evaluate(createChartData(), coin)

  assert.equal(result.complete, false)
  assert.equal(result.reasonCodes.includes("metadata:categories_missing"), false)
  assert.ok(
    result.reasonCodes.includes("metadata:fullyDilutedValuation_missing"),
  )
})

for (const key of ["ohlcv", "premium"]) {
  for (const [label, missingIndexes, waitHours] of [
    ["one leading gap", [0], 1],
    ["a missing prefix", [0, 1], 2],
    ["an internal gap", [2], 3],
    ["the latest hour missing", [3], 4],
    ["the latest of multiple gaps", [0, 2], 3],
  ]) {
    test(`${key} recheck waits for ${label} to leave the closed-hour window`, () => {
      const chartData = createChartData()
      const source = key === "ohlcv" ? chartData.chart : chartData.studies[key].value
      source.periods = source.periods.filter((_, index) => !missingIndexes.includes(index)).reverse()

      const result = assertRecheckBoundary(
        chartData,
        key,
        new Date((1_800_000_000 + waitHours * 3_600) * 1_000).toISOString(),
      )
      const coverage = key === "ohlcv" ? result.coverage.ohlcv : result.coverage.studies[key]

      assert.equal(result.complete, false)
      assert.equal(result.retryable, false)
      assert.deepEqual(result.unavailableMetrics, [])
      assert.deepEqual(result.reasonCodes, [`${key}:missing_hours`, `${key}:missing_values`])
      assert.equal(coverage.missingPeriodCount, missingIndexes.length)
      assert.equal(coverage.completePeriodCount, 4 - missingIndexes.length)
    })
  }

  test(`${key} recheck ignores old, current and future observations outside its window`, () => {
    const chartData = createChartData()
    const source = key === "ohlcv" ? chartData.chart : chartData.studies[key].value
    source.periods.shift()
    source.periods.push(...[
      1_800_000_000 - 5 * 3_600,
      1_800_000_000 - 5 * 3_600,
      1_800_000_000 - 5 * 3_600 + 1_800,
      1_800_000_000,
      1_800_000_000 + 3_600,
      1_800_000_000 + 3_600,
      1_800_000_000 + 5_400,
    ].map(time => ({ time })))

    const result = evaluate(chartData)
    const coverage = key === "ohlcv" ? result.coverage.ohlcv : result.coverage.studies[key]

    assert.equal(
      coverage.recheckAfter,
      new Date((1_800_000_000 + 3_600) * 1_000).toISOString(),
    )
    assert.equal(coverage.periodCount, 3)
    assert.equal(coverage.duplicatePeriodCount, 0)
    assert.equal(coverage.offGridPeriodCount, 0)
  })

  for (const [label, corrupt] of [
    ["duplicate hours", periods => periods.push({ ...periods[0] })],
    ["off-grid hours", (periods) => {
      periods[0].time += 1_800
    }],
    ["invalid timestamps", (periods) => {
      periods[0].time = Number.NaN
    }],
  ]) {
    test(`${key} has no precise recheck deadline with gaps and ${label}`, () => {
      const chartData = createChartData()
      const source = key === "ohlcv" ? chartData.chart : chartData.studies[key].value
      source.periods.shift()
      corrupt(source.periods)

      const result = evaluate(chartData)
      const coverage = key === "ohlcv" ? result.coverage.ohlcv : result.coverage.studies[key]

      assert.equal(result.complete, false)
      assert.ok(coverage.missingPeriodCount > 0)
      assert.ok(Object.values(coverage.fieldValueCounts).some(count => count > 0))
      assert.equal(coverage.recheckAfter, null)
    })
  }

  for (const [label, createMissingPeriods] of [
    ["empty history", () => []],
    ["no numeric values", periods => periods.map(({ time }) => ({ time }))],
    ["numeric observations only outside the window", periods => [
      { ...periods[0], time: 1_800_000_000 - 5 * 3_600 },
      { ...periods.at(-1), time: 1_800_000_000 + 3_600 },
    ]],
  ]) {
    test(`${key} has no recheck deadline for ${label}`, () => {
      const chartData = createChartData()
      const source = key === "ohlcv" ? chartData.chart : chartData.studies[key].value
      source.periods = createMissingPeriods(source.periods)

      const result = evaluate(chartData)
      const coverage = key === "ohlcv" ? result.coverage.ohlcv : result.coverage.studies[key]

      assert.equal(result.complete, false)
      assert.equal(coverage.recheckAfter, null)
      assert.ok(Object.values(coverage.fieldValueCounts).every(count => count === 0))
    })
  }
}

test("OHLCV recheck uses the latest gap without adding overlapping hour and value shortages", () => {
  const chartData = createChartData()
  chartData.chart.periods[1].open = null
  chartData.chart.periods[1].close = Number.NaN
  chartData.chart.periods[2].min = "0"
  chartData.chart.periods[2].volume = Infinity
  chartData.chart.periods.shift()

  const result = assertRecheckBoundary(
    chartData,
    "ohlcv",
    new Date((1_800_000_000 + 3 * 3_600) * 1_000).toISOString(),
  )

  assert.equal(result.coverage.ohlcv.missingPeriodCount, 1)
  assert.equal(result.coverage.ohlcv.completePeriodCount, 1)
  assert.equal(result.coverage.ohlcv.fieldValueCounts.volume, 2)
  assert.deepEqual(result.coverage.ohlcv.fieldMissingValueCounts, {
    open: 2,
    max: 1,
    min: 2,
    close: 2,
    volume: 2,
  })
  assert.deepEqual(result.reasonCodes, ["ohlcv:missing_hours", "ohlcv:missing_values"])
})

test("study recheck counts overlapping missing fields and hours once, accepting zeros", () => {
  const chartData = createChartData()
  const liquidations = chartData.studies.liquidations.value
  liquidations.periods[1].long = Number.NaN
  liquidations.periods[1].short = null
  liquidations.periods.shift()

  const result = assertRecheckBoundary(
    chartData,
    "liquidations",
    new Date((1_800_000_000 + 2 * 3_600) * 1_000).toISOString(),
  )

  assert.equal(result.coverage.studies.liquidations.completePeriodCount, 2)
  assert.deepEqual(result.coverage.studies.liquidations.fieldMissingValueCounts, { long: 2, short: 2 })
  assert.deepEqual(result.unavailableMetrics, [])
  assert.equal(result.retryable, false)
})

test("study recheck requires some numeric data, not numeric data in every field", () => {
  const chartData = createChartData()

  for (const period of chartData.studies.liquidations.value.periods) {
    period.short = null
  }

  const result = assertRecheckBoundary(
    chartData,
    "liquidations",
    new Date((1_800_000_000 + 4 * 3_600) * 1_000).toISOString(),
  )

  assert.deepEqual(result.coverage.studies.liquidations.fieldValueCounts, { long: 4, short: 0 })
  assert.deepEqual(result.unavailableMetrics, [])
})

test("study recheck is null when invalid timestamps were removed upstream", () => {
  const chartData = createChartData()
  chartData.studies.premium.value.periods.shift()
  chartData.studies.premium.value.coverage.invalidTimestampCount = 1

  const result = evaluate(chartData)

  assert.equal(result.coverage.studies.premium.missingPeriodCount, 1)
  assert.equal(result.coverage.studies.premium.invalidTimestampCount, 1)
  assert.equal(result.coverage.studies.premium.recheckAfter, null)
  assert.ok(result.reasonCodes.includes("premium:invalid_timestamps"))
})

test("study recheck is null without a field list", () => {
  const chartData = createChartData()
  chartData.studies.premium.value.fields = {}
  chartData.studies.premium.value.periods.shift()

  const result = evaluate(chartData)

  assert.equal(result.coverage.studies.premium.recheckAfter, null)
  assert.ok(result.reasonCodes.includes("premium:missing_fields"))
})

test("missing, rejected and invalid study results expose no recheck deadline", () => {
  for (const study of [undefined, { status: "rejected", reason: "Unavailable" }, { status: "invalid" }]) {
    const chartData = createChartData()
    chartData.studies.premium = study

    const result = evaluate(chartData)

    assert.equal(result.complete, false)
    assert.equal(result.retryable, true)
    assert.equal(result.coverage.studies.premium.recheckAfter, null)
  }
})

test("2388 of 2400 hours rechecks after 12 closed hours, not twice the shortage", () => {
  const chartData = createChartData({ fetchHours: 2_388, volumeDeltaHours: 1_666 })

  for (const key of ["ohlcv", "premium"]) {
    const result = assertRecheckBoundary(
      chartData,
      key,
      new Date((1_800_000_000 + 12 * 3_600) * 1_000).toISOString(),
      { fetchHours: 2_400, volumeDeltaHours: 1_666, nowTimestamp: 1_800_000_789 },
    )
    const coverage = key === "ohlcv" ? result.coverage.ohlcv : result.coverage.studies[key]

    assert.equal(coverage.missingPeriodCount, 12)
    assert.equal(result.coverage.studies.volumeDelta.recheckAfter, null)
  }
})

test("Volume Delta uses 1666 hours rather than the general 2400-hour recheck window", () => {
  const chartData = createChartData({ fetchHours: 2_400, volumeDeltaHours: 1_666 })
  const missingTime = chartData.studies.volumeDelta.value.periods[0].time

  for (const key of ["volumeDelta", "premium"]) {
    const study = chartData.studies[key].value
    study.periods = study.periods.filter(period => period.time !== missingTime)
  }

  for (const [key, waitHours] of [["volumeDelta", 1], ["premium", 735]]) {
    assertRecheckBoundary(
      chartData,
      key,
      new Date((1_800_000_000 + waitHours * 3_600) * 1_000).toISOString(),
      { fetchHours: 2_400, volumeDeltaHours: 1_666 },
    )
  }
})

test("recheck deadlines do not drift with seconds or minutes within the reference hour", () => {
  for (const nowTimestamp of [1_800_000_000, 1_800_000_123, 1_800_003_599.75]) {
    const chartData = createChartData({ nowTimestamp })
    chartData.studies.premium.value.periods.splice(0, 2)

    assertRecheckBoundary(
      chartData,
      "premium",
      new Date((1_800_000_000 + 2 * 3_600) * 1_000).toISOString(),
      { nowTimestamp },
    )
  }
})

for (const [referenceTime, recheckAfter] of [
  ["2026-01-31T23:37:42Z", "2026-02-01T01:00:00.000Z"],
  ["2026-12-31T23:59:59Z", "2027-01-01T01:00:00.000Z"],
]) {
  test(`recheck crosses the date boundary from ${referenceTime} without drifting`, () => {
    const nowTimestamp = Date.parse(referenceTime) / 1_000
    const chartData = createChartData({ nowTimestamp })
    chartData.chart.periods.splice(0, 2)

    assertRecheckBoundary(chartData, "ohlcv", recheckAfter, { nowTimestamp })
  })
}
