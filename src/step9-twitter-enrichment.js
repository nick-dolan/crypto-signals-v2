import "dotenv/config"

import { readTmpJson, writeTmpJson } from "./helpers/fs-helper.js"
import { runStep } from "./helpers/run-step-helper.js"
import { isString } from "./helpers/utils.typed.js"
import { enrichTopCandidatesWithTwitter } from "./steps/step9-twitter-enrichment/enrich-top-candidates-with-twitter.js"

async function runTwitterEnrichmentStep () {
  const apiKey = process.env.TWITTERAPI_IO_KEY

  if (!isString(apiKey) || !apiKey.trim()) {
    throw new Error("TWITTERAPI_IO_KEY is not set in .env")
  }

  const input = await readTmpJson("step8-news-enrichment.json")
  const output = await enrichTopCandidatesWithTwitter(input)
  const outputPath = await writeTmpJson("step9-twitter-enrichment.json", output)
  const tweetCount = output.topCandidates.reduce((total, candidate) => (
    total + candidate.twitter.tweets.length
  ), 0)
  const failedCandidateCount = output.topCandidates.filter(candidate => (
    candidate.twitter.status === "failed"
  )).length

  console.log(
    `✓ Enriched ${output.topCandidates.length} top candidates with ${tweetCount} tweets from the last 24 hours in ${outputPath}`,
  )

  if (failedCandidateCount > 0) {
    console.log(`✗ Twitter unavailable for ${failedCandidateCount} top candidates`)
  }
}

await runStep("step9-twitter-enrichment.js", runTwitterEnrichmentStep)
