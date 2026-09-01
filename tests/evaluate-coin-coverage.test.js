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
      })),
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
})

test("coverage does not permanently exclude a partially populated metric", () => {
  const chartData = createChartData({ emptyStudyKey: "premium" })
  const premium = chartData.studies.premium.value

  for (const field of Object.keys(premium.fields)) {
    premium.periods[1][field] = 0
  }

  const result = evaluate(chartData)

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

  const result = evaluate(chartData)

  assert.equal(result.complete, true)
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
