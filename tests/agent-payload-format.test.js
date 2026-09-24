import assert from "node:assert/strict"
import test from "node:test"

import { decodeAgentPayload } from "../src/steps/step6-agent-payload/agent-payload-format.js"

function createPayload () {
  return {
    schemaVersion: 12,
    candidateCount: 1,
    schema: {
      lifecycle: ["breakoutAgeHours", "extensionFromBaseAtr"],
      derivatives: ["oiChange4hPct", "fundingRate", "quietOi"],
      social: ["socialStatus", "interactionsZ"],
      coingecko: ["coingeckoId", "coingeckoTrending", "coingeckoTrendingCategories"],
      peerContext: ["peerStatus", "peerCount", "peerAvailableCount", "peerLeaders"],
    },
    candidates: [{
      symbol: "SOL",
      name: "Solana",
      selectionRank: 1,
      lifecycle: [null, 0],
      derivatives: [-1.234, -1e-12, false],
      social: ["unavailable", null],
      coingecko: ["solana", true, ["Layer 1 (L1)", "Smart Contract Platform"]],
      peerContext: ["partial", 3, 2, [{ symbol: "VET", status: "fresh", return4hPct: 3.5, coinMoveSinceStartAtr: null }]],
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
    peerStatus: "partial",
    peerCount: 3,
    peerAvailableCount: 2,
    peerLeaders: [{ symbol: "VET", status: "fresh", return4hPct: 3.5, coinMoveSinceStartAtr: null }],
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

test("grouped payload preserves nested peer leaders, observed emptiness and unknown coverage through JSON", () => {
  for (const peerContext of [
    ["unavailable", null, null, null],
    ["no_peers", 0, 0, []],
    ["insufficient_data", 3, 0, null],
    ["partial", 3, 2, []],
    ["partial", 3, 2, [
      { symbol: "VET", status: "fresh", return4hPct: 3.5, basis: "Связь: общая экосистема", coinMoveSinceStartAtr: null },
      { symbol: "VTHO", status: "fading", return4hPct: 5.1, caveat: null, coinReturnSinceStartPct: -1e-12 },
    ]],
  ]) {
    const payload = createPayload()
    payload.candidates[0].peerContext = peerContext
    const before = structuredClone(payload)
    const decoded = decodeAgentPayload(JSON.parse(JSON.stringify(payload)))

    assert.deepEqual(payload.schema.peerContext.map(field => decoded.candidates[0][field]), peerContext)
    assert.deepEqual(decoded, decodeAgentPayload(payload))
    assert.deepEqual(payload, before)
  }
})

test("grouped payload validates the peer array as one column rather than flattened leaders", () => {
  const payload = createPayload()
  const [status, count, available, leaders] = payload.candidates[0].peerContext
  for (const peerContext of [[status, count, available], [status, count, available, ...leaders, ...leaders]]) {
    payload.candidates[0].peerContext = peerContext
    assert.throws(() => decodeAgentPayload(payload), /schema length and keys/)
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
  assert.equal(fields.includes("peerLeaders"), true)
})

test("schema group names cannot overwrite candidate metadata", () => {
  for (const group of ["symbol", "name", "selectionRank", "flags", " "]) {
    const payload = createPayload()
    payload.schema[group] = ["volumeZ"]
    assert.throws(() => decodeAgentPayload(payload), /Step 6 schema/)
  }
})
