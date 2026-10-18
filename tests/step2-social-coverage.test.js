import assert from "node:assert/strict"
import test from "node:test"

import { getActiveCoverageExclusionIds } from "../src/helpers/coverage-exclusions-helper.js"
import { createCoinDataCoverageChecker } from "../src/steps/step2-data-bootstrap/check-coin-data-coverage.js"
import { createCoverageStudyRequests } from "../src/steps/step2-data-bootstrap/coverage-study-definitions.js"

function createFixture () {
  const nowTimestamp = Date.UTC(2026, 9, 18, 12, 30) / 1_000
  const latestClosedTime = Math.floor(nowTimestamp / 3_600) * 3_600 - 3_600
  const coin = {
    symbol: "TEST",
    name: "Test coin",
    baseCurrencyId: "XTVCTEST",
    tradingViewSymbol: "CRYPTO:TESTUSD",
    circulatingSupply: 1_000_000,
    marketCap: 100_000_000,
    fullyDilutedValuation: 200_000_000,
    market: { tradingViewSymbol: "BINANCE:TESTUSDT.P", baseCurrencyId: "XTVCTEST" },
  }
  const periods = Array.from({ length: 2_401 }, (_, index) => ({
    time: latestClosedTime - (2_399 - index) * 3_600,
    open: 100, max: 101, min: 99, close: 100, volume: 10,
  }))

  return {
    coin,
    nowTimestamp,
    chartData: {
      chart: {
        info: { fullName: coin.market.tradingViewSymbol, baseCurrencyId: coin.baseCurrencyId },
        periods,
      },
      studies: Object.fromEntries(createCoverageStudyRequests(coin.tradingViewSymbol).map(request => [
        request.key,
        {
          status: "fulfilled",
          value: {
            request,
            fields: request.fields,
            periods: periods.map(({ time }) => ({
              time,
              ...Object.fromEntries(Object.keys(request.fields).map(field => [field, 1])),
            })),
          },
        },
      ])),
    },
  }
}

async function checkFixture ({ coin, nowTimestamp, chartData }) {
  const fetches = []
  const saved = []
  const checkCoverage = createCoinDataCoverageChecker({
    fetchChartStudies: async (_client, requests, options) => {
      fetches.push({ requests, options })
      return chartData
    },
    saveHourlyData: async (_coin, hourlyData) => {
      saved.push(hourlyData)
      return "in-memory"
    },
  })
  const result = await checkCoverage(null, coin, { nowTimestamp })

  assert.equal(result.complete, true)
  assert.equal(result.dataFile, "in-memory")
  assert.equal(saved.length, 1)

  return { result, hourlyData: saved[0], ...fetches[0] }
}

test("all five social studies are requested and saved with exactly 2400 closed hours", async () => {
  const fixture = createFixture()
  fixture.chartData.studies.activePosts.value.periods.at(-1).value = null
  const { result, hourlyData, requests, options } = await checkFixture(fixture)
  const socialKeys = ["socialDominance", "interactions", "activeContributors", "activePosts", "createdPosts"]

  assert.deepEqual(requests.filter(request => request.group === "social").map(request => request.key), socialKeys)
  const activePosts = requests.find(request => request.key === "activePosts")
  assert.equal(activePosts.id, "STD;CryptoFund_posts_active")
  assert.equal(activePosts.version, "7.0")
  assert.deepEqual(activePosts.fields, { value: "Active_posts" })
  assert.deepEqual(activePosts.inputs, { in_0: fixture.coin.tradingViewSymbol })
  assert.equal(options.timeframe, "60")
  assert.equal(options.range, 2_401)
  assert.equal(options.to, Math.floor(fixture.nowTimestamp / 3_600) * 3_600 - 1)
  assert.equal(hourlyData.chart.periods.length, 2_400)
  assert.equal(hourlyData.studies.volumeDelta.periods.length, 1_666)
  assert.deepEqual(hourlyData.availability.social, {
    status: "available", unavailableMetrics: [], reasonCodes: [],
  })

  for (const key of socialKeys) {
    assert.equal(result.coverage.studies[key].requiredHours, 2_400)
    assert.deepEqual(hourlyData.studies[key].periods, fixture.chartData.studies[key].value.periods.slice(0, 2_400))
    assert.equal(hourlyData.studies[key].coverage.completePeriods, 2_400)
  }
})

for (const { label, reasonCode, invalidate } of [
  {
    label: "missing result",
    reasonCode: "missing_result",
    invalidate: (studies) => {
      delete studies.activePosts
    },
  },
  {
    label: "rejected request",
    reasonCode: "request_failed",
    invalidate: (studies) => {
      studies.activePosts = { status: "rejected", reason: new Error("Study unavailable") }
    },
  },
  {
    label: "missing closed hour",
    reasonCode: "missing_hours",
    invalidate: studies => studies.activePosts.value.periods.shift(),
  },
  {
    label: "null value",
    reasonCode: "missing_values",
    invalidate: (studies) => {
      studies.activePosts.value.periods[100].value = null
    },
  },
]) {
  test(`activePosts ${label} disables all social studies without rejecting the complete core`, async () => {
    const fixture = createFixture()
    invalidate(fixture.chartData.studies)
    const { result, hourlyData } = await checkFixture(fixture)

    assert.deepEqual(result.reasonCodes, [])
    assert.deepEqual(result.unavailableMetrics, [])
    assert.equal(result.retryable, false)
    assert.equal(result.coverage.social.status, "unavailable")
    assert.deepEqual(result.coverage.social.unavailableMetrics, ["activePosts"])
    assert.ok(result.coverage.social.reasonCodes.includes(`activePosts:${reasonCode}`))
    assert.deepEqual(hourlyData.availability.social, {
      status: "unavailable",
      unavailableMetrics: ["activePosts"],
      reasonCodes: result.coverage.social.reasonCodes,
    })
    assert.deepEqual(Object.keys(hourlyData.studies), [
      "volumeDelta", "openInterest", "fundingRate", "liquidations",
      "longShortRatioAccounts", "topTradersLongShortPositions", "premium",
    ])
  })
}

test("zero activePosts values are complete data and are preserved", async () => {
  const fixture = createFixture()
  fixture.chartData.studies.activePosts.value.periods.forEach((period) => {
    period.value = 0
  })
  const { result, hourlyData } = await checkFixture(fixture)

  assert.equal(result.coverage.social.status, "available")
  assert.equal(result.coverage.studies.activePosts.unavailable, false)
  assert.equal(hourlyData.studies.activePosts.periods.length, 2_400)
  assert.ok(hourlyData.studies.activePosts.periods.every(period => period.value === 0))
})

test("activePosts-only coverage exclusions do not block coins, but core exclusions still do", () => {
  const exclusion = {
    symbol: "TEST",
    name: "Test coin",
    baseCurrencyId: "XTVCTEST",
    unavailableMetrics: ["activePosts"],
    reasonCodes: ["activePosts:missing_hours"],
    recheckAfter: "2026-11-18T12:00:00.000Z",
  }
  const now = new Date("2026-10-18T12:30:00.000Z")

  assert.equal(getActiveCoverageExclusionIds([exclusion], { now }).size, 0)
  assert.deepEqual([...getActiveCoverageExclusionIds([
    { ...exclusion, unavailableMetrics: ["activePosts", "openInterest"] },
  ], { now })], [exclusion.baseCurrencyId])
})
