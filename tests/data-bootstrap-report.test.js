import assert from "node:assert/strict"
import test from "node:test"
import { createDataBootstrapDescription } from "../src/steps/step2-data-bootstrap/build-data-bootstrap-report.js"

test("data bootstrap report describes collection and coverage windows", () => {
  assert.deepEqual(createDataBootstrapDescription(), {
    timeframe: "1h",
    requestedHours: 2_400,
    recentCoverage: {
      hours: 168,
      minDenseValues: 120,
      maxStalenessHours: 24,
    },
    historyRequirements: {
      ohlcv: { hours: 2_160, minValues: 1_543 },
      volumeDelta: { hours: 720, minValues: 515 },
      openInterest: { hours: 720, minValues: 515 },
      fundingRate: { hours: 2_160, minValues: 1_543 },
      premium: { hours: 720, minValues: 515 },
      socialDominance: { hours: 720, minValues: 515 },
      interactions: { hours: 720, minValues: 515 },
      activeContributors: { hours: 720, minValues: 515 },
      createdPosts: { hours: 720, minValues: 515 },
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
