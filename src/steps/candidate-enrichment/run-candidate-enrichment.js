import fs from "node:fs/promises"
import path from "node:path"

import { fetchTradingViewNewsStory } from "../../api/tradingview/news-story.js"
import { fetchTradingViewNews } from "../../api/tradingview/news.js"
import { fetchTweetPage } from "../../api/twitter-api.js"
import { createConcurrencyLimiter } from "../../helpers/concurrency-limiter.js"
import { readTmpJson, writeTmpJson } from "../../helpers/fs-helper.js"
import { callModel } from "../../helpers/model-helper.js"
import { isFinite, isFunction, isSafeInteger } from "../../helpers/utils.typed.js"
import { runNewsEnrichmentStep } from "../../step6-news-enrichment.js"
import { runTwitterEnrichmentStep, validateTwitterApiKey } from "../../step7-twitter-enrichment.js"
import { runContextEnrichmentStep } from "../../step8-context-enrichment.js"
import { runPatternEnrichmentStep } from "../../step8.1-pattern-enrichment.js"
import { enrichCandidatesWithNews } from "../step6-news-enrichment/enrich-candidates-with-news.js"
import { enrichCandidatesWithTwitter } from "../step7-twitter-enrichment/enrich-candidates-with-twitter.js"
import { enrichCandidatesWithContext } from "../step8-context-enrichment/enrich-candidates-with-context.js"
import { enrichCandidatesWithPatterns } from "../step8.1-pattern-enrichment/enrich-candidates-with-patterns.js"
import { preparePatternCandidates } from "../step8.1-pattern-enrichment/prepare-pattern-candidates.js"
import { createTwitterInput, mergePublicationEnrichment, validatePublicationOutput } from "./merge-publications.js"
import { validateContextResponse } from "./validate-context-response.js"

function getReferenceTimestamp () {
  const startedAt = Number(process.env.PIPELINE_STARTED_AT)
  return isSafeInteger(startedAt) && startedAt > 0 && isFinite(new Date(startedAt * 1_000).getTime())
    ? startedAt
    : Math.floor(Date.now() / 1_000)
}

export async function runCandidateEnrichment ({
  concurrency = 10,
  referenceTimestamp = getReferenceTimestamp(),
  readJson = readTmpJson,
  writeJson = writeTmpJson,
  removeJson = filename => fs.rm(path.join("tmp", filename), { force: true }),
  readPrompt = filename => fs.readFile(new URL(`../../prompts/${filename}`, import.meta.url), "utf8"),
  fetchNews = fetchTradingViewNews,
  fetchStory = fetchTradingViewNewsStory,
  fetchPage = fetchTweetPage,
  callAgent = callModel,
  preparePatterns = preparePatternCandidates,
  enrichNews = enrichCandidatesWithNews,
  enrichTwitter = enrichCandidatesWithTwitter,
  enrichContext = enrichCandidatesWithContext,
  enrichPatterns = enrichCandidatesWithPatterns,
} = {}) {
  const limiter = createConcurrencyLimiter(concurrency)
  if (concurrency > 10) {
    throw new Error("Candidate enrichment concurrency must not exceed 10")
  }
  if (!isSafeInteger(referenceTimestamp) || referenceTimestamp <= 0
    || !isFinite(new Date(referenceTimestamp * 1_000).getTime())) {
    throw new Error("Candidate enrichment referenceTimestamp must be a positive Unix timestamp")
  }
  if (![readJson, writeJson, removeJson, readPrompt, fetchNews, fetchStory, fetchPage,
    callAgent, preparePatterns, enrichNews, enrichTwitter, enrichContext, enrichPatterns].every(isFunction)) {
    throw new Error("Candidate enrichment dependencies must be functions")
  }
  if (enrichTwitter === enrichCandidatesWithTwitter && fetchPage === fetchTweetPage) {
    validateTwitterApiKey()
  }

  const shortlist = await readJson("step5-preliminary-filter.json")
  const twitterInput = createTwitterInput(shortlist)
  const activeCalls = new Set()
  let failed = false
  let failure

  function fail (error) {
    if (!failed) {
      failed = true
      failure = error
      limiter.cancel(error)
    }
  }

  function track (callback) {
    const pending = Promise.resolve().then(callback)
    activeCalls.add(pending)
    pending.then(() => activeCalls.delete(pending), () => activeCalls.delete(pending))
    return pending
  }

  function required (callback) {
    return async (...args) => {
      try {
        return await track(() => callback(...args))
      } catch (error) {
        fail(error)
        throw error
      }
    }
  }

  const write = required(writeJson)
  const newsTask = required(() => runNewsEnrichmentStep({
    readJson: async () => shortlist,
    writeJson: write,
    enrich: required(async (input) => {
      const output = await enrichNews(input, {
        referenceTimestamp,
        fetchNews: (...args) => track(() => fetchNews(...args)),
        fetchStory: (...args) => track(() => fetchStory(...args)),
      })
      validatePublicationOutput(shortlist, output, "news", referenceTimestamp)
      return output
    }),
  }))()
  const twitterTask = required(async () => {
    const output = await enrichTwitter(twitterInput, {
      referenceTimestamp,
      fetchPage: (...args) => track(() => fetchPage(...args)),
    })
    validatePublicationOutput(shortlist, output, "twitter", referenceTimestamp)
    return output
  })()
  const patternTask = required(() => runPatternEnrichmentStep({
    readJson: async () => shortlist,
    readPrompt: required(() => readPrompt("candidate-pattern-enrichment.md")),
    removeJson: required(removeJson),
    prepare: required(preparePatterns),
    enrich: required((input, prompt) => enrichPatterns(input, prompt, {
      callAgent: (...args) => limiter.run(() => track(() => callAgent(...args))),
      writeJson: write,
    })),
    writeJson: write,
  }))()
  const contextTask = required(async () => {
    const [news, rawTwitter] = await Promise.all([newsTask, twitterTask])
    if (failed) {
      throw failure
    }
    const twitter = await runTwitterEnrichmentStep({
      readJson: async () => news,
      enrich: () => mergePublicationEnrichment(shortlist, news, rawTwitter, referenceTimestamp),
      writeJson: write,
    })
    const context = await runContextEnrichmentStep({
      readJson: async () => twitter,
      readPrompt: required(() => readPrompt("candidate-context-enrichment.md")),
      enrich: required((input, prompt) => enrichContext(input, prompt, {
        callAgent: (...args) => limiter.run(required(async () => {
          const content = await callAgent(...args)
          validateContextResponse(content, args[1])
          return content
        })),
      })),
      writeJson: write,
    })
    return { news, twitter, context }
  })()

  const [, , patterns, publications] = await Promise.allSettled([newsTask, twitterTask, patternTask, contextTask])
  await limiter.drain()
  while (activeCalls.size > 0) {
    await Promise.allSettled([...activeCalls])
  }
  if (failed) {
    throw failure
  }
  return { ...publications.value, patterns: patterns.value }
}
