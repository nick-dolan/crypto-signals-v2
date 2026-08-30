import { styleText } from "node:util"

export async function runStep (stepName, callback) {
  try {
    await callback()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const label = styleText(["bold", "red"], `❌ ${stepName}:`, { stream: process.stderr })
    const details = styleText("yellow", message, { stream: process.stderr })

    console.error(`\n${label} ${details}`)
    process.exitCode = 1
  }
}
