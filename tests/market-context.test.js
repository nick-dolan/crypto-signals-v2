import assert from "node:assert/strict"
import test from "node:test"

import { createMarketContextFetcher } from "../src/steps/step3-market-context/fetch-market-context.js"

function createHourlyPeriods (nowTimestamp, hours, closeOffset = 0) {
  const latestClosedTime = Math.floor(nowTimestamp / 3_600) * 3_600 - 3_600
  const earliestTime = latestClosedTime - (hours - 1) * 3_600

  return Array.from({ length: hours }, (_, index) => ({
    time: earliestTime + index * 3_600,
    open: closeOffset + index + 1,
    max: closeOffset + index + 2,
    min: closeOffset + index,
    close: closeOffset + index + 1.5,
  }))
}

test("market context fetcher loads four series on one closed hourly grid", async () => {
  const nowTimestamp = 1_800_000_123
  const calls = []
  const fetchMarketContext = createMarketContextFetcher({
    fetchChartPeriods: async (client, options) => {
      calls.push({ client, options })
      return createHourlyPeriods(nowTimestamp, 2, calls.length * 10)
    },
  })
  const client = { name: "client" }

  const result = await fetchMarketContext(client, {
    nowTimestamp,
    requestedHours: 2,
    settleDelayMs: 10,
    timeoutMs: 20,
  })

  assert.deepEqual(Object.keys(result.series), [
    "total",
    "totales",
    "total2es",
    "total3es",
  ])
  assert.deepEqual(calls.map(call => call.options.symbol), [
    "CRYPTOCAP:TOTAL",
    "CRYPTOCAP:TOTALES",
    "CRYPTOCAP:TOTAL2ES",
    "CRYPTOCAP:TOTAL3ES",
  ])

  for (const call of calls) {
    assert.equal(call.client, client)
    assert.deepEqual(call.options, {
      range: 3,
      settleDelayMs: 10,
      symbol: call.options.symbol,
      timeframe: "60",
      timeoutMs: 20,
      to: Math.floor(nowTimestamp / 3_600) * 3_600 - 1,
    })
  }

  assert.equal(result.collectedAt, new Date(nowTimestamp * 1_000).toISOString())
  assert.equal(result.source, "tradingview")
  assert.equal(result.timeframe, "1h")
  assert.equal(result.requestedHours, 2)
  assert.equal(result.series.total.periods.length, 2)
})

test("market context fetcher rejects an incomplete series", async () => {
  const nowTimestamp = 1_800_000_123
  const fetchMarketContext = createMarketContextFetcher({
    fetchChartPeriods: async (client, { symbol }) => createHourlyPeriods(
      nowTimestamp,
      symbol === "CRYPTOCAP:TOTAL2ES" ? 1 : 2,
    ),
  })

  await assert.rejects(
    fetchMarketContext({}, { nowTimestamp, requestedHours: 2 }),
    /CRYPTOCAP:TOTAL2ES does not contain a complete 2-hour history/,
  )
})
