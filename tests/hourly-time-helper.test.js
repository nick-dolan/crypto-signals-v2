import assert from "node:assert/strict"
import test from "node:test"

import { getClosedHourlyBoundary } from "../src/helpers/hourly-time-helper.js"

test("closed hourly boundary maps one reference time to request and candle limits", () => {
  assert.deepEqual(
    getClosedHourlyBoundary(10 * 3_600 + 37 * 60),
    {
      requestTo: 10 * 3_600 - 1,
      latestClosedTime: 9 * 3_600,
    },
  )

  assert.deepEqual(
    getClosedHourlyBoundary(10 * 3_600),
    {
      requestTo: 10 * 3_600 - 1,
      latestClosedTime: 9 * 3_600,
    },
  )
})

test("closed hourly boundary rejects a missing reference time", () => {
  assert.equal(getClosedHourlyBoundary(undefined), null)
  assert.equal(getClosedHourlyBoundary(Number.NaN), null)
})
