import fs from "node:fs/promises"
import { pathToFileURL } from "node:url"

import { readTmpJson, writeTmpJson } from "./helpers/fs-helper.js"
import { runStep } from "./helpers/run-step-helper.js"
import { enrichCandidatesWithContext } from "./steps/step8-context-enrichment/enrich-candidates-with-context.js"
import { InvalidContextEnrichmentError } from "./steps/step8-context-enrichment/parse-context-enrichment.js"

export async function runContextEnrichmentStep ({
  readJson = readTmpJson,
  readPrompt = () => fs.readFile(new URL("./prompts/candidate-context-enrichment.md", import.meta.url), "utf8"),
  enrich = enrichCandidatesWithContext,
  writeJson = writeTmpJson,
} = {}) {
  const [input, systemPrompt] = await Promise.all([
    readJson("step7-twitter-enrichment.json"),
    readPrompt(),
  ])
  let output

  try {
    output = await enrich(input, systemPrompt)
  } catch (error) {
    if (error instanceof InvalidContextEnrichmentError) {
      try {
        const invalidOutputPath = await writeJson("step8-context-enrichment.invalid.json", {
          symbol: error.symbol,
          error: error.message,
          response: error.response,
        })
        console.error(`Saved invalid context response to ${invalidOutputPath}`)
      } catch (writeError) {
        console.error("Could not save invalid context response:", writeError)
      }
    }

    throw error
  }

  const outputPath = await writeJson("step8-context-enrichment.json", output)

  console.log(
    `✓ Summarized news and Twitter for ${output.candidates.length} preliminary candidates in ${outputPath}`,
  )

  return output
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runStep("step8-context-enrichment.js", runContextEnrichmentStep)
}
