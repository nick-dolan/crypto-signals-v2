import "dotenv/config"
import { pathToFileURL } from "node:url"

import { fetchTweetPage } from "./api/twitter-api.js"
import { readTmpJson, writeTmpJson } from "./helpers/fs-helper.js"
import { runStep } from "./helpers/run-step-helper.js"
import { isString } from "./helpers/utils.typed.js"
import { enrichCandidatesWithTwitter } from "./steps/step7-twitter-enrichment/enrich-candidates-with-twitter.js"

export function validateTwitterApiKey () {
  const apiKey = process.env.TWITTERAPI_IO_KEY

  if (!isString(apiKey) || !apiKey.trim()) {
    throw new Error("TWITTERAPI_IO_KEY is not set in .env")
  }
}

export async function runTwitterEnrichmentStep ({
  readJson = readTmpJson,
  enrich = enrichCandidatesWithTwitter,
  writeJson = writeTmpJson,
  enrichmentOptions = {},
} = {}) {
  if (enrich === enrichCandidatesWithTwitter && [undefined, fetchTweetPage].includes(enrichmentOptions.fetchPage)) {
    validateTwitterApiKey()
  }

  const input = await readJson("step6-news-enrichment.json")
  const output = await enrich(input, enrichmentOptions)
  const outputPath = await writeJson("step7-twitter-enrichment.json", output)
  const tweetCount = output.candidates.reduce((total, candidate) => (
    total + candidate.twitter.tweets.length
  ), 0)
  const failedCandidateCount = output.candidates.filter(candidate => (
    candidate.twitter.status === "failed"
  )).length

  console.log(
    `✓ Enriched ${output.candidates.length} preliminary candidates with ${tweetCount} tweets from the last 24 hours in ${outputPath}`,
  )

  if (failedCandidateCount > 0) {
    console.log(`✗ Twitter unavailable for ${failedCandidateCount} preliminary candidates`)
  }

  return output
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runStep("step7-twitter-enrichment.js", runTwitterEnrichmentStep)
}
