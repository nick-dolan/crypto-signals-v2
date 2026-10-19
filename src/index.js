import { redactSecrets } from "./helpers/error-helper.js"
import { resetTmpDirectory } from "./helpers/fs-helper.js"
import { runStepProcess } from "./helpers/run-step-process.js"
import { reportStepError } from "./helpers/step-error-helper.js"
import { isError } from "./helpers/utils.typed.js"
import { runPipeline } from "./steps/run-pipeline.js"

async function runAll () {
  const startTime = Date.now()
  process.env.PIPELINE_STARTED_AT = String(Math.floor(startTime / 1_000))

  try {
    await resetTmpDirectory()
    console.log("\n🧹 Cleared tmp directory")

    const { coinDescriptionsFailed, peerRadarFailed, marketBriefFailed, exitCode } = await runPipeline({ runStep: runStepProcess })
    if (exitCode) {
      process.exitCode = exitCode
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
    const message = redactSecrets(isError(error) ? error.message : String(error))

    console.error(`\n❌ Pipeline failed: ${message}`)
    process.exitCode = 1
    if (!error?.reported) {
      await reportStepError(error, { step: "pipeline", fatal: true })
    }
  }
}

await runAll()
