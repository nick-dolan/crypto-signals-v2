import assert from "node:assert/strict"
import test from "node:test"
import { evaluateCoinCoverage } from "../src/steps/step2-data-coverage/evaluate-coin-coverage.js"
import { createCoverageStudyRequests } from "../src/steps/step2-data-coverage/coverage-study-definitions.js"

const LATEST_TIME = 1_800_000_000

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
  }
}

function createMarket () {
  return {
    baseCurrencyId: "XTVCBTC",
    tradingViewSymbol: "BINANCE:BTCUSDT.P",
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
    const periods = createPeriods(4, index => Object.fromEntries(
      fields.map(field => [
        field,
        request.key === emptyStudyKey
          ? null
          : request.key === "liquidations" && index < 3
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
      periods: createPeriods(4, () => ({
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

function evaluate (chartData, coin = createCoin()) {
  return evaluateCoinCoverage(
    coin,
    createMarket(),
    chartData,
    {
      maxStalenessHours: 2,
      minDenseValues: 2,
      nowTimestamp: LATEST_TIME,
      probeHours: 4,
    },
  )
}

test("coverage accepts all required studies and numeric zero values", () => {
  const result = evaluate(createChartData())

  assert.equal(result.complete, true)
  assert.equal(result.retryable, false)
  assert.deepEqual(result.reasonCodes, [])
  assert.equal(result.coverage.studies.liquidations.availablePeriodCount, 1)
  assert.equal(result.coverage.studies.premium.fieldValueCounts.close, 4)
})

test("coverage rejects Premium with no numeric values", () => {
  const result = evaluate(createChartData({ emptyStudyKey: "premium" }))

  assert.equal(result.complete, false)
  assert.equal(result.retryable, false)
  assert.ok(result.reasonCodes.includes("premium:insufficient_values"))
  assert.ok(result.reasonCodes.includes("premium:stale"))
})

test("coverage rejects Liquidations with no numeric events in the window", () => {
  const result = evaluate(createChartData({ emptyStudyKey: "liquidations" }))

  assert.equal(result.complete, false)
  assert.equal(result.retryable, false)
  assert.ok(result.reasonCodes.includes("liquidations:no_values"))
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
