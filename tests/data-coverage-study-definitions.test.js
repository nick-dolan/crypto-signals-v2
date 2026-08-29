import assert from "node:assert/strict"
import test from "node:test"
import {
  DATA_COVERAGE_REQUIRED_STUDIES,
  DATA_COVERAGE_SPARSE_STUDIES,
} from "../src/steps/step2-data-coverage/config.js"
import {
  createCoverageStudyRequests,
  REQUIRED_STUDY_KEYS,
} from "../src/steps/step2-data-coverage/coverage-study-definitions.js"

test("coverage requests contain every approved study in collection order", () => {
  const requests = createCoverageStudyRequests("CRYPTO:PEPEUSD")

  assert.deepEqual(REQUIRED_STUDY_KEYS, [
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
  assert.deepEqual(
    Object.values(DATA_COVERAGE_REQUIRED_STUDIES).flat(),
    REQUIRED_STUDY_KEYS,
  )
  assert.deepEqual(DATA_COVERAGE_SPARSE_STUDIES, ["liquidations"])
  assert.deepEqual(
    requests.map(request => request.key),
    REQUIRED_STUDY_KEYS,
  )
  assert.equal(requests[0].version, "8.0")
  assert.deepEqual(requests[0].fields, {
    high: "plotcandle_0_ohlc_high",
    low: "plotcandle_0_ohlc_low",
    close: "plotcandle_0_ohlc_close",
  })

  for (const request of requests.slice(0, 7)) {
    assert.equal(request.inputs?.in_0, undefined)
    assert.equal(request.allowMissingValues, true)
  }

  for (const request of requests.slice(7)) {
    assert.equal(request.inputs.in_0, "CRYPTO:PEPEUSD")
    assert.equal(request.allowMissingValues, true)
  }
})
