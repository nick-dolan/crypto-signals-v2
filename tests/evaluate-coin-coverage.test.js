import assert from "node:assert/strict"
import test from "node:test"
import { evaluateCoinCoverage } from "../src/steps/step2-data-bootstrap/evaluate-coin-coverage.js"
import { createCoverageStudyRequests } from "../src/steps/step2-data-bootstrap/coverage-study-definitions.js"

const LATEST_TIME = 1_800_000_000

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

function createPeriods (count, createValues) {
  return Array.from({ length: count }, (_, index) => ({
    time: LATEST_TIME - (count - index - 1) * 3_600,
    ...createValues(index),
  }))
}

function createChartData ({
  chartBaseCurrencyId = "XTVCBTC",
  emptyStudyKey,
  periodCount = 4,
  rejectedStudyKey,
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
    const periods = createPeriods(periodCount, index => Object.fromEntries(
      fields.map(field => [
        field,
        request.key === emptyStudyKey
          ? null
          : request.key === "liquidations" && index < periodCount - 1
            ? null
            : 0,
      ]),
    ))

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
      periods: createPeriods(periodCount, () => ({
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
      fetchHours: 100,
      historyRequirements: {},
      maxStalenessHours: 2,
      minDenseValues: 2,
      nowTimestamp: LATEST_TIME,
      probeHours: 4,
      unavailableHistoryHours: 100,
      ...options,
    },
  )
}

test("coverage accepts all required studies and numeric zero values", () => {
  const result = evaluate(createChartData())

  assert.equal(result.complete, true)
  assert.equal(result.retryable, false)
  assert.deepEqual(result.reasonCodes, [])
  assert.equal(result.coverage.ohlcv.latestCompleteTime, LATEST_TIME)
  assert.equal(result.coverage.studies.liquidations.availablePeriodCount, 1)
  assert.equal(result.coverage.studies.premium.fieldValueCounts.close, 4)
})

test("coverage accepts sufficient calculation history", () => {
  const result = evaluate(createChartData({ periodCount: 10 }), createCoin(), {
    fetchHours: 10,
    historyMinRatio: 0.5,
    historyRequirements: {
      ohlcv: 8,
      premium: 8,
    },
    nowTimestamp: LATEST_TIME + 1_800,
    unavailableHistoryHours: 8,
  })

  assert.equal(result.complete, true)
  assert.equal(result.coverage.ohlcv.history.complete, true)
  assert.equal(result.coverage.studies.premium.history.complete, true)
})

test("coverage rejects Premium with no numeric values", () => {
  const result = evaluate(createChartData({ emptyStudyKey: "premium" }))

  assert.equal(result.complete, false)
  assert.equal(result.retryable, false)
  assert.deepEqual(result.unavailableMetrics, [])
  assert.ok(result.reasonCodes.includes("premium:insufficient_values"))
  assert.ok(result.reasonCodes.includes("premium:stale"))
})

test("coverage marks a completely absent dense metric as unavailable for a mature coin", () => {
  const result = evaluate(createChartData({
    emptyStudyKey: "premium",
    periodCount: 10,
  }), createCoin(), {
    fetchHours: 10,
    historyMinRatio: 0.5,
    unavailableHistoryHours: 8,
  })

  assert.equal(result.complete, false)
  assert.equal(result.retryable, true)
  assert.deepEqual(result.unavailableMetrics, ["premium"])
  assert.ok(result.reasonCodes.includes("premium:unavailable"))
})

test("coverage does not permanently exclude a metric with some history", () => {
  const chartData = createChartData({
    emptyStudyKey: "premium",
    periodCount: 10,
  })
  const premium = chartData.studies.premium.value

  for (const field of Object.keys(premium.fields)) {
    premium.periods.at(-1)[field] = 0
  }

  const result = evaluate(chartData, createCoin(), {
    fetchHours: 10,
    historyMinRatio: 0.5,
    historyRequirements: { premium: 8 },
    unavailableHistoryHours: 8,
  })

  assert.equal(result.complete, false)
  assert.equal(result.retryable, false)
  assert.deepEqual(result.unavailableMetrics, [])
  assert.ok(result.reasonCodes.includes("premium:insufficient_history"))
  assert.equal(result.coverage.studies.premium.history.complete, false)
})

test("coverage rejects Liquidations with no numeric events in the window", () => {
  const result = evaluate(createChartData({ emptyStudyKey: "liquidations" }))

  assert.equal(result.complete, false)
  assert.equal(result.retryable, false)
  assert.ok(result.reasonCodes.includes("liquidations:no_values"))
})

test("coverage requires numeric values for both Liquidations sides", () => {
  const chartData = createChartData()
  const periods = chartData.studies.liquidations.value.periods

  for (const period of periods) {
    period.short = null
  }

  const result = evaluate(chartData)

  assert.equal(result.complete, false)
  assert.equal(result.coverage.studies.liquidations.fieldValueCounts.long, 1)
  assert.equal(result.coverage.studies.liquidations.fieldValueCounts.short, 0)
  assert.ok(result.reasonCodes.includes("liquidations:no_values"))
})

test("coverage uses the latest complete OHLCV period for freshness", () => {
  const chartData = createChartData()

  chartData.chart.periods = createPeriods(6, index => (
    index < 3
      ? {
          open: 1,
          max: 2,
          min: 0.5,
          close: 1.5,
          volume: 0,
        }
      : {
          open: null,
          max: null,
          min: null,
          close: null,
          volume: null,
        }
  ))

  const result = evaluate(chartData, createCoin(), {
    minDenseValues: 2,
    probeHours: 6,
  })

  assert.equal(result.coverage.ohlcv.completePeriodCount, 3)
  assert.equal(
    result.coverage.ohlcv.latestCompleteTime,
    LATEST_TIME - 3 * 3_600,
  )
  assert.ok(result.reasonCodes.includes("ohlcv:stale"))
})

test("coverage checks dense study freshness for every field", () => {
  const chartData = createChartData()
  const periods = chartData.studies.premium.value.periods

  periods[2].close = null
  periods[3].close = null

  const result = evaluate(chartData, createCoin(), {
    maxStalenessHours: 1,
  })

  assert.equal(result.coverage.studies.premium.fieldValueCounts.close, 2)
  assert.equal(
    result.reasonCodes.includes("premium:insufficient_values"),
    false,
  )
  assert.ok(result.reasonCodes.includes("premium:stale"))
})

test("coverage measures study freshness from the current time", () => {
  const chartData = createChartData()

  for (const period of chartData.chart.periods) {
    period.time -= 24 * 3_600
  }

  for (const period of chartData.studies.premium.value.periods) {
    period.time -= 47 * 3_600
  }

  const result = evaluate(chartData, createCoin(), {
    maxStalenessHours: 24,
    probeHours: 72,
  })

  assert.equal(
    result.reasonCodes.includes("ohlcv:stale"),
    false,
  )
  assert.ok(result.reasonCodes.includes("premium:stale"))
})

test("coverage marks a failed Active Contributors request as retryable", () => {
  const result = evaluate(createChartData({
    rejectedStudyKey: "activeContributors",
  }))

  assert.equal(result.complete, false)
  assert.equal(result.retryable, true)
  assert.ok(result.reasonCodes.includes("activeContributors:request_failed"))
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
