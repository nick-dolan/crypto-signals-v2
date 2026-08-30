import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import {
  getActiveCoverageExclusionIds,
  getPermanentCoverageExclusionIds,
  readCoverageExclusions,
  readPermanentCoverageExclusions,
  updateCoverageExclusions,
} from "../src/helpers/coverage-exclusions-helper.js"

function createExcludedCoin () {
  return {
    baseCurrencyId: "XTVCMISSING",
    symbol: "MISS",
    name: "Missing Coin",
  }
}

test("permanent coverage exclusions load without an expiration", async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "permanent-coverage-exclusions-"))
  const filePath = path.join(directory, "permanent-coverage-exclusions.json")

  context.after(() => fs.rm(directory, { recursive: true, force: true }))

  await fs.writeFile(filePath, JSON.stringify([
    {
      symbol: "SECOND",
      name: "Second Coin",
      baseCurrencyId: "XTVCSECOND",
    },
    {
      symbol: "FIRST",
      name: "First Coin",
      baseCurrencyId: "XTVCFIRST",
    },
  ]))

  const exclusions = await readPermanentCoverageExclusions({ filePath })

  assert.deepEqual(exclusions.map(exclusion => exclusion.symbol), [
    "FIRST",
    "SECOND",
  ])
  assert.deepEqual(
    [...getPermanentCoverageExclusionIds(exclusions)],
    ["XTVCFIRST", "XTVCSECOND"],
  )
})

test("coverage exclusions persist, expire, and clear after a recheck", async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "coverage-exclusions-"))
  const filePath = path.join(directory, "coverage-exclusions.json")
  const excludedAt = new Date("2026-08-30T12:00:00Z")

  context.after(() => fs.rm(directory, { recursive: true, force: true }))

  const firstUpdate = await updateCoverageExclusions({
    checkedBaseCurrencyIds: ["XTVCMISSING"],
    excludedCoins: [createExcludedCoin()],
    filePath,
    now: excludedAt,
  })
  const persisted = await readCoverageExclusions({ filePath })

  assert.equal(firstUpdate.excludedNowCount, 1)
  assert.equal(firstUpdate.activeCount, 1)
  assert.deepEqual(persisted, [{
    symbol: "MISS",
    name: "Missing Coin",
    baseCurrencyId: "XTVCMISSING",
    recheckAfter: "2026-09-29T12:00:00.000Z",
  }])
  assert.deepEqual(
    [...getActiveCoverageExclusionIds(persisted, { now: excludedAt })],
    ["XTVCMISSING"],
  )
  assert.equal(
    getActiveCoverageExclusionIds(persisted, {
      now: new Date("2026-09-30T12:00:00Z"),
    }).size,
    0,
  )

  await updateCoverageExclusions({
    checkedBaseCurrencyIds: ["XTVCMISSING"],
    excludedCoins: [],
    filePath,
    now: new Date("2026-09-30T12:00:00Z"),
  })

  assert.deepEqual(await readCoverageExclusions({ filePath }), [])
})
