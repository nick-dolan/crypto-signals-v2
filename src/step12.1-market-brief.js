import fs from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"

import { readTmpJson, writeTmpJson } from "./helpers/fs-helper.js"
import { getRequiredString } from "./helpers/normalization-helper.js"
import { runStep } from "./helpers/run-step-helper.js"
import { buildMarketBrief } from "./steps/step12.1-market-brief/build-market-brief.js"

export async function runMarketBriefStep ({ buildBrief = buildMarketBrief } = {}) {
  // A failed rerun must not leave a previous digest looking like a fresh result.
  await fs.rm(path.resolve("tmp", "step12.1-market-brief.json"), { force: true })
  const [analysis, systemPrompt] = await Promise.all([
    readTmpJson("step7-agent-analysis.json"),
    fs.readFile(new URL("./prompts/market-brief.md", import.meta.url), "utf8"),
  ])
  const output = await buildBrief(systemPrompt, {
    marketAsOf: getRequiredString(analysis.asOf, "Step 7 asOf"),
  })
  const outputPath = await writeTmpJson("step12.1-market-brief.json", output)
  console.log(`✓ Market brief: ${output.paragraphs.length} paragraphs from ${output.sources.length} publications (${output.status}) in ${outputPath}`)
  if (output.warning) {
    console.warn(`⚠ ${output.warning}`)
  }
  if (output.analysis.error) {
    console.warn(`⚠ ${output.analysis.error}`)
  }
  return output
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runStep("step12.1-market-brief.js", async () => {
    const result = await runMarketBriefStep()
    if (result.status === "unavailable") {
      process.exitCode = 1
    }
  })
}
