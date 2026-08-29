import assert from "node:assert/strict"
import test from "node:test"
import { createDataCoverageProbeDescription } from "../src/steps/step2-data-coverage/build-data-coverage-report.js"

test("data coverage report describes the configured probe", () => {
  assert.deepEqual(createDataCoverageProbeDescription(), {
    timeframe: "1h",
    hours: 168,
    minDenseValues: 120,
    maxStalenessHours: 24,
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
