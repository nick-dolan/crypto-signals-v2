import assert from "node:assert/strict"
import test from "node:test"
import {
  DATA_COVERAGE_REQUIRED_STUDY_KEYS,
  DATA_COVERAGE_SPARSE_STUDIES,
} from "../src/steps/step2-data-bootstrap/config.js"
import { createCoverageStudyRequests } from "../src/steps/step2-data-bootstrap/coverage-study-definitions.js"

test("coverage requests contain every approved study in collection order", () => {
  const requests = createCoverageStudyRequests("CRYPTO:PEPEUSD")

  assert.deepEqual(DATA_COVERAGE_REQUIRED_STUDY_KEYS, [
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
  ])
  assert.deepEqual(DATA_COVERAGE_SPARSE_STUDIES, ["liquidations"])
  assert.deepEqual(
    requests.map(request => request.key),
    DATA_COVERAGE_REQUIRED_STUDY_KEYS,
  )
  assert.equal(requests[0].version, "8.0")
  assert.deepEqual(requests[0].fields, {
    high: "plotcandle_0_ohlc_high",
    low: "plotcandle_0_ohlc_low",
    close: "plotcandle_0_ohlc_close",
  })

  for (const request of requests) {
    assert.equal(
      request.inputs?.in_0,
      request.group === "social" ? "CRYPTO:PEPEUSD" : undefined,
    )
    assert.equal(request.allowMissingValues, true)
  }
})
