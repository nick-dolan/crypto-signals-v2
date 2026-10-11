import { pathToFileURL } from "node:url"

import { readTmpJson, writeTmpJson } from "./helpers/fs-helper.js"
import { runStep } from "./helpers/run-step-helper.js"
import { enrichCandidatesWithNews } from "./steps/step6-news-enrichment/enrich-candidates-with-news.js"

export async function runNewsEnrichmentStep ({
  readJson = readTmpJson,
  enrich = enrichCandidatesWithNews,
  writeJson = writeTmpJson,
} = {}) {
  const shortlist = await readJson("step5-preliminary-filter.json")
  const output = await enrich(shortlist)
  const outputPath = await writeJson("step6-news-enrichment.json", output)
  const uniqueArticleCount = new Set(output.candidates.flatMap(candidate => (
    candidate.news.items.map(item => item.id)
  ))).size
  const failedCandidateCount = output.candidates.filter(candidate => (
    candidate.news.status === "failed"
  )).length

  console.log(
    `✓ Enriched ${output.candidates.length} preliminary candidates with ${uniqueArticleCount} unique news items in ${outputPath}`,
  )

  if (failedCandidateCount > 0) {
    console.log(`✗ News unavailable for ${failedCandidateCount} preliminary candidates`)
  }

  return output
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runStep("step6-news-enrichment.js", runNewsEnrichmentStep)
}
