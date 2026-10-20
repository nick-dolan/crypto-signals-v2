import { isFunction } from "../helpers/utils.typed.js"

export async function runPipeline ({ runStep, onWarning = console.warn } = {}) {
  if (!isFunction(runStep)) {
    throw new Error("Pipeline runStep must be a function")
  }

  const failures = {
    coinDescriptionsFailed: false,
    peerRadarFailed: false,
    marketBriefFailed: false,
  }
  const running = []
  let fatal = null
  let stopped = false
  let descriptionsFinished = false

  const start = (step, onFailure, options = {}) => {
    const task = Promise.resolve().then(() => (
      stopped || fatal !== null ? false : runStep(`src/${step}`, options)
    )).then((result) => {
      const succeeded = result === true || result?.succeeded === true
      if (!succeeded && !stopped && fatal === null) {
        if (onFailure) {
          onFailure()
        } else {
          fatal = result?.error ?? new Error(`Pipeline step failed: ${step}`)
        }
      }
      return succeeded
    }).catch((error) => {
      fatal ??= error ?? new Error(`Pipeline step failed: ${step}`)
      return false
    })
    running.push(task)
    return task
  }

  const waitFor = async (tasks) => {
    await Promise.all(tasks)
    if (fatal !== null) {
      throw fatal
    }
  }
  const radarFailed = () => {
    failures.peerRadarFailed = true
    onWarning("⚠ Peer radar failed; continuing to the independent main Parquet snapshot")
  }

  try {
    await waitFor([
      start("step1-coin-list.js"),
      start("step3-market-context.js"),
    ])

    const bootstrap = start("step2-data-bootstrap.js")
    const trending = start("step3.1-coingecko-trending.js")
    const descriptions = trending.then(succeeded => (
      succeeded
        ? start("step1.1-coin-descriptions.js", () => {
            failures.coinDescriptionsFailed = true
            onWarning("⚠ Optional coin descriptions enrichment failed (step 1.1); continuing the pipeline")
          })
        : false
    )).finally(() => {
      descriptionsFinished = true
    })
    const scan = bootstrap.then(succeeded => (
      succeeded ? start("step11-peer-radar.js", radarFailed) : false
    ))
    const radar = scan.then(succeeded => (
      succeeded ? start("step12-peer-radar-analysis.js", radarFailed) : false
    ))
    running.push(descriptions, scan, radar)

    await waitFor([bootstrap, trending])
    await waitFor([start("step4-feature-metrics.js")])
    await waitFor([start("step5-preliminary-filter.js")])
    await waitFor([start("candidate-enrichment.js", undefined, {
      // An unfinished description worker reserves one of the ten LLM slots.
      concurrency: descriptionsFinished ? 10 : 9,
    })])
    await waitFor([start("step9-agent-payload.js")])
    await waitFor([start("step10-agent-analysis.js")])

    await waitFor([descriptions])
    const brief = start("step12.1-market-brief.js", () => {
      failures.marketBriefFailed = true
      onWarning("⚠ Optional market brief failed (step 12.1); continuing to the main report")
    })
    await waitFor([brief, radar])
    await waitFor([start("step13-report.js")])
    await waitFor([start("step14-telegram.js")])

    return { ...failures, exitCode: failures.peerRadarFailed ? 1 : 0 }
  } finally {
    stopped = true
    await Promise.all(running)
  }
}
