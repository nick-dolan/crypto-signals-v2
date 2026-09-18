import assert from "node:assert/strict"
import test from "node:test"

import { decodeAgentPayload } from "../src/steps/step6-agent-payload/agent-payload-format.js"

function createPayload () {
  return {
    schemaVersion: 10,
    candidateCount: 1,
    schema: {
      lifecycle: ["breakoutAgeHours", "extensionFromBaseAtr"],
      derivatives: ["oiChange4hPct", "fundingRate", "quietOi"],
      social: ["socialStatus", "interactionsZ"],
    },
    candidates: [{
      symbol: "SOL",
      name: "Solana",
      selectionRank: 1,
      lifecycle: [null, 0],
      derivatives: [-1.234, -1e-12, false],
      social: ["unavailable", null],
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
    flags: ["coiling"],
  }])
  assert.deepEqual(fields, Object.keys(candidates[0]))
  assert.equal(fields.includes("selectionRank"), false)
  assert.deepEqual(decodeAgentPayload(JSON.parse(JSON.stringify(payload))), { fields, candidates })
  assert.deepEqual(payload, before)
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
