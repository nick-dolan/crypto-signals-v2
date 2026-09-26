import fs from "node:fs/promises"
import { pathToFileURL } from "node:url"

import { readTmpJson, writeTmpJson } from "./helpers/fs-helper.js"
import { runStep } from "./helpers/run-step-helper.js"
import { analyzePeerRadar } from "./steps/step12-peer-radar-analysis/analyze-peer-radar.js"
import { InvalidPeerRadarAnalysisError } from "./steps/step12-peer-radar-analysis/parse-peer-radar-analysis.js"

export async function runPeerRadarAnalysisStep ({ callAgent } = {}) {
  const [scan, systemPrompt] = await Promise.all([
    readTmpJson("step11-peer-radar.json"),
    fs.readFile(new URL("./prompts/peer-radar-analysis.md", import.meta.url), "utf8"),
  ])
  let report

  try {
    report = await analyzePeerRadar(scan, systemPrompt, { callAgent })
  } catch (error) {
    if (error instanceof InvalidPeerRadarAnalysisError) {
      const invalidOutputPath = await writeTmpJson("step12-peer-radar-analysis.invalid.json", {
        asOf: scan.asOf,
        error: error.message,
        response: error.response ?? null,
      })

      console.error(`Saved invalid peer radar response to ${invalidOutputPath}`)
    }
    throw error
  }

  const outputPath = await writeTmpJson("step12-peer-radar-analysis.json", report)

  console.log(`✓ Prepared ${report.observationCount} peer radar observations (${report.watchCount} watch) in ${outputPath}; step 13 archives the complete report`)

  return { report, outputPath }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runStep("step12-peer-radar-analysis.js", runPeerRadarAnalysisStep)
}
