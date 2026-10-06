import { spawn } from "node:child_process"

import { resetTmpDirectory } from "./helpers/fs-helper.js"
import { isError } from "./helpers/utils.typed.js"

function runStep (scriptPath) {
  return new Promise((resolve, reject) => {
    console.log("\n================================================")
    console.log(`🚀 Running ${scriptPath}...`)
    console.log("================================================\n")

    const child = spawn(process.execPath, [scriptPath], {
      stdio: "inherit",
      cwd: process.cwd(),
      env: process.env,
    })

    child.on("close", code => resolve(code === 0))

    child.on("error", reject)
  })
}

async function runAll () {
  const startTime = Date.now()
  process.env.PIPELINE_STARTED_AT = String(Math.floor(startTime / 1_000))

  try {
    await resetTmpDirectory()
    console.log("\n🧹 Cleared tmp directory")

    let coinDescriptionsFailed = false
    let peerRadarFailed = false
    let marketBriefFailed = false

    for (const step of [
      "step1-crypto-universe.js",
      "step1.1-coin-descriptions.js",
      "step2-data-bootstrap.js",
      "step3-market-context.js",
      "step3.1-coingecko-trending.js",
      "step4-feature-metrics.js",
      "step5-preliminary-filter.js",
      "step8-news-enrichment.js",
      "step9-twitter-enrichment.js",
      "step10-context-enrichment.js",
      "step6-agent-payload.js",
      "step7-agent-analysis.js",
      "step11-peer-radar.js",
      "step12-peer-radar-analysis.js",
      "step12.1-market-brief.js",
      "step13-report.js",
      "step14-telegram.js",
    ]) {
      if (peerRadarFailed && step === "step12-peer-radar-analysis.js") {
        continue
      }

      const succeeded = await runStep(`src/${step}`)

      if (!succeeded) {
        if (step === "step1.1-coin-descriptions.js") {
          coinDescriptionsFailed = true
          console.warn("⚠ Optional coin descriptions enrichment failed (step 1.1); continuing the pipeline")
          continue
        }
        if (step === "step12.1-market-brief.js") {
          marketBriefFailed = true
          console.warn("⚠ Optional market brief failed (step 12.1); continuing to the main report")
          continue
        }
        process.exitCode = 1
        if (["step11-peer-radar.js", "step12-peer-radar-analysis.js"].includes(step)) {
          peerRadarFailed = true
          console.warn("⚠ Peer radar failed; continuing to the independent main Parquet snapshot")
          continue
        }
        return
      }
    }

    const duration = ((Date.now() - startTime) / 1000).toFixed(1)

    if (coinDescriptionsFailed || peerRadarFailed || marketBriefFailed) {
      const failures = [
        coinDescriptionsFailed && "optional coin descriptions enrichment failed (step 1.1)",
        peerRadarFailed && "the peer radar failed",
        marketBriefFailed && "optional market brief failed (step 12.1)",
      ].filter(Boolean).join("; ")
      console.warn(`\n⚠ Main report completed in ${duration}s, but ${failures}`)
    } else {
      const completedAt = new Date()
      const date = completedAt.toLocaleDateString("en-GB", {
        timeZone: "Europe/Moscow", day: "numeric", month: "long",
      })
      const time = completedAt.toLocaleTimeString("en-GB", {
        timeZone: "Europe/Moscow", hour: "2-digit", minute: "2-digit",
      })
      console.log(`\n✨ All steps completed successfully in ${duration}s! · ${date} ${time} UTC+3`)
    }
  } catch (error) {
    const message = isError(error) ? error.message : "Unknown error"

    console.error(`\n❌ Pipeline failed: ${message}`)
    process.exitCode = 1
  }
}

await runAll()
