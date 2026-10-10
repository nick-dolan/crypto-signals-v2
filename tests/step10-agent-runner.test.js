import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"

for (const [name, payload] of [
  ["old payload", { schemaVersion: 13, objective: "P(|движение| > 2.5 ATR в следующие 4–12 часов)" }],
  ["missing pattern context", { schemaVersion: 14, objective: "P(рост > 2.5 ATR в следующие 4–12 часов)" }],
  ["old objective", { schemaVersion: 15, objective: "P(|движение| > 2.5 ATR в следующие 4–12 часов)" }],
]) {
  test(`step 10 rejects ${name} before making an analysis request`, async (t) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "growth-agent-runner-"))
    t.after(() => fs.rm(directory, { recursive: true, force: true }))
    await fs.mkdir(path.join(directory, "tmp"))
    await Promise.all([
      fs.writeFile(path.join(directory, "tmp", "step9-agent-payload.json"), JSON.stringify(payload)),
      fs.writeFile(path.join(directory, "tmp", "step5-preliminary-filter.json"), "{}"),
    ])

    await assert.rejects(promisify(execFile)(process.execPath, [
      fileURLToPath(new URL("../src/step10-agent-analysis.js", import.meta.url)),
    ], { cwd: directory, timeout: 10_000 }), (error) => {
      assert.equal(error.code, 1)
      assert.match(error.stderr, /Growth analysis requires the current payload with information context/)
      return true
    })
    await assert.rejects(fs.access(path.join(directory, "tmp", "step10-agent-analysis.json")), { code: "ENOENT" })
  })
}

for (const empty of [false, true]) {
  test(`CLI step 10 accepts schema 15 with ${empty ? "empty shortlist" : "pattern context"}`, async (t) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "pattern-agent-runner-"))
    t.after(() => fs.rm(directory, { recursive: true, force: true }))
    await fs.mkdir(path.join(directory, "tmp"))
    const asOf = "2026-10-09T13:00:00.000Z"
    const candidate = {
      symbol: "SOL", name: "Solana",
      patternContext: ["available", "Возможный бычий флаг; выход не подтверждён. Уверенность средняя.", null],
      flags: [],
    }
    const payload = {
      schemaVersion: 15, asOf, timeframe: "1h",
      objective: "P(рост > 2.5 ATR в следующие 4–12 часов)",
      candidateCount: empty ? 0 : 1,
      schema: { patternContext: ["patternStatus", "patternSummary", "patternCaveat"] },
      candidates: empty ? [] : [candidate],
    }
    const shortlist = {
      asOf, timeframe: "1h", candidateCount: payload.candidateCount,
      candidates: empty ? [] : [{ coin: { symbol: "SOL", baseCurrencyId: "XTVCSOL", marketSymbol: "BINANCE:SOLUSDT.P" } }],
    }
    await Promise.all([
      fs.writeFile(path.join(directory, "tmp", "step9-agent-payload.json"), JSON.stringify(payload)),
      fs.writeFile(path.join(directory, "tmp", "step5-preliminary-filter.json"), JSON.stringify(shortlist)),
    ])
    await promisify(execFile)(process.execPath, ["--input-type=module", "--eval", `
      import assert from "node:assert/strict"
      import fs from "node:fs/promises"
      import { CopilotClient } from ${JSON.stringify(import.meta.resolve("@github/copilot-sdk"))}
      let calls = 0
      CopilotClient.prototype.start = async () => {}
      CopilotClient.prototype.stop = async () => []
      CopilotClient.prototype.createSession = async () => ({
        sendAndWait: async (request) => {
          calls += 1
          assert.deepEqual(Object.keys(request), ["prompt"])
          const payload = JSON.parse(request.prompt)
          assert.equal(payload.schemaVersion, 15)
          assert.deepEqual(payload.schema.patternContext, ["patternStatus", "patternSummary", "patternCaveat"])
          await fs.writeFile("tmp/captured-main-input.json", JSON.stringify(payload))
          return { data: { content: JSON.stringify({
            schemaVersion: 4, asOf: payload.asOf, topCandidates: [],
            assessments: payload.candidates.map(candidate => ({
              symbol: candidate.symbol, movementProbability: 0.2, estimateConfidence: "low",
              technicalSummary: { observation: "Возможная фигура ещё не подтверждена.", caveat: "Пробоя нет." },
              drivers: [{ fields: ["patternSummary"], text: "Видна возможная локальная структура." }],
              counterSignals: [],
            })),
          }) } }
        },
      })
      globalThis.fetch = async () => { throw new Error("No network in runner test") }
      await import(${JSON.stringify(new URL("../src/step10-agent-analysis.js", import.meta.url).href)})
      assert.equal(calls, 1)
    `], { cwd: directory, timeout: 10_000 })
    const captured = JSON.parse(await fs.readFile(path.join(directory, "tmp", "captured-main-input.json"), "utf8"))
    assert.deepEqual(captured, payload)
    const output = JSON.parse(await fs.readFile(path.join(directory, "tmp", "step10-agent-analysis.json"), "utf8"))
    assert.equal(output.asOf, asOf)
    assert.equal(output.candidateCount, payload.candidateCount)
    assert.equal(output.assessments.length, payload.candidateCount)
    if (!empty) {
      assert.equal(output.assessments[0].symbol, "SOL")
      assert.match(output.assessments[0].drivers[0], /patternSummary/)
    }
  })
}
