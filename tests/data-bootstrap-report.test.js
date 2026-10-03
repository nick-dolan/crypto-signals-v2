import assert from "node:assert/strict"
import test from "node:test"
import { createDataBootstrapSummary } from "../src/steps/step2-data-bootstrap/build-data-bootstrap-report.js"

test("data bootstrap summary keeps only source metadata and counts", () => {
  assert.deepEqual(createDataBootstrapSummary({
    generatedAt: "2026-08-30T13:52:29.962Z",
    source: "tradingview",
    selection: {
      exchange: "BINANCE",
      quoteSymbol: "USDT",
      instrumentType: "swap",
      typeSpecification: "perpetual",
    },
    candidateCount: 250,
    coinCount: 249,
    coins: [{ symbol: "BTC" }],
    rejected: [{ symbol: "GRAM" }],
  }), {
    generatedAt: "2026-08-30T13:52:29.962Z",
    source: "tradingview",
    selection: {
      exchange: "BINANCE",
      quoteSymbol: "USDT",
      instrumentType: "swap",
      typeSpecification: "perpetual",
    },
    candidateCount: 250,
    coinCount: 249,
  })
})
