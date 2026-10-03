import assert from "node:assert/strict"
import test from "node:test"
import { createCoverageStudyRequests } from "../src/steps/step2-data-bootstrap/coverage-study-definitions.js"

test("coverage requests contain every approved study and bind social data to the coin", () => {
  const requests = createCoverageStudyRequests("CRYPTO:PEPEUSD")

  assert.deepEqual(
    requests.map(request => request.key).sort(),
    [
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
    ].sort(),
  )
  const volumeDelta = requests.find(request => request.key === "volumeDelta")
  assert.equal(volumeDelta.version, "8.0")
  assert.deepEqual(volumeDelta.fields, {
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
