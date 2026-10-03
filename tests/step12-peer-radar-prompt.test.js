import assert from "node:assert/strict"
import fs from "node:fs/promises"
import test from "node:test"

import { parsePeerRadarAnalysis } from "../src/steps/step12-peer-radar-analysis/parse-peer-radar-analysis.js"

test("peer prompt response example satisfies the parser contract", async () => {
  const prompt = await fs.readFile(new URL("../src/prompts/peer-radar-analysis.md", import.meta.url), "utf8")
  const example = JSON.parse(prompt.match(/```json\n([\s\S]*?)\n```/)[1])
  const scan = {
    asOf: example.asOf,
    candidates: [{ coin: { baseCurrencyId: example.observations[0].baseCurrencyId } }],
  }

  assert.deepEqual(parsePeerRadarAnalysis(JSON.stringify(example), scan), example)
})
