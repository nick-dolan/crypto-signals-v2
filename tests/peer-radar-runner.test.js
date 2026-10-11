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
  ["step6-news-enrichment.js"],
  ["step7-twitter-enrichment.js"],
  ["step8-context-enrichment.js"],
  ["step8.1-pattern-enrichment.js"],
  ["step10-agent-analysis.js"],
  ["step1.1-coin-descriptions.js", "step10-agent-analysis.js"],
  ["step12.1-market-brief.js"],
  ["step11-peer-radar.js", "step12.1-market-brief.js"],
  ["step1.1-coin-descriptions.js", "step12.1-market-brief.js"],
  ["step13-report.js"],
  ["step14-telegram.js"],
  ["step11-peer-radar.js", "step13-report.js"],
]) {
  test(`pipeline dependencies and independent report/preview when failure is ${failedSteps.join(", ") || "absent"}`, { timeout: 30_000 }, async (context) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "peer-radar-runner-"))
    context.after(() => fs.rm(directory, { recursive: true, force: true }))
    await fs.mkdir(path.join(directory, "src", "helpers"), { recursive: true })
    await fs.mkdir(path.join(directory, "src", "steps"))
    await fs.mkdir(path.join(directory, "reports"))
    await fs.mkdir(path.join(directory, "tmp"))
    await fs.writeFile(path.join(directory, "tmp", "stale-sentinel"), "Old run")
    await fs.writeFile(path.join(directory, "package.json"), JSON.stringify({ type: "module" }))
    for (const filename of ["index.js", "helpers/fs-helper.js", "steps/run-pipeline.js"]) {
      await fs.copyFile(new URL(`../src/${filename}`, import.meta.url), path.join(directory, "src", filename))
    }
    await fs.writeFile(path.join(directory, "src", "helpers", "utils.typed.js"), `
      export { isError, isFunction } from ${JSON.stringify(new URL("../src/helpers/utils.typed.js", import.meta.url).href)}
    `)
    for (const filename of [
      "step1-crypto-universe.js", "step1.1-coin-descriptions.js", "step2-data-bootstrap.js",
      "step3-market-context.js", "step3.1-coingecko-trending.js", "step4-feature-metrics.js",
      "step5-preliminary-filter.js", "candidate-enrichment.js", "step9-agent-payload.js", "step10-agent-analysis.js",
      "step11-peer-radar.js", "step12-peer-radar-analysis.js", "step12.1-market-brief.js", "step13-report.js",
      "step14-telegram.js",
    ]) {
      await fs.writeFile(path.join(directory, "src", filename), `
        import assert from "node:assert/strict"
        import fs from "node:fs/promises"
        const filename = ${JSON.stringify(filename)}
        const failedSteps = ${JSON.stringify(failedSteps)}
        const trace = (step, event) => fs.appendFile("events.jsonl", JSON.stringify({
          step, event, startedAt: process.env.PIPELINE_STARTED_AT,
        }) + "\\n")
        await trace(filename, "start")
        if (filename === "candidate-enrichment.js") {
          assert.equal(process.argv[2], "--concurrency")
          assert.ok(["9", "10"].includes(process.argv[3]))
          for (const step of ["step6-news-enrichment.js", "step7-twitter-enrichment.js", "step8-context-enrichment.js", "step8.1-pattern-enrichment.js"]) {
            await trace(step, "start")
            await trace(step, "finish")
            if (failedSteps.includes(step)) {
              process.exitCode = 1
              break
            }
          }
        } else {
          if (filename === "step13-report.js" && !failedSteps.includes(filename)) {
            await fs.writeFile("reports/main.parquet", "Saved report data")
          }
          if (filename === "step14-telegram.js") {
            await fs.readFile("reports/main.parquet")
          }
          process.exitCode = failedSteps.includes(filename) ? 1 : 0
        }
        await trace(filename, "finish")
      `)
    }

    const result = await promisify(execFile)(process.execPath, ["src/index.js"], {
      cwd: directory, timeout: 20_000,
    }).then(() => ({ code: 0 }), error => error)
    const events = (await fs.readFile(path.join(directory, "events.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line))
    const started = step => events.some(event => event.step === step && event.event === "start")
    const before = (input, consumer) => {
      if (started(consumer)) {
        const finish = events.findIndex(event => event.step === input && event.event === "finish")
        const start = events.findIndex(event => event.step === consumer && event.event === "start")
        assert.ok(finish >= 0 && finish < start, `${consumer} must wait for ${input}`)
      }
    }
    assert.equal(result.code, failedSteps.some(step => !["step1.1-coin-descriptions.js", "step12.1-market-brief.js"].includes(step)) ? 1 : 0)
    assert.equal(new Set(events.map(event => event.startedAt)).size, 1)
    assert.ok(Number(events[0].startedAt) > 0)
    await assert.rejects(fs.access(path.join(directory, "tmp", "stale-sentinel")), { code: "ENOENT" })
    for (const [input, consumer] of [
      ["step1-crypto-universe.js", "step2-data-bootstrap.js"],
      ["step3-market-context.js", "step2-data-bootstrap.js"],
      ["step1-crypto-universe.js", "step3.1-coingecko-trending.js"],
      ["step3.1-coingecko-trending.js", "step1.1-coin-descriptions.js"],
      ["step2-data-bootstrap.js", "step11-peer-radar.js"],
      ["step2-data-bootstrap.js", "step4-feature-metrics.js"],
      ["step3.1-coingecko-trending.js", "step4-feature-metrics.js"],
      ["step4-feature-metrics.js", "step5-preliminary-filter.js"],
      ["step5-preliminary-filter.js", "candidate-enrichment.js"],
      ["candidate-enrichment.js", "step9-agent-payload.js"],
      ["step9-agent-payload.js", "step10-agent-analysis.js"],
      ["step11-peer-radar.js", "step12-peer-radar-analysis.js"],
      ["step10-agent-analysis.js", "step12.1-market-brief.js"],
      ["step10-agent-analysis.js", "step13-report.js"],
      ["step1.1-coin-descriptions.js", "step13-report.js"],
      ["step12.1-market-brief.js", "step13-report.js"],
      ["step13-report.js", "step14-telegram.js"],
    ]) {
      before(input, consumer)
    }
    if (started("step12-peer-radar-analysis.js")) {
      before("step12-peer-radar-analysis.js", "step13-report.js")
    }

    if (failedSteps.some(step => [
      "step6-news-enrichment.js", "step7-twitter-enrichment.js", "step8-context-enrichment.js",
      "step8.1-pattern-enrichment.js", "step10-agent-analysis.js", "step13-report.js",
    ].includes(step))) {
      assert.equal(started("step14-telegram.js"), false)
      await assert.rejects(fs.access(path.join(directory, "reports", "main.parquet")), { code: "ENOENT" })
      return
    }

    assert.equal(started("step12-peer-radar-analysis.js"), !failedSteps.includes("step11-peer-radar.js"))
    assert.equal(await fs.readFile(path.join(directory, "reports", "main.parquet"), "utf8"), "Saved report data")
    assert.equal(started("step14-telegram.js"), true)
  })
}
