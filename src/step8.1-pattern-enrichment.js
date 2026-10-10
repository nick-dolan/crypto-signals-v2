import fs from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"

import { readTmpJson, writeTmpJson } from "./helpers/fs-helper.js"
import { runStep } from "./helpers/run-step-helper.js"
import { enrichCandidatesWithPatterns } from "./steps/step8.1-pattern-enrichment/enrich-candidates-with-patterns.js"
import { preparePatternCandidates } from "./steps/step8.1-pattern-enrichment/prepare-pattern-candidates.js"

export async function runPatternEnrichmentStep ({
  readJson = readTmpJson,
  prepare = preparePatternCandidates,
  enrich = enrichCandidatesWithPatterns,
  writeJson = writeTmpJson,
} = {}) {
  await fs.rm("tmp/step8.1-pattern-enrichment.json", { force: true })
  const [input, systemPrompt] = await Promise.all([
    readJson("step5-preliminary-filter.json"),
    fs.readFile(new URL("./prompts/candidate-pattern-enrichment.md", import.meta.url), "utf8"),
  ])
  const prepared = await prepare(input)
  const output = await enrich(prepared, systemPrompt)
  await writeJson(path.join(prepared.directory, "manifest.json"), {
    ...prepared,
    generatedAt: output.generatedAt,
    patternEnrichment: output.patternEnrichment,
    candidates: prepared.candidates.map((candidate, index) => ({ ...candidate, ...output.candidates[index] })),
  })
  const outputPath = await writeJson("step8.1-pattern-enrichment.json", output)
  console.log(`✓ Analyzed weekly patterns for ${output.candidates.filter(candidate => candidate.status === "available").length}/${output.candidateCount} candidates in ${outputPath}`)
  return output
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runStep("step8.1-pattern-enrichment.js", runPatternEnrichmentStep)
}
