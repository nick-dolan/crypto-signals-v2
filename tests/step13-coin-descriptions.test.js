import assert from "node:assert/strict"
import path from "node:path"
import test from "node:test"

import { readCoinDescriptions } from "../src/steps/step13-report/read-coin-descriptions.js"

function createEntry (baseCurrencyId, fields = {}) {
  return {
    baseCurrencyId,
    symbol: baseCurrencyId,
    name: `Coin ${baseCurrencyId}`,
    description: `Description ${baseCurrencyId}`,
    sources: [{ url: `https://example.com/${baseCurrencyId}`, checkedAt: "2026-09-25T09:00:00.000Z" }],
    ...fields,
  }
}

function readEntries (coins, entries) {
  return readCoinDescriptions(coins, { readFile: async () => JSON.stringify({ coins: entries }) })
}

test("reads the registry from cwd and returns only requested IDs", async () => {
  const registry = { coins: [createEntry("MAIN"), createEntry("OUTSIDE"), createEntry("LEADER"), createEntry("UNUSED")] }
  const coins = [{ baseCurrencyId: "MAIN", symbol: "MAIN" }, { baseCurrencyId: "OUTSIDE", symbol: "OUTSIDE" }]
  const before = structuredClone([coins, registry])
  const requested = []
  const result = await readCoinDescriptions(coins, {
    readFile: async (filename, encoding) => {
      requested.push([filename, encoding])
      return JSON.stringify(registry)
    },
  })

  assert.deepEqual(requested, [[path.resolve(process.cwd(), "data", "coin-descriptions.json"), "utf8"]])
  assert.deepEqual(result, {
    MAIN: { description: registry.coins[0].description, sources: registry.coins[0].sources },
    OUTSIDE: { description: registry.coins[1].description, sources: registry.coins[1].sources },
  })
  assert.deepEqual([coins, registry], before)
})

test("matches only exact IDs even when tickers and names collide or change", async () => {
  const entries = [
    createEntry("FIRST-ID", { symbol: "SAME", name: "Same name" }),
    createEntry("SECOND-ID", { symbol: "SAME", name: "Same name" }),
  ]
  const result = await readEntries([
    { baseCurrencyId: "FIRST-ID", symbol: "RENAMED", name: "New name" },
    { baseCurrencyId: "SECOND-ID", symbol: "SAME", name: "Same name" },
    { baseCurrencyId: "UNKNOWN", symbol: "SAME", name: "Same name" },
    { baseCurrencyId: "first-id", symbol: "SAME", name: "Same name" },
    { baseCurrencyId: " FIRST-ID ", symbol: "SAME", name: "Same name" },
    { symbol: "SAME", name: "Same name" },
  ], entries)

  assert.deepEqual(result, {
    "FIRST-ID": { description: entries[0].description, sources: entries[0].sources },
    "SECOND-ID": { description: entries[1].description, sources: entries[1].sources },
  })
})

test("keeps sources and optional checkedAt strings, leaving URL protocol filtering to the UI", async () => {
  const entry = createEntry("MAIN", {
    description: "  Brief description.\n",
    sources: [
      { url: "https://example.com/about", checkedAt: "2026-09-25T09:00:00.000Z", title: "Not exported" },
      { url: " http://example.com/docs ", checkedAt: " 2026-09-24 " },
      { url: "https://example.com/undated" },
      { url: "https://example.com/invalid-date", checkedAt: 123 },
      { url: "javascript:alert(1)", checkedAt: "  " },
      null, [], {}, false, "https://example.com/not-an-object", { url: 123 }, { url: "  " },
    ],
  })
  const before = structuredClone(entry)
  const result = await readEntries([{ baseCurrencyId: "MAIN" }], [entry])

  assert.deepEqual(result, {
    MAIN: {
      description: "Brief description.",
      sources: [
        { url: "https://example.com/about", checkedAt: "2026-09-25T09:00:00.000Z" },
        { url: "http://example.com/docs", checkedAt: "2026-09-24" },
        { url: "https://example.com/undated" },
        { url: "https://example.com/invalid-date" },
        { url: "javascript:alert(1)" },
      ],
    },
  })
  assert.deepEqual(entry, before)
})

test("normalizes missing or malformed sources to an empty array", async () => {
  for (const sources of [undefined, null, {}, "https://example.com", 123, []]) {
    assert.deepEqual(await readEntries([{ baseCurrencyId: "MAIN" }], [createEntry("MAIN", { sources })]), {
      MAIN: { description: "Description MAIN", sources: [] },
    })
  }
})

test("skips incomplete entries without losing other descriptions", async () => {
  const entries = [
    null, [], {}, false, "not an entry",
    { description: "No ID" },
    { baseCurrencyId: "NO-DESCRIPTION" },
    ...[null, "", "  ", 123, {}, []].map((description, index) => createEntry(`INVALID-${index}`, { description })),
    ...[null, "", "  ", 123].map(baseCurrencyId => createEntry(baseCurrencyId)),
    { baseCurrencyId: "VALID", description: "Valid description" },
  ]
  const coins = entries.map(entry => ({ baseCurrencyId: entry?.baseCurrencyId }))
  const result = await readEntries([...coins, null, { symbol: "VALID" }], entries)

  assert.deepEqual(result, { VALID: { description: "Valid description", sources: [] } })
})

test("missing entries and empty selections return an empty lookup", async () => {
  for (const [coins, entries] of [
    [[{ baseCurrencyId: "UNKNOWN", symbol: "MAIN" }], [createEntry("MAIN")]],
    [[{ baseCurrencyId: "MAIN" }], []],
    [[], [createEntry("MAIN")]],
  ]) {
    assert.deepEqual(await readEntries(coins, entries), {})
  }
})

test("repeated requested IDs are harmless but duplicate registry IDs are omitted regardless of order", async (t) => {
  t.mock.method(console, "warn", () => {})
  const coins = [{ baseCurrencyId: "MAIN" }, { baseCurrencyId: "MAIN" }, { baseCurrencyId: "OTHER" }]
  const entry = createEntry("MAIN")
  assert.deepEqual(await readEntries(coins, [entry]), {
    MAIN: { description: entry.description, sources: entry.sources },
  })

  for (const duplicates of [
    [entry, createEntry("MAIN", { description: "Different description" })],
    [entry, { baseCurrencyId: "MAIN" }],
    [{ baseCurrencyId: "MAIN" }, entry],
    [entry, entry, entry],
  ]) {
    assert.deepEqual(await readEntries(coins, [...duplicates, createEntry("OTHER")]), {
      OTHER: { description: "Description OTHER", sources: createEntry("OTHER").sources },
    })
  }
})

test("IDs that match object property names remain ordinary JSON keys", async () => {
  const coins = ["__proto__", "constructor", "toString"].map(baseCurrencyId => ({ baseCurrencyId }))
  const result = await readEntries(coins, coins.map(coin => createEntry(coin.baseCurrencyId)))

  assert.equal(Object.getPrototypeOf(result), Object.prototype)
  assert.deepEqual(Object.keys(result), coins.map(coin => coin.baseCurrencyId))
  for (const { baseCurrencyId } of coins) {
    assert.ok(Object.hasOwn(result, baseCurrencyId))
    assert.equal(result[baseCurrencyId].description, `Description ${baseCurrencyId}`)
  }
  assert.deepEqual(JSON.parse(JSON.stringify(result)), result)
})

test("a missing registry returns an empty lookup", async () => {
  const result = await readCoinDescriptions([{ baseCurrencyId: "MAIN" }], {
    readFile: async () => {
      throw Object.assign(new Error("File missing"), { code: "ENOENT" })
    },
  })

  assert.deepEqual(result, {})
})

test("read errors and bad JSON return an empty lookup", async (t) => {
  for (const [name, readFile] of [
    ["read error", async () => {
      throw Object.assign(new Error("Access denied"), { code: "EACCES" })
    }],
    ["non-Error failure", async () => {
      throw null
    }],
    ["bad JSON", async () => "{broken JSON"],
  ]) {
    await t.test(name, async (t) => {
      t.mock.method(console, "warn", () => {})
      assert.deepEqual(await readCoinDescriptions([{ baseCurrencyId: "MAIN" }], { readFile }), {})
    })
  }
})

test("invalid registry shapes fall back to an empty lookup", async (t) => {
  for (const data of [null, [], "text", true, 123, {}, { coins: null }, { coins: {} }, { coins: "text" }]) {
    await t.test(JSON.stringify(data), async (t) => {
      t.mock.method(console, "warn", () => {})
      const result = await readCoinDescriptions([{ baseCurrencyId: "MAIN" }], { readFile: async () => JSON.stringify(data) })

      assert.deepEqual(result, {})
    })
  }
})
