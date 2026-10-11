import assert from "node:assert/strict"
import path from "node:path"
import test from "node:test"
import { setImmediate } from "node:timers/promises"

import { runPipeline } from "../src/steps/run-pipeline.js"

function controlPipeline (context) {
  const calls = []
  const active = new Set()
  const gates = new Map()
  const starts = new Map()
  const warnings = []
  let closing = false
  let settled = false
  let maxTvCharts = 0
  const started = (step) => {
    if (!starts.has(step)) {
      starts.set(step, Promise.withResolvers())
    }
    return starts.get(step)
  }
  const outcome = runPipeline({
    onWarning: message => warnings.push(message),
    runStep: async (file, options) => {
      const step = path.basename(file)
      calls.push({ step, options })
      active.add(step)
      maxTvCharts = Math.max(maxTvCharts, [...active].reduce((total, name) => (
        total + (name === "step2-data-bootstrap.js" ? 6 : name === "step3-market-context.js" ? 4 : 0)
      ), 0))
      const gate = Promise.withResolvers()
      gates.set(step, gate)
      started(step).resolve()
      try {
        return closing ? true : await gate.promise
      } finally {
        active.delete(step)
      }
    },
  }).then(result => ({ result }), error => ({ error })).finally(() => {
    settled = true
  })
  context.after(async () => {
    closing = true
    for (const gate of gates.values()) {
      gate.resolve(true)
    }
    await outcome
  })
  return {
    calls, active, warnings, outcome,
    started: step => started(step).promise,
    finish: (step, succeeded = true) => gates.get(step).resolve(succeeded),
    fail: (step, error) => gates.get(step).reject(error),
    hasStarted: step => gates.has(step),
    isSettled: () => settled,
    maxTvCharts: () => maxTvCharts,
  }
}

async function finishInitialSteps (control) {
  await Promise.all([control.started("step1-crypto-universe.js"), control.started("step3-market-context.js")])
  control.finish("step1-crypto-universe.js")
  control.finish("step3-market-context.js")
  await Promise.all([control.started("step2-data-bootstrap.js"), control.started("step3.1-coingecko-trending.js")])
}

test("pipeline overlaps independent branches, waits for their inputs and preserves the final publication order", { timeout: 10_000 }, async (context) => {
  const control = controlPipeline(context)
  await Promise.all([control.started("step1-crypto-universe.js"), control.started("step3-market-context.js")])
  control.finish("step1-crypto-universe.js")
  await setImmediate()
  assert.equal(control.hasStarted("step2-data-bootstrap.js"), false)
  control.finish("step3-market-context.js")
  await Promise.all([control.started("step2-data-bootstrap.js"), control.started("step3.1-coingecko-trending.js")])
  assert.equal(control.active.size, 2)
  control.finish("step3.1-coingecko-trending.js")
  await control.started("step1.1-coin-descriptions.js")
  assert.equal(control.active.has("step2-data-bootstrap.js"), true)
  assert.equal(control.hasStarted("step4-feature-metrics.js"), false)

  control.finish("step2-data-bootstrap.js")
  await Promise.all([control.started("step11-peer-radar.js"), control.started("step4-feature-metrics.js")])
  control.finish("step4-feature-metrics.js")
  await control.started("step5-preliminary-filter.js")
  control.finish("step5-preliminary-filter.js")
  await control.started("candidate-enrichment.js")
  assert.deepEqual(control.calls.find(call => call.step === "candidate-enrichment.js").options, { concurrency: 9 })
  assert.equal(control.hasStarted("step9-agent-payload.js"), false)
  control.finish("candidate-enrichment.js")
  await control.started("step9-agent-payload.js")
  control.finish("step9-agent-payload.js")
  await control.started("step10-agent-analysis.js")
  control.finish("step10-agent-analysis.js")
  await setImmediate()
  assert.equal(control.hasStarted("step12.1-market-brief.js"), false)

  control.finish("step1.1-coin-descriptions.js")
  await control.started("step12.1-market-brief.js")
  assert.equal(control.active.has("step11-peer-radar.js"), true)
  assert.equal(control.hasStarted("step12-peer-radar-analysis.js"), false)
  control.finish("step11-peer-radar.js")
  await control.started("step12-peer-radar-analysis.js")
  assert.equal(control.active.has("step12.1-market-brief.js"), true)
  control.finish("step12.1-market-brief.js")
  await setImmediate()
  assert.equal(control.hasStarted("step13-report.js"), false)
  control.finish("step12-peer-radar-analysis.js")
  await control.started("step13-report.js")
  assert.equal(control.active.size, 1)
  assert.equal(control.hasStarted("step14-telegram.js"), false)
  control.finish("step13-report.js")
  await control.started("step14-telegram.js")
  control.finish("step14-telegram.js")

  assert.deepEqual((await control.outcome).result, {
    coinDescriptionsFailed: false, peerRadarFailed: false, marketBriefFailed: false, exitCode: 0,
  })
  assert.equal(control.active.size, 0)
  assert.equal(control.maxTvCharts(), 6)
  assert.equal(control.calls.length, 15)
})

for (const finishesFirst of ["main", "radar"]) {
  test(`radar analysis starts as soon as the scan finishes and publication waits for both agents: ${finishesFirst} finishes first`, { timeout: 10_000 }, async (context) => {
    const control = controlPipeline(context)
    await finishInitialSteps(control)
    control.finish("step3.1-coingecko-trending.js")
    control.finish("step2-data-bootstrap.js")
    await Promise.all([
      control.started("step1.1-coin-descriptions.js"),
      control.started("step11-peer-radar.js"),
      control.started("step4-feature-metrics.js"),
    ])
    assert.equal(control.hasStarted("step12-peer-radar-analysis.js"), false)
    control.finish("step11-peer-radar.js")
    await setImmediate()
    assert.equal(control.hasStarted("step12-peer-radar-analysis.js"), true)
    assert.equal(control.active.has("step4-feature-metrics.js"), true)
    assert.equal(control.active.has("step1.1-coin-descriptions.js"), true)
    assert.equal(control.hasStarted("step10-agent-analysis.js"), false)
    control.finish("step1.1-coin-descriptions.js")

    for (const step of ["step4-feature-metrics.js", "step5-preliminary-filter.js", "candidate-enrichment.js", "step9-agent-payload.js"]) {
      await control.started(step)
      control.finish(step)
    }
    await control.started("step10-agent-analysis.js")
    assert.equal(control.active.has("step12-peer-radar-analysis.js"), true)
    control.finish(finishesFirst === "main" ? "step10-agent-analysis.js" : "step12-peer-radar-analysis.js")
    await setImmediate()
    assert.equal(control.hasStarted("step13-report.js"), false)
    if (finishesFirst === "radar") {
      assert.equal(control.hasStarted("step12.1-market-brief.js"), false)
      control.finish("step10-agent-analysis.js")
    }
    await control.started("step12.1-market-brief.js")
    control.finish("step12.1-market-brief.js")
    await setImmediate()
    if (finishesFirst === "main") {
      assert.equal(control.hasStarted("step13-report.js"), false)
      control.finish("step12-peer-radar-analysis.js")
    }
    await control.started("step13-report.js")
    assert.equal(control.active.size, 1)
    control.finish("step13-report.js")
    await control.started("step14-telegram.js")
    control.finish("step14-telegram.js")
    assert.equal((await control.outcome).result.exitCode, 0)
    assert.equal(control.calls.filter(call => call.step === "step12-peer-radar-analysis.js").length, 1)
    assert.equal(control.active.size, 0)
  })
}

test("pipeline also waits for universe when market history completes first", { timeout: 10_000 }, async (context) => {
  const control = controlPipeline(context)
  await Promise.all([control.started("step1-crypto-universe.js"), control.started("step3-market-context.js")])
  control.finish("step3-market-context.js")
  await setImmediate()
  assert.equal(control.hasStarted("step2-data-bootstrap.js"), false)
  assert.equal(control.hasStarted("step3.1-coingecko-trending.js"), false)
})

test("finished descriptions release all ten slots before candidate enrichment starts", { timeout: 10_000 }, async (context) => {
  const control = controlPipeline(context)
  await finishInitialSteps(control)
  control.finish("step3.1-coingecko-trending.js")
  await control.started("step1.1-coin-descriptions.js")
  control.finish("step1.1-coin-descriptions.js")
  control.finish("step2-data-bootstrap.js")
  await control.started("step4-feature-metrics.js")
  control.finish("step4-feature-metrics.js")
  await control.started("step5-preliminary-filter.js")
  control.finish("step5-preliminary-filter.js")
  await control.started("candidate-enrichment.js")
  assert.deepEqual(control.calls.find(call => call.step === "candidate-enrichment.js").options, { concurrency: 10 })
})

for (const step of [
  "step1-crypto-universe.js", "step3-market-context.js", "step2-data-bootstrap.js",
  "step3.1-coingecko-trending.js", "step4-feature-metrics.js", "step5-preliminary-filter.js",
  "candidate-enrichment.js", "step9-agent-payload.js", "step10-agent-analysis.js",
  "step13-report.js", "step14-telegram.js",
]) {
  test(`mandatory ${step} failure stops the pipeline without publishing a later report`, async () => {
    const calls = []
    await assert.rejects(runPipeline({
      runStep: async (file) => {
        const name = path.basename(file)
        calls.push(name)
        return name !== step
      },
      onWarning: () => {},
    }), error => error.message === `Pipeline step failed: ${step}`)
    if (!["step13-report.js", "step14-telegram.js"].includes(step)) {
      assert.equal(calls.includes("step13-report.js"), false)
    }
    if (step !== "step14-telegram.js") {
      assert.equal(calls.includes("step14-telegram.js"), false)
    }
  })
}

for (const failedSteps of [
  [], ["step1.1-coin-descriptions.js"], ["step11-peer-radar.js"], ["step12-peer-radar-analysis.js"],
  ["step12.1-market-brief.js"], ["step1.1-coin-descriptions.js", "step11-peer-radar.js", "step12.1-market-brief.js"],
]) {
  test(`optional failures preserve the main report and exit semantics: ${failedSteps.join(", ") || "none"}`, async () => {
    const calls = []
    const warnings = []
    const result = await runPipeline({
      runStep: async (file) => {
        const step = path.basename(file)
        calls.push(step)
        return !failedSteps.includes(step)
      },
      onWarning: warning => warnings.push(warning),
    })
    assert.deepEqual(result, {
      coinDescriptionsFailed: failedSteps.includes("step1.1-coin-descriptions.js"),
      peerRadarFailed: failedSteps.some(step => ["step11-peer-radar.js", "step12-peer-radar-analysis.js"].includes(step)),
      marketBriefFailed: failedSteps.includes("step12.1-market-brief.js"),
      exitCode: failedSteps.some(step => ["step11-peer-radar.js", "step12-peer-radar-analysis.js"].includes(step)) ? 1 : 0,
    })
    assert.equal(calls.includes("step12-peer-radar-analysis.js"), !failedSteps.includes("step11-peer-radar.js"))
    assert.deepEqual(calls.slice(-2), ["step13-report.js", "step14-telegram.js"])
    assert.equal(warnings.length, failedSteps.length)
  })
}

for (const step of ["step1.1-coin-descriptions.js", "step11-peer-radar.js", "step12-peer-radar-analysis.js", "step12.1-market-brief.js"]) {
  test(`launch errors stay fatal even for optional ${step}`, async () => {
    const failure = new Error("Child launch failed")
    const calls = []
    await assert.rejects(runPipeline({
      runStep: async (file) => {
        const name = path.basename(file)
        calls.push(name)
        if (name === step) {
          throw failure
        }
        return true
      },
    }), error => error === failure)
    assert.equal(calls.includes("step13-report.js"), false)
    assert.equal(calls.includes("step14-telegram.js"), false)
  })
}

test("pipeline drains a started sibling and preserves the original launch error", { timeout: 10_000 }, async (context) => {
  const control = controlPipeline(context)
  const failure = new Error("Universe launch failed")
  await Promise.all([control.started("step1-crypto-universe.js"), control.started("step3-market-context.js")])
  control.fail("step1-crypto-universe.js", failure)
  await setImmediate()
  assert.equal(control.isSettled(), false)
  assert.equal(control.hasStarted("step2-data-bootstrap.js"), false)
  control.finish("step3-market-context.js")
  assert.strictEqual((await control.outcome).error, failure)
  assert.equal(control.active.size, 0)
})

test("a fatal main agent failure drains an already-running radar analysis and preserves the original error", { timeout: 10_000 }, async (context) => {
  const control = controlPipeline(context)
  const failure = new Error("Main agent launch failed")
  await finishInitialSteps(control)
  control.finish("step3.1-coingecko-trending.js")
  control.finish("step2-data-bootstrap.js")
  await Promise.all([
    control.started("step1.1-coin-descriptions.js"),
    control.started("step11-peer-radar.js"),
    control.started("step4-feature-metrics.js"),
  ])
  control.finish("step1.1-coin-descriptions.js")
  control.finish("step11-peer-radar.js")
  await setImmediate()
  assert.equal(control.hasStarted("step12-peer-radar-analysis.js"), true)
  for (const step of ["step4-feature-metrics.js", "step5-preliminary-filter.js", "candidate-enrichment.js", "step9-agent-payload.js"]) {
    await control.started(step)
    control.finish(step)
  }
  await control.started("step10-agent-analysis.js")
  control.fail("step10-agent-analysis.js", failure)
  await setImmediate()
  assert.equal(control.isSettled(), false)
  assert.equal(control.hasStarted("step13-report.js"), false)
  assert.equal(control.hasStarted("step14-telegram.js"), false)
  control.finish("step12-peer-radar-analysis.js")
  assert.strictEqual((await control.outcome).error, failure)
  assert.equal(control.active.size, 0)
  assert.equal(control.hasStarted("step12.1-market-brief.js"), false)
})

test("a fatal main failure drains background descriptions and scan without starting later work", { timeout: 10_000 }, async (context) => {
  const control = controlPipeline(context)
  await finishInitialSteps(control)
  control.finish("step3.1-coingecko-trending.js")
  await control.started("step1.1-coin-descriptions.js")
  control.finish("step2-data-bootstrap.js")
  await Promise.all([control.started("step11-peer-radar.js"), control.started("step4-feature-metrics.js")])
  control.finish("step4-feature-metrics.js", false)
  await setImmediate()
  assert.equal(control.isSettled(), false)
  assert.equal(control.hasStarted("step5-preliminary-filter.js"), false)
  control.finish("step1.1-coin-descriptions.js")
  await setImmediate()
  assert.equal(control.isSettled(), false)
  control.finish("step11-peer-radar.js")
  assert.match((await control.outcome).error.message, /step4-feature-metrics/)
  assert.equal(control.active.size, 0)
  assert.equal(control.hasStarted("step12-peer-radar-analysis.js"), false)
})
