import assert from "node:assert/strict"
import test from "node:test"

import { TradingViewError } from "@mathieuc/tradingview"

import { createTradingViewStudyFetcher } from "../src/api/tradingview/studies/study.js"
import { getActiveCoverageExclusionIds } from "../src/helpers/coverage-exclusions-helper.js"
import { createCoinDataCoverageChecker } from "../src/steps/step2-data-bootstrap/check-coin-data-coverage.js"
import { createCoverageStudyRequests } from "../src/steps/step2-data-bootstrap/coverage-study-definitions.js"
import { checkWithRetry } from "../src/steps/step2-data-bootstrap/data-coverage-helpers.js"

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

async function fetchRejectedStudy (request, error) {
  const fetchStudy = createTradingViewStudyFetcher({
    createIndicator: async () => ({ indicator: {}, metadata: {} }),
  })
  const chart = {
    createStudy: () => ({
      on (event, callback) {
        if (event === "error" && error) {
          queueMicrotask(() => callback(error))
        }
      },
      remove () {},
    }),
  }
  const [result] = await Promise.allSettled([
    fetchStudy(chart, request, { timeoutMs: 10 }),
  ])

  assert.equal(result.status, "rejected")

  if (error) {
    assert.equal(result.reason, error)
  }

  return result
}

test("missing CRYPTOFUND social series keep diagnostics and core data without error notifications", async (t) => {
  const fixture = createFixture()
  const socialKeys = ["socialDominance", "interactions", "activeContributors", "activePosts", "createdPosts"]

  for (const [index, key] of socialKeys.entries()) {
    const request = fixture.chartData.studies[key].value.request
    const metric = request.id.replace("STD;CryptoFund_", "").toUpperCase()
    const payload = {
      ctx: { symbol: `CRYPTOFUND:CRYPTO;TESTUSD;${metric}` },
      error: "Symbol resolve error: {symbol}",
    }
    const details = [index % 2 === 0 ? JSON.stringify(payload) : payload, undefined]
    const message = index % 2 === 0 ? details[0] : `Symbol resolve error: ${payload.ctx.symbol}`
    const error = new TradingViewError("STUDY_ERROR", `Study error: ${message}`, { details })
    fixture.chartData.studies[key] = await fetchRejectedStudy(request, error)

    assert.equal(error.details, details)
    assert.deepEqual(error.context, {
      source: "tradingview", operation: "wait_for_study", study: request.name || request.key,
      timeoutMs: 10, type: "unavailable",
    })
  }

  const { result, hourlyData } = await checkFixture(fixture)
  const reportError = t.mock.fn(async () => {})
  const checked = await checkWithRetry(async () => result, fixture.coin, 2, () => {}, { reportError })

  assert.equal(checked.attempts, 1)
  assert.equal(reportError.mock.callCount(), 0)
  assert.equal(result.coverage.social.status, "unavailable")
  assert.deepEqual(result.coverage.social.unavailableMetrics, socialKeys)
  assert.equal(result.requestErrors.length, 5)
  assert.equal(hourlyData.availability.social.status, "unavailable")
  assert.equal(Object.keys(hourlyData.studies).length, 7)

  for (const key of socialKeys) {
    assert.match(result.coverage.studies[key].error, /Symbol resolve error:/)
    assert.ok(result.coverage.social.reasonCodes.includes(`${key}:request_failed`))
    assert.equal(Object.hasOwn(hourlyData.studies, key), false)
  }
})

test("real social study failures still send error notifications", async (t) => {
  const unavailablePayload = {
    ctx: { symbol: "CRYPTOFUND:CRYPTO;TESTUSD;POSTS_ACTIVE" },
    error: "Symbol resolve error: {symbol}",
  }
  const malformedPayload = JSON.stringify(unavailablePayload).slice(0, -1)
  const cause = new Error("WebSocket connection closed")
  const networkError = new TradingViewError("DISCONNECTED", cause.message, {
    cause, details: { code: 1006, reason: "Connection lost" },
  })
  networkError.context = { operation: "receive_packet" }

  for (const { label, error } of [
    { label: "timeout" },
    { label: "network failure", error: networkError },
    {
      label: "connection failure with resolver diagnostics",
      error: new TradingViewError("CONNECTION_ERROR", "WebSocket connection closed", {
        details: [unavailablePayload],
      }),
    },
    {
      label: "script failure",
      error: new TradingViewError("STUDY_ERROR", "Study error: Script execution failed", {
        details: [{ ...unavailablePayload, error: "Script execution failed" }, unavailablePayload],
      }),
    },
    {
      label: "unresolved market symbol",
      error: new TradingViewError("STUDY_ERROR", "Study error: Symbol resolve error: BINANCE:TESTUSDT.P", {
        details: [{ ...unavailablePayload, ctx: { symbol: "BINANCE:TESTUSDT.P" } }],
      }),
    },
    {
      label: "malformed payload",
      error: new TradingViewError("STUDY_ERROR", `Study error: ${malformedPayload}`, {
        details: [malformedPayload],
      }),
    },
    {
      label: "unknown error",
      error: new TradingViewError("STUDY_ERROR", "Study error: Unknown study error", {
        details: ["Unknown study error"],
      }),
    },
  ]) {
    await t.test(label, async () => {
      const fixture = createFixture()
      fixture.chartData.studies.activePosts = await fetchRejectedStudy(
        fixture.chartData.studies.activePosts.value.request,
        error,
      )
      const { result } = await checkFixture(fixture)
      const reportError = t.mock.fn(async () => {})
      await checkWithRetry(async () => result, fixture.coin, 2, () => {}, { reportError })

      assert.equal(result.coverage.social.status, "unavailable")
      assert.equal(reportError.mock.callCount(), 1)
      assert.equal(reportError.mock.calls[0].arguments[0], fixture.chartData.studies.activePosts.reason)
    })
  }

  assert.equal(networkError.cause, cause)
  assert.equal(networkError.context.operation, "receive_packet")
  assert.equal(networkError.context.source, "tradingview")
})

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
