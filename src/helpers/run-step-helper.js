import { styleText } from "node:util"

import { redactSecrets } from "./error-helper.js"
import { reportStepError, sendStepMessage } from "./step-error-helper.js"
import { isError } from "./utils.typed.js"

export async function runStep (stepName, callback) {
  if (process.connected) {
    process.once("uncaughtExceptionMonitor", () => {
      void sendStepMessage({ type: "step-crashed" })
    })
  }
  try {
    await callback()
  } catch (error) {
    const message = redactSecrets(isError(error) ? error.message : String(error))
    const label = styleText(["bold", "red"], `❌ ${stepName}:`, { stream: process.stderr })
    const details = styleText("yellow", message, { stream: process.stderr })

    console.error(`\n${label} ${details}`)
    process.exitCode = 1
    await reportStepError(error, { step: stepName, fatal: true })
  } finally {
    if (process.connected) {
      // A late uncaught exception must not leave a valid completion marker.
      process.once("beforeExit", () => {
        void sendStepMessage({ type: "step-complete", exitCode: Number(process.exitCode) || 0 })
      })
    }
  }
}
