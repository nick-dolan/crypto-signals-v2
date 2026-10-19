import { spawn } from "node:child_process"
import path from "node:path"

import { redactSecrets, withErrorContext } from "./error-helper.js"
import { formatStepError, sendErrorNotification } from "./step-error-helper.js"
import { isSafeInteger, isString } from "./utils.typed.js"

export async function runStepProcess (scriptPath, {
  concurrency,
  spawnProcess = spawn,
  notify = sendErrorNotification,
  stderr = process.stderr,
} = {}) {
  console.log("\n================================================")
  console.log(`🚀 Running ${scriptPath}...`)
  console.log("================================================\n")

  const startedAt = Date.now()
  const reports = []
  const notifications = []
  let completion
  let crashed = false
  let launchError
  let output = ""
  let pendingOutput = ""
  let lineTooLong = false
  let result
  const writeOutput = (line) => {
    const safe = redactSecrets(line)
    stderr.write(safe)
    output = (output + safe).slice(-16_000)
  }

  try {
    const args = [scriptPath, ...(concurrency === undefined ? [] : ["--concurrency", String(concurrency)])]
    const child = spawnProcess(process.execPath, args, {
      stdio: ["inherit", "inherit", "pipe", "ipc"],
      cwd: process.cwd(),
      env: { ...process.env, PIPELINE_STEP: path.basename(scriptPath) },
    })
    child.stderr.setEncoding("utf8")
    child.stderr.on("data", (chunk) => {
      // Redact complete lines so a token split between chunks cannot leak into the journal.
      const lines = (pendingOutput + chunk).split("\n")
      pendingOutput = lines.pop()
      for (const line of lines) {
        if (!lineTooLong) {
          writeOutput(line.length <= 16_000 ? `${line}\n` : "[stderr line exceeded 16000 characters; omitted]\n")
        }
        lineTooLong = false
      }
      if (pendingOutput.length > 16_000) {
        pendingOutput = ""
        if (!lineTooLong) {
          writeOutput("[stderr line exceeded 16000 characters; omitted]\n")
        }
        lineTooLong = true
      }
    })
    child.stderr.on("end", () => {
      if (pendingOutput && !lineTooLong) {
        writeOutput(pendingOutput)
      }
    })
    child.on("message", (message) => {
      if (message?.type === "step-error" && isString(message.text)) {
        reports.push(message)
        notifications.push(Promise.resolve().then(() => notify(redactSecrets(message.text).slice(0, 3_900))))
      }
      if (message?.type === "step-complete" && isSafeInteger(message.exitCode)) {
        completion = message
      }
      if (message?.type === "step-crashed") {
        crashed = true
      }
    })
    child.on("error", (error) => {
      launchError = error
    })
    result = await new Promise(resolve => child.on("close", (code, signal) => resolve({ code, signal })))
  } catch (error) {
    launchError = error
    result = { code: null, signal: null }
  }

  await Promise.allSettled(notifications)
  if (result.code === 0 && !launchError && !result.signal) {
    return { succeeded: true }
  }

  const handled = !launchError && !crashed && !result.signal && completion?.exitCode === result.code && reports.length > 0
  const report = reports.findLast(item => item.fatal) ?? reports.at(-1)
  const error = withErrorContext(launchError ?? new Error(handled
    ? report.message
    : result.signal ? `Step process terminated by ${result.signal}` : `Step process exited with code ${result.code}`), {
    step: path.basename(scriptPath),
    operation: launchError ? "start_process" : "run_process",
    exitCode: result.code,
    signal: result.signal,
    elapsedMs: Date.now() - startedAt,
    stderr: output,
  })
  if (!handled) {
    await notify(formatStepError(error))
  }
  error.reported = true
  return { succeeded: false, error }
}
