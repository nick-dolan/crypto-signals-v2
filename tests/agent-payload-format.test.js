import assert from "node:assert/strict"
import test from "node:test"

import { decodeAgentPayload } from "../src/steps/step6-agent-payload/agent-payload-format.js"

function createPayload () {
  return {
    schemaVersion: 11,
    candidateCount: 1,
    schema: {
      lifecycle: ["breakoutAgeHours", "extensionFromBaseAtr"],
      derivatives: ["oiChange4hPct", "fundingRate", "quietOi"],
      social: ["socialStatus", "interactionsZ"],
      coingecko: ["coingeckoId", "coingeckoTrending", "coingeckoTrendingCategories"],
    },
    candidates: [{
      symbol: "SOL",
      name: "Solana",
      selectionRank: 1,
      lifecycle: [null, 0],
      derivatives: [-1.234, -1e-12, false],
      social: ["unavailable", null],
      coingecko: ["solana", true, ["Layer 1 (L1)", "Smart Contract Platform"]],
      flags: ["coiling"],
    }],
  }
}

test("grouped payload decodes original values without mutating data or adding ordering metadata", () => {
  const payload = createPayload()
  const before = structuredClone(payload)
  const { fields, candidates } = decodeAgentPayload(payload)

  assert.deepEqual(candidates, [{
    symbol: "SOL",
    name: "Solana",
    breakoutAgeHours: null,
    extensionFromBaseAtr: 0,
    oiChange4hPct: -1.234,
    fundingRate: -1e-12,
    quietOi: false,
    socialStatus: "unavailable",
    interactionsZ: null,
    coingeckoId: "solana",
    coingeckoTrending: true,
    coingeckoTrendingCategories: ["Layer 1 (L1)", "Smart Contract Platform"],
    flags: ["coiling"],
  }])
  assert.deepEqual(fields, Object.keys(candidates[0]))
  assert.equal(fields.includes("selectionRank"), false)
  assert.deepEqual(decodeAgentPayload(JSON.parse(JSON.stringify(payload))), { fields, candidates })
  assert.deepEqual(payload, before)
})

test("grouped payload preserves empty category arrays and unknown context through JSON", () => {
  for (const coingecko of [["solana", true, []], [null, null, null]]) {
    const payload = createPayload()
    payload.candidates[0].coingecko = coingecko
    const before = structuredClone(payload)
    const decoded = decodeAgentPayload(JSON.parse(JSON.stringify(payload)))

    assert.deepEqual(decoded.candidates.map(candidate => (
      payload.schema.coingecko.map(field => candidate[field])
    )), [coingecko])
    assert.deepEqual(decoded, decodeAgentPayload(payload))
    assert.deepEqual(payload, before)
  }
})

test("grouped payload validates outer column counts without expanding array values", () => {
  for (const coingecko of [
    ["solana", true],
    ["solana", true, "Layer 1 (L1)", "Smart Contract Platform"],
  ]) {
    const payload = createPayload()
    payload.candidates[0].coingecko = coingecko
    assert.throws(() => decodeAgentPayload(payload), /schema length and keys/)
  }
})

test("grouped payload does not depend on object key order", () => {
  const payload = createPayload()
  const expected = decodeAgentPayload(payload).candidates
  payload.schema = Object.fromEntries(Object.entries(payload.schema).reverse())
  payload.candidates[0] = Object.fromEntries(Object.entries(payload.candidates[0]).reverse())

  assert.deepEqual(decodeAgentPayload(payload).candidates, expected)
})

test("empty shortlist keeps its grouped schema without inventing candidates", () => {
  const payload = { ...createPayload(), candidateCount: 0, candidates: [] }
  const { fields, candidates } = decodeAgentPayload(payload)

  assert.deepEqual(candidates, [])
  assert.equal(fields.includes("fundingRate"), true)
})

test("schema group names cannot overwrite candidate metadata", () => {
  for (const group of ["symbol", "name", "selectionRank", "flags", " "]) {
    const payload = createPayload()
    payload.schema[group] = ["volumeZ"]
    assert.throws(() => decodeAgentPayload(payload), /Step 6 schema/)
  }
})
