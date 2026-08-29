import assert from "node:assert/strict"
import test from "node:test"
import {
  getRequiredString,
  parseInteger,
  toIsoTimestamp,
} from "../src/helpers/normalization-helper.js"

test("parseInteger accepts safe integers and integer strings", () => {
  assert.equal(parseInteger(74, "value"), 74)
  assert.equal(parseInteger(" 74 ", "value"), 74)
})

test("parseInteger rejects non-integer values", () => {
  assert.throws(
    () => parseInteger("74.5", "value"),
    /value must be an integer/,
  )
})

test("getRequiredString trims non-empty strings", () => {
  assert.equal(getRequiredString(" Greed ", "classification"), "Greed")
  assert.throws(
    () => getRequiredString("  ", "classification"),
    /classification is required/,
  )
})

test("toIsoTimestamp normalizes dates and rejects invalid timestamps", () => {
  assert.equal(
    toIsoTimestamp("2026-08-25T12:00:00Z", "timestamp"),
    "2026-08-25T12:00:00.000Z",
  )
  assert.equal(
    toIsoTimestamp(new Date("2026-08-25T12:00:00Z"), "timestamp"),
    "2026-08-25T12:00:00.000Z",
  )
  assert.throws(
    () => toIsoTimestamp("not-a-date", "timestamp"),
    /timestamp must be a valid timestamp/,
  )
})
