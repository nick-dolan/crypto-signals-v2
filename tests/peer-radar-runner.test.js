import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { promisify } from "node:util"

for (const failedStep of [null, "step11-peer-radar.js", "step12-peer-radar-analysis.js", "step7-agent-analysis.js"]) {
  test(`pipeline order and independent report when failure is ${failedStep ?? "absent"}`, { timeout: 30_000 }, async (t) => {
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
    const files = (await fs.readdir(new URL("../src", import.meta.url))).filter(filename => /^step\d.*\.js$/.test(filename))
    for (const filename of files) {
      await fs.writeFile(path.join(directory, "src", filename), `
        import fs from "node:fs/promises"
        await fs.appendFile("order.txt", ${JSON.stringify(filename + "\n")})
        ${filename === "step13-report.js" ? "await fs.writeFile(\"reports/main.html\", \"Main report\")" : ""}
        process.exitCode = ${filename === failedStep ? 1 : 0}
      `)
    }

    const result = await promisify(execFile)(process.execPath, ["src/index.js"], { cwd: directory, timeout: 20_000 })
      .then(output => ({ ...output, code: 0 }), error => error)
    const order = (await fs.readFile(path.join(directory, "order.txt"), "utf8")).trim().split("\n")
    assert.equal(result.code, failedStep ? 1 : 0)
    assert.deepEqual(order.slice(0, 8), [
      "step1-crypto-universe.js", "step2-data-bootstrap.js", "step3-market-context.js",
      "step3.1-coingecko-trending.js", "step4-feature-metrics.js", "step5-preliminary-filter.js",
      "step6-agent-payload.js", "step7-agent-analysis.js",
    ])
    if (failedStep === "step7-agent-analysis.js") {
      assert.equal(order.length, 8)
      await assert.rejects(fs.access(path.join(directory, "reports", "main.html")), { code: "ENOENT" })
      return
    }

    assert.equal(order.length, failedStep === "step11-peer-radar.js" ? 13 : 14)
    assert.equal(order.at(-1), "step13-report.js")
    assert.equal(order.includes("step12-peer-radar-analysis.js"), failedStep !== "step11-peer-radar.js")
    assert.ok(order.indexOf("step11-peer-radar.js") > order.indexOf("step10-context-enrichment.js"))
    assert.equal(await fs.readFile(path.join(directory, "reports", "main.html"), "utf8"), "Main report")
    if (failedStep) {
      assert.match(result.stderr, /Main report completed.*peer radar failed/)
      assert.doesNotMatch(result.stdout, /All steps completed successfully/)
    } else {
      assert.match(result.stdout, /All steps completed successfully/)
    }
  })
}
