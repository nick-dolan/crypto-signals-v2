import assert from "node:assert/strict"
import test from "node:test"
import {
  buildMarketBiasSnapshot,
} from "../src/steps/step1-market-bias/build-market-bias-snapshot.js"

const MARKET_CAP_PERIOD = {
  time: 1_800_000_000,
  open: 1,
  max: 2,
  min: 1,
  close: 2,
  volume: 0,
}

const MARKET_CAPS = {
  BTC_CAP: {
    symbol: "CRYPTOCAP:BTC",
    timeframe: "60",
    candleCount: 1,
    periods: [MARKET_CAP_PERIOD],
  },
  ALT_CAP: {
    symbol: "CRYPTOCAP:TOTAL2ES",
    timeframe: "60",
    candleCount: 1,
    periods: [MARKET_CAP_PERIOD],
  },
  STABLE_CAP: {
    symbol: "CRYPTOCAP:TOTAL-CRYPTOCAP:TOTALES",
    timeframe: "60",
    candleCount: 1,
    periods: [MARKET_CAP_PERIOD],
  },
}

const FEAR_AND_GREED_PAYLOAD = {
  name: "Fear and Greed Index",
  data: [
    {
      value: "74",
      value_classification: "Greed",
      timestamp: "1787616000",
    },
  ],
  metadata: {
    error: null,
  },
}

test("market bias snapshot normalizes the latest Fear and Greed Index", () => {
  const snapshot = buildMarketBiasSnapshot(
    FEAR_AND_GREED_PAYLOAD,
    MARKET_CAPS,
    {
      generatedAt: "2026-08-25T12:00:00.000Z",
    },
  )

  assert.deepEqual(snapshot, {
    generatedAt: "2026-08-25T12:00:00.000Z",
    fearAndGreedIndex: {
      value: 74,
      classification: "Greed",
      asOf: "2026-08-25T00:00:00.000Z",
    },
    marketCaps: MARKET_CAPS,
  })
})

test("market bias snapshot rejects a response without index data", () => {
  assert.throws(
    () => buildMarketBiasSnapshot({ data: [] }, MARKET_CAPS),
    /does not contain data/,
  )
})

test("market bias snapshot rejects an index value outside 0-100", () => {
  assert.throws(
    () => buildMarketBiasSnapshot(
      {
        data: [
          {
            value: "101",
            value_classification: "Greed",
            timestamp: "1787616000",
          },
        ],
      },
      MARKET_CAPS,
    ),
    /must be between 0 and 100/,
  )
})
