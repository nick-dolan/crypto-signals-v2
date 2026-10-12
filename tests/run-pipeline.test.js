import assert from "node:assert/strict"
import path from "node:path"
import test from "node:test"

import { runPipeline } from "../src/steps/run-pipeline.js"

test("successful pipeline analyzes candidates before publishing the report and Telegram release", async () => {
  const calls = []
  const result = await runPipeline({
    runStep: async (file) => {
      calls.push(path.basename(file))
      return true
    },
  })

  assert.deepEqual(calls.filter(step => [
    "step4-feature-metrics.js", "step5-preliminary-filter.js", "candidate-enrichment.js",
    "step9-agent-payload.js", "step10-agent-analysis.js", "step13-report.js", "step14-telegram.js",
  ].includes(step)), [
    "step4-feature-metrics.js", "step5-preliminary-filter.js", "candidate-enrichment.js",
    "step9-agent-payload.js", "step10-agent-analysis.js", "step13-report.js", "step14-telegram.js",
  ])
  assert.equal(result.exitCode, 0)
})

test("a mandatory calculation failure stops selection and publication", async () => {
  const calls = []

  await assert.rejects(runPipeline({
    runStep: async (file) => {
      const step = path.basename(file)
      calls.push(step)
      return step !== "step4-feature-metrics.js"
    },
  }), /Pipeline step failed: step4-feature-metrics/)

  for (const step of ["step5-preliminary-filter.js", "step13-report.js", "step14-telegram.js"]) {
    assert.equal(calls.includes(step), false)
  }
})
