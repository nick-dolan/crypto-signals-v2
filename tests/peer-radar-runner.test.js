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
  ["step1.1-coin-descriptions.js", "step7-agent-analysis.js"],
  ["step12.1-market-brief.js"],
  ["step11-peer-radar.js", "step12.1-market-brief.js"],
  ["step1.1-coin-descriptions.js", "step12.1-market-brief.js"],
  ["step13-report.js"],
  ["step14-telegram.js"],
  ["step11-peer-radar.js", "step13-report.js"],
]) {
  test(`pipeline order and independent report/preview when failure is ${failedSteps.join(", ") || "absent"}`, { timeout: 30_000 }, async (t) => {
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
      "step11-peer-radar.js", "step12-peer-radar-analysis.js", "step12.1-market-brief.js", "step13-report.js",
      "step14-telegram.js",
    ]) {
      await fs.writeFile(path.join(directory, "src", filename), `
        import fs from "node:fs/promises"
        await fs.appendFile("order.txt", ${JSON.stringify(filename + "\n")})
        ${filename === "step13-report.js" && !failedSteps.includes(filename) ? "await fs.writeFile(\"reports/main.parquet\", \"Saved report data\")" : ""}
        ${filename === "step14-telegram.js" ? "await fs.readFile(\"reports/main.parquet\")" : ""}
        process.exitCode = ${failedSteps.includes(filename) ? 1 : 0}
      `)
    }

    const result = await promisify(execFile)(process.execPath, ["src/index.js"], {
      cwd: directory, timeout: 20_000,
    }).then(() => ({ code: 0 }), error => error)
    const order = (await fs.readFile(path.join(directory, "order.txt"), "utf8")).trim().split("\n")
    assert.equal(result.code, failedSteps.some(step => !["step1.1-coin-descriptions.js", "step12.1-market-brief.js"].includes(step)) ? 1 : 0)
    assert.deepEqual(order.slice(0, 9), [
      "step1-crypto-universe.js", "step1.1-coin-descriptions.js", "step2-data-bootstrap.js",
      "step3-market-context.js", "step3.1-coingecko-trending.js", "step4-feature-metrics.js",
      "step5-preliminary-filter.js", "step6-agent-payload.js", "step7-agent-analysis.js",
    ])

    if (failedSteps.includes("step7-agent-analysis.js")) {
      assert.equal(order.length, 9)
      await assert.rejects(fs.access(path.join(directory, "reports", "main.parquet")), { code: "ENOENT" })
      return
    }

    assert.deepEqual(order.slice(9), [
      "step8-news-enrichment.js", "step9-twitter-enrichment.js", "step10-context-enrichment.js",
      "step11-peer-radar.js",
      ...(failedSteps.includes("step11-peer-radar.js") ? [] : ["step12-peer-radar-analysis.js"]),
      "step12.1-market-brief.js", "step13-report.js",
      ...(failedSteps.includes("step13-report.js") ? [] : ["step14-telegram.js"]),
    ])
    if (failedSteps.includes("step13-report.js")) {
      await assert.rejects(fs.access(path.join(directory, "reports", "main.parquet")), { code: "ENOENT" })
      return
    }

    assert.equal(await fs.readFile(path.join(directory, "reports", "main.parquet"), "utf8"), "Saved report data")
  })
}
