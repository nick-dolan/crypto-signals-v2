import { readTmpJson, writeTmpJson } from "./helpers/fs-helper.js"
import { runStep } from "./helpers/run-step-helper.js"
import { enrichTopCandidatesWithNews } from "./steps/step8-news-enrichment/enrich-top-candidates-with-news.js"

async function runNewsEnrichmentStep () {
  const [analysis, shortlist] = await Promise.all([
    readTmpJson("step7-agent-analysis.json"),
    readTmpJson("step5-preliminary-filter.json"),
  ])
  const output = await enrichTopCandidatesWithNews(analysis, shortlist)
  const outputPath = await writeTmpJson("step8-news-enrichment.json", output)
  const uniqueArticleCount = new Set(output.topCandidates.flatMap(candidate => (
    candidate.news.items.map(item => item.id)
  ))).size
  const failedCandidateCount = output.topCandidates.filter(candidate => (
    candidate.news.status === "failed"
  )).length

  console.log(
    `✓ Enriched ${output.topCandidates.length} top candidates with ${uniqueArticleCount} unique news items in ${outputPath}`,
  )

  if (failedCandidateCount > 0) {
    console.log(`✗ News unavailable for ${failedCandidateCount} top candidates`)
  }
}

await runStep("step8-news-enrichment.js", runNewsEnrichmentStep)
