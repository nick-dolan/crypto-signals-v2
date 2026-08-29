import assert from "node:assert/strict"
import test from "node:test"
import {
  createMarketCapSeriesFetcher,
  MARKET_CAP_CANDLE_COUNT,
  MARKET_CAP_TIMEFRAME,
} from "../src/steps/step1-market-bias/fetch-market-cap-series.js"

function createPeriods (count = MARKET_CAP_CANDLE_COUNT) {
  return Array.from({ length: count }, (_, index) => ({
    time: 1_800_000_000 - index * 3_600,
    open: index + 1,
    max: index + 2,
    min: index,
    close: index + 1.5,
    volume: 0,
  }))
}

test("market-cap fetcher requests 300 hourly periods for all regime series", async () => {
  const periods = createPeriods()
  const requests = []
  const client = {}
  const fetchMarketCapSeries = createMarketCapSeriesFetcher({
    fetchChartPeriods: async (receivedClient, options) => {
      requests.push({
        client: receivedClient,
        options,
      })

      return periods
    },
  })

  const result = await fetchMarketCapSeries(client)

  assert.deepEqual(
    requests.map(request => request.options),
    [
      {
        symbol: "CRYPTOCAP:BTC",
        timeframe: MARKET_CAP_TIMEFRAME,
        range: MARKET_CAP_CANDLE_COUNT,
      },
      {
        symbol: "CRYPTOCAP:TOTAL2ES",
        timeframe: MARKET_CAP_TIMEFRAME,
        range: MARKET_CAP_CANDLE_COUNT,
      },
      {
        symbol: "CRYPTOCAP:TOTAL-CRYPTOCAP:TOTALES",
        timeframe: MARKET_CAP_TIMEFRAME,
        range: MARKET_CAP_CANDLE_COUNT,
      },
    ],
  )
  assert.equal(requests.every(request => request.client === client), true)
  assert.deepEqual(Object.keys(result), ["BTC_CAP", "ALT_CAP", "STABLE_CAP"])
  assert.deepEqual(result.STABLE_CAP, {
    symbol: "CRYPTOCAP:TOTAL-CRYPTOCAP:TOTALES",
    timeframe: MARKET_CAP_TIMEFRAME,
    candleCount: MARKET_CAP_CANDLE_COUNT,
    periods,
  })
})

test("market-cap fetcher rejects an incomplete series", async () => {
  const fetchMarketCapSeries = createMarketCapSeriesFetcher({
    fetchChartPeriods: async (client, { symbol }) => symbol === "CRYPTOCAP:TOTAL2ES"
      ? createPeriods(MARKET_CAP_CANDLE_COUNT - 1)
      : createPeriods(),
  })

  await assert.rejects(
    fetchMarketCapSeries({}),
    error => (
      error instanceof AggregateError
      && error.message.includes(
        `ALT_CAP: ALT_CAP: expected ${MARKET_CAP_CANDLE_COUNT} periods, received ${MARKET_CAP_CANDLE_COUNT - 1}`,
      )
    ),
  )
})
