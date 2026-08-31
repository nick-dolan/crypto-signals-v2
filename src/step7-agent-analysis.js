import fs from "node:fs/promises"

import { readTmpJson, writeTmpJson } from "./helpers/fs-helper.js"
import { runStep } from "./helpers/run-step-helper.js"
import { analyzeCandidates } from "./steps/step7-agent-analysis/analyze-candidates.js"

async function runAgentAnalysisStep () {
  const [payload, shortlist, systemPrompt] = await Promise.all([
    readTmpJson("step6-agent-payload.json"),
    readTmpJson("step5-preliminary-filter.json"),
    fs.readFile(
      new URL("./prompts/strong-move-probability.md", import.meta.url),
      "utf8",
    ),
  ])
  const analysis = await analyzeCandidates(payload, shortlist, systemPrompt)
  const outputPath = await writeTmpJson("step7-agent-analysis.json", analysis)

  console.log(
    `✓ Saved ${analysis.assessments.length} agent assessments with ${analysis.topCandidates.length} top candidates to ${outputPath}`,
  )
}

await runStep("step7-agent-analysis.js", runAgentAnalysisStep)
