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
  ["old objective", { schemaVersion: 14, objective: "P(|движение| > 2.5 ATR в следующие 4–12 часов)" }],
]) {
  test(`step 7 rejects ${name} before making an analysis request`, async (t) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "growth-agent-runner-"))
    t.after(() => fs.rm(directory, { recursive: true, force: true }))
    await fs.mkdir(path.join(directory, "tmp"))
    await Promise.all([
      fs.writeFile(path.join(directory, "tmp", "step6-agent-payload.json"), JSON.stringify(payload)),
      fs.writeFile(path.join(directory, "tmp", "step5-preliminary-filter.json"), "{}"),
    ])

    await assert.rejects(promisify(execFile)(process.execPath, [
      fileURLToPath(new URL("../src/step7-agent-analysis.js", import.meta.url)),
    ], { cwd: directory, timeout: 10_000 }), (error) => {
      assert.equal(error.code, 1)
      assert.match(error.stderr, /Growth analysis requires the current payload with information context/)
      return true
    })
    await assert.rejects(fs.access(path.join(directory, "tmp", "step7-agent-analysis.json")), { code: "ENOENT" })
  })
}
