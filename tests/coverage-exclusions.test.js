import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import {
  getActiveCoverageExclusionIds,
  readCoverageExclusions,
  updateCoverageExclusions,
} from "../src/helpers/coverage-exclusions-helper.js"

function createExcludedCoin () {
  return {
    baseCurrencyId: "XTVCMISSING",
    symbol: "MISS",
    name: "Missing Coin",
    tradingViewSymbol: "CRYPTO:MISSUSD",
    market: {
      tradingViewSymbol: "BINANCE:MISSUSDT.P",
    },
    unavailableMetrics: ["socialDominance", "interactions"],
  }
}

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
  assert.equal(persisted.coins[0].baseCurrencyId, "XTVCMISSING")
  assert.deepEqual(
    persisted.coins[0].unavailableMetrics,
    ["interactions", "socialDominance"],
  )
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

  assert.deepEqual((await readCoverageExclusions({ filePath })).coins, [])
})
