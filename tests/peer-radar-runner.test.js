import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { promisify } from "node:util"

for (const failedSteps of [
  [],
  ["step1.1-coin-descriptions.js"],
  ["step11-peer-radar.js"],
  ["step12-peer-radar-analysis.js"],
  ["step7-agent-analysis.js"],
  ["step1.1-coin-descriptions.js", "step11-peer-radar.js"],
  ["step1.1-coin-descriptions.js", "step12-peer-radar-analysis.js"],
  ["step1.1-coin-descriptions.js", "step7-agent-analysis.js"],
]) {
  test(`pipeline order and independent report when failure is ${failedSteps.join(", ") || "absent"}`, { timeout: 30_000 }, async (t) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "peer-radar-runner-"))
    t.after(() => fs.rm(directory, { recursive: true, force: true }))
    await fs.mkdir(path.join(directory, "src", "helpers"), { recursive: true })
    await fs.mkdir(path.join(directory, "reports"))
    await fs.writeFile(path.join(directory, "package.json"), JSON.stringify({ type: "module" }))
    await fs.copyFile(new URL("../src/index.js", import.meta.url), path.join(directory, "src", "index.js"))
    await fs.copyFile(new URL("../src/helpers/fs-helper.js", import.meta.url), path.join(directory, "src", "helpers", "fs-helper.js"))
    await fs.writeFile(path.join(directory, "src", "helpers", "utils.typed.js"), `
      export { isError } from ${JSON.stringify(new URL("../src/helpers/utils.typed.js", import.meta.url).href)}
    `)
    for (const filename of [
      "step1-crypto-universe.js", "step1.1-coin-descriptions.js", "step2-data-bootstrap.js",
      "step3-market-context.js", "step3.1-coingecko-trending.js", "step4-feature-metrics.js",
      "step5-preliminary-filter.js", "step6-agent-payload.js", "step7-agent-analysis.js",
      "step8-news-enrichment.js", "step9-twitter-enrichment.js", "step10-context-enrichment.js",
      "step11-peer-radar.js", "step12-peer-radar-analysis.js", "step13-report.js",
    ]) {
      await fs.writeFile(path.join(directory, "src", filename), `
        import fs from "node:fs/promises"
        await fs.appendFile("order.txt", ${JSON.stringify(filename + "\n")})
        ${filename === "step13-report.js" ? "await fs.writeFile(\"reports/main.html\", \"Main report\")" : ""}
        process.exitCode = ${failedSteps.includes(filename) ? 1 : 0}
      `)
    }

    const startedAt = Math.floor(Date.now() / 1_000)
    const result = await promisify(execFile)(process.execPath, ["src/index.js"], {
      cwd: directory, timeout: 20_000, env: { ...process.env, TZ: "UTC" },
    }).then(output => ({ ...output, code: 0 }), error => error)
    const finishedAt = Math.floor(Date.now() / 1_000)
    const order = (await fs.readFile(path.join(directory, "order.txt"), "utf8")).trim().split("\n")
    assert.equal(result.code, failedSteps.some(step => step !== "step1.1-coin-descriptions.js") ? 1 : 0)
    assert.deepEqual(order.slice(0, 9), [
      "step1-crypto-universe.js", "step1.1-coin-descriptions.js", "step2-data-bootstrap.js",
      "step3-market-context.js", "step3.1-coingecko-trending.js", "step4-feature-metrics.js",
      "step5-preliminary-filter.js", "step6-agent-payload.js", "step7-agent-analysis.js",
    ])
    if (failedSteps.length) {
      assert.doesNotMatch(result.stdout, /All steps completed successfully/)
    }
    if (failedSteps.includes("step1.1-coin-descriptions.js")) {
      assert.match(result.stderr, /Optional coin descriptions enrichment failed \(step 1\.1\); continuing the pipeline/)
    }
    if (failedSteps.includes("step7-agent-analysis.js")) {
      assert.equal(order.length, 9)
      await assert.rejects(fs.access(path.join(directory, "reports", "main.html")), { code: "ENOENT" })
      return
    }

    assert.equal(order.length, failedSteps.includes("step11-peer-radar.js") ? 14 : 15)
    assert.equal(order.at(-1), "step13-report.js")
    assert.equal(order.includes("step12-peer-radar-analysis.js"), !failedSteps.includes("step11-peer-radar.js"))
    assert.ok(order.indexOf("step11-peer-radar.js") > order.indexOf("step10-context-enrichment.js"))
    assert.equal(await fs.readFile(path.join(directory, "reports", "main.html"), "utf8"), "Main report")
    if (failedSteps.includes("step1.1-coin-descriptions.js")) {
      assert.match(result.stderr, /Main report completed.*optional coin descriptions enrichment failed \(step 1\.1\)/)
    }
    if (failedSteps.some(step => ["step11-peer-radar.js", "step12-peer-radar-analysis.js"].includes(step))) {
      assert.match(result.stderr, /Main report completed.*peer radar failed/)
    }
    if (!failedSteps.length) {
      const completion = result.stdout.match(/✨ All steps completed successfully in \d+\.\ds! · (\d{2}:\d{2}:\d{2}) UTC\+3/)
      assert.ok(completion)
      const expectedTimes = Array.from({ length: finishedAt - startedAt + 1 }, (_, index) => (
        new Date((startedAt + index + 3 * 3_600) * 1_000).toISOString().slice(11, 19)
      ))
      assert.ok(expectedTimes.includes(completion[1]), "Completion time must use UTC+3 even when the process timezone is UTC")
    }
  })
}
