import { spawn } from "node:child_process"
import { resetTmpDirectory } from "./helpers/fs-helper.js"

const computationalSteps = [
  "step1-crypto-universe.js",
  "step2-data-bootstrap.js",
]

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

    child.on("close", (code) => {
      if (code === 0) {
        resolve()
      } else {
        reject(new Error(`Step ${scriptPath} failed with exit code ${code}`))
      }
    })

    child.on("error", reject)
  })
}

async function runAll () {
  const startTime = Date.now()

  try {
    await resetTmpDirectory()
    console.log("\n🧹 Cleared tmp directory")

    for (const step of computationalSteps) {
      await runStep(`src/${step}`)
    }

    const duration = ((Date.now() - startTime) / 1000).toFixed(1)

    console.log(`\n✨ All steps completed successfully in ${duration}s!`)
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error"

    console.error(`\n❌ Pipeline failed: ${message}`)
    process.exitCode = 1
  }
}

await runAll()
