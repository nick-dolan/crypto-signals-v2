import assert from "node:assert/strict"
import test from "node:test"
import { createDataBootstrapDescription } from "../src/steps/step2-data-bootstrap/build-data-bootstrap-report.js"

test("data bootstrap report describes strict hourly coverage", () => {
  assert.deepEqual(createDataBootstrapDescription(), {
    timeframe: "1h",
    requestedHours: 2_400,
    requestRange: 2_401,
    dataDirectory: "tmp/step2-data-bootstrap",
    requireCompleteHourlyGrid: true,
    requiredHoursBySource: {
      ohlcv: 2_400,
      volumeDelta: 1_666,
      openInterest: 2_400,
      fundingRate: 2_400,
      liquidations: 2_400,
      longShortRatioAccounts: 2_400,
      topTradersLongShortPositions: 2_400,
      premium: 2_400,
      socialDominance: 2_400,
      interactions: 2_400,
      activeContributors: 2_400,
      createdPosts: 2_400,
    },
    unavailableMetricConfirmationAttempts: 2,
    requiredStudies: [
      "volumeDelta",
      "openInterest",
      "fundingRate",
      "liquidations",
      "longShortRatioAccounts",
      "topTradersLongShortPositions",
      "premium",
      "socialDominance",
      "interactions",
      "activeContributors",
      "createdPosts",
    ],
    requiredMetadata: [
      "circulatingSupply",
      "marketCap",
      "fullyDilutedValuation",
    ],
    optionalMetadata: ["categories"],
  })
})
