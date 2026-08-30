import assert from "node:assert/strict"
import test from "node:test"
import { createCoinDataCoverageChecker } from "../src/steps/step2-data-bootstrap/check-coin-data-coverage.js"

test("coverage checker fetches 100 days from the market attached by step 1", async () => {
  const expectedError = new Error("Stop after capturing the request")
  let capturedClient
  let capturedOptions
  let capturedRequests
  const checker = createCoinDataCoverageChecker({
    fetchChartStudies: async (client, requests, options) => {
      capturedClient = client
      capturedRequests = requests
      capturedOptions = options
      throw expectedError
    },
  })
  const client = { name: "client" }
  const coin = {
    tradingViewSymbol: "CRYPTO:BTCUSD",
    market: {
      tradingViewSymbol: "BINANCE:BTCUSDT.P",
    },
  }

  await assert.rejects(
    checker(client, coin, {
      chartSettleDelayMs: 10,
      probeHours: 24,
      studySettleDelayMs: 20,
      timeoutMs: 30,
    }),
    error => error === expectedError,
  )

  assert.equal(capturedClient, client)
  assert.equal(capturedOptions.symbol, coin.market.tradingViewSymbol)
  assert.equal(capturedOptions.timeframe, "60")
  assert.equal(capturedOptions.range, 2_400)
  assert.equal(capturedOptions.settleDelayMs, 10)
  assert.equal(capturedOptions.studySettleDelayMs, 20)
  assert.equal(capturedOptions.timeoutMs, 30)
  assert.equal(capturedRequests.at(-1).inputs.in_0, coin.tradingViewSymbol)
})
