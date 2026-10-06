import fs from "node:fs/promises"

import { readTmpJson, writeTmpJson } from "./helpers/fs-helper.js"
import { runStep } from "./helpers/run-step-helper.js"
import { enrichCandidatesWithContext } from "./steps/step8-context-enrichment/enrich-candidates-with-context.js"
import { InvalidContextEnrichmentError } from "./steps/step8-context-enrichment/parse-context-enrichment.js"

async function runContextEnrichmentStep () {
  const [input, systemPrompt] = await Promise.all([
    readTmpJson("step7-twitter-enrichment.json"),
    fs.readFile(
      new URL("./prompts/candidate-context-enrichment.md", import.meta.url),
      "utf8",
    ),
  ])
  let output

  try {
    output = await enrichCandidatesWithContext(input, systemPrompt)
  } catch (error) {
    if (error instanceof InvalidContextEnrichmentError) {
      const invalidOutputPath = await writeTmpJson(
        "step8-context-enrichment.invalid.json",
        {
          symbol: error.symbol,
          error: error.message,
          response: error.response,
        },
      )

      console.error(`Saved invalid context response to ${invalidOutputPath}`)
    }

    throw error
  }

  const outputPath = await writeTmpJson("step8-context-enrichment.json", output)

  console.log(
    `✓ Summarized news and Twitter for ${output.candidates.length} preliminary candidates in ${outputPath}`,
  )
}

await runStep("step8-context-enrichment.js", runContextEnrichmentStep)
