import fs from "node:fs/promises"

import { readTmpJson, writeTmpJson } from "./helpers/fs-helper.js"
import { runStep } from "./helpers/run-step-helper.js"
import { enrichTopCandidatesWithContext } from "./steps/step10-context-enrichment/enrich-top-candidates-with-context.js"
import { InvalidContextEnrichmentError } from "./steps/step10-context-enrichment/parse-context-enrichment.js"

async function runContextEnrichmentStep () {
  const [input, systemPrompt] = await Promise.all([
    readTmpJson("step9-twitter-enrichment.json"),
    fs.readFile(
      new URL("./prompts/candidate-context-enrichment.md", import.meta.url),
      "utf8",
    ),
  ])
  let output

  try {
    output = await enrichTopCandidatesWithContext(input, systemPrompt)
  } catch (error) {
    if (error instanceof InvalidContextEnrichmentError) {
      const invalidOutputPath = await writeTmpJson(
        "step10-context-enrichment.invalid.json",
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

  const outputPath = await writeTmpJson("step10-context-enrichment.json", output)

  console.log(
    `✓ Added news and Twitter context to ${output.topCandidates.length} candidate explanations in ${outputPath}`,
  )
}

await runStep("step10-context-enrichment.js", runContextEnrichmentStep)
