import { readTmpJson, writeTmpJson } from "./helpers/fs-helper.js"
import { runStep } from "./helpers/run-step-helper.js"
import { enrichCandidatesWithNews } from "./steps/step8-news-enrichment/enrich-candidates-with-news.js"

async function runNewsEnrichmentStep () {
  const shortlist = await readTmpJson("step5-preliminary-filter.json")
  const output = await enrichCandidatesWithNews(shortlist)
  const outputPath = await writeTmpJson("step8-news-enrichment.json", output)
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
}

await runStep("step8-news-enrichment.js", runNewsEnrichmentStep)
