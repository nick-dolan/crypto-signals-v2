import fs from "node:fs/promises"

import { readTmpJson, writeTmpJson } from "./helpers/fs-helper.js"
import { runStep } from "./helpers/run-step-helper.js"
import { analyzeCandidates } from "./steps/step7-agent-analysis/analyze-candidates.js"
import { InvalidCopilotAnalysisError } from "./steps/step7-agent-analysis/parse-agent-analysis.js"

async function runAgentAnalysisStep () {
  const [payload, shortlist, systemPrompt] = await Promise.all([
    readTmpJson("step6-agent-payload.json"),
    readTmpJson("step5-preliminary-filter.json"),
    fs.readFile(
      new URL("./prompts/strong-move-probability.md", import.meta.url),
      "utf8",
    ),
  ])
  let analysis

  try {
    analysis = await analyzeCandidates(payload, shortlist, systemPrompt)
  } catch (error) {
    if (
      error instanceof InvalidCopilotAnalysisError
      && typeof error.response === "string"
    ) {
      const invalidOutputPath = await writeTmpJson(
        "step7-agent-analysis.invalid.json",
        {
          asOf: payload.asOf,
          error: error.message,
          response: error.response,
        },
      )

      console.error(`Saved invalid Copilot response to ${invalidOutputPath}`)
    }

    throw error
  }

  const outputPath = await writeTmpJson("step7-agent-analysis.json", analysis)

  console.log(
    `✓ Saved ${analysis.assessments.length} agent assessments with ${analysis.topCandidates.length} top candidates to ${outputPath}`,
  )
}

await runStep("step7-agent-analysis.js", runAgentAnalysisStep)
