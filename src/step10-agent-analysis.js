import fs from "node:fs/promises"

import { readTmpJson, writeTmpJson } from "./helpers/fs-helper.js"
import { runStep } from "./helpers/run-step-helper.js"
import { isPrimitive, isString } from "./helpers/utils.typed.js"
import { analyzeCandidates } from "./steps/step10-agent-analysis/analyze-candidates.js"
import { InvalidCopilotAnalysisError } from "./steps/step10-agent-analysis/parse-agent-analysis.js"

async function runAgentAnalysisStep () {
  const [payload, shortlist, systemPrompt] = await Promise.all([
    readTmpJson("step9-agent-payload.json"),
    readTmpJson("step5-preliminary-filter.json"),
    fs.readFile(
      new URL("./prompts/strong-move-probability.md", import.meta.url),
      "utf8",
    ),
  ])

  if (payload.schemaVersion !== 14 || payload.objective !== "P(рост > 2.5 ATR в следующие 4–12 часов)") {
    throw new Error("Growth analysis requires the current payload with information context; rerun steps 6, 7, 8 and 9")
  }

  let analysis

  try {
    analysis = await analyzeCandidates(payload, shortlist, systemPrompt)
  } catch (error) {
    if (
      error instanceof InvalidCopilotAnalysisError
      && isPrimitive(error.response)
      && isString(error.response)
    ) {
      const invalidOutputPath = await writeTmpJson(
        "step10-agent-analysis.invalid.json",
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

  const outputPath = await writeTmpJson("step10-agent-analysis.json", analysis)

  console.log(
    `✓ Saved ${analysis.assessments.length} agent assessments with ${analysis.topCandidates.length} top candidates to ${outputPath}`,
  )
}

await runStep("step10-agent-analysis.js", runAgentAnalysisStep)
