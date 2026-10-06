import { callModel, getModelSettings } from "../../helpers/model-helper.js"
import { getRequiredString } from "../../helpers/normalization-helper.js"
import { isArray, isFunction, isObject, isString } from "../../helpers/utils.typed.js"
import {
  InvalidContextEnrichmentError,
  parseContextEnrichment,
} from "./parse-context-enrichment.js"

function validateInput (input) {
  if (!isObject(input) || !isArray(input.candidates)) {
    throw new Error("Step 9 enrichment candidates are required")
  }

  const asOf = getRequiredString(input.asOf, "Step 9 asOf")
  const symbols = new Set()
  const candidates = input.candidates.map((candidate, index) => {
    const symbol = getRequiredString(
      candidate?.symbol,
      `Step 9 enrichment candidate ${index} symbol`,
    )

    const normalizedSymbol = symbol.toUpperCase()

    if (symbols.has(normalizedSymbol)) {
      throw new Error(`Step 9 enrichment candidates contain duplicate symbol ${normalizedSymbol}`)
    }

    if (!isObject(candidate.news) || !isArray(candidate.news.items)) {
      throw new Error(`Step 9 enrichment candidate ${symbol} news are required`)
    }

    if (!isObject(candidate.twitter) || !isArray(candidate.twitter.tweets)) {
      throw new Error(`Step 9 enrichment candidate ${symbol} twitter data are required`)
    }

    for (const source of ["news", "twitter"]) {
      if (!["available", "empty", "failed"].includes(candidate[source].status)) {
        throw new Error(`Step 9 enrichment candidate ${symbol} ${source} status is invalid`)
      }
    }

    symbols.add(normalizedSymbol)
    return candidate
  })

  return { asOf, candidates }
}

function buildUserMessage (input, candidate) {
  return JSON.stringify({
    asOf: input.asOf,
    symbol: candidate.symbol,
    ...(candidate.name ? { name: candidate.name } : {}),
    newsEnrichment: input.newsEnrichment,
    twitterEnrichment: input.twitterEnrichment,
    news: candidate.news,
    twitter: candidate.twitter,
  })
}

async function enrichCandidate (
  input,
  candidate,
  systemPrompt,
  callAgent,
  modelSettings,
) {
  const identity = {
    symbol: candidate.symbol,
    ...(candidate.name ? { name: candidate.name } : {}),
    newsStatus: candidate.news.status,
    twitterStatus: candidate.twitter.status,
  }

  if (candidate.news.items.length === 0 && candidate.twitter.tweets.length === 0) {
    return {
      ...identity,
      newsSummary: null,
      twitterSummary: null,
      contextCaveat: [candidate.news.status, candidate.twitter.status].includes("failed")
        ? "Публикации недоступны: загрузка одного или обоих источников завершилась ошибкой."
        : "В доступной выборке за последние сутки публикаций нет.",
      socialSignificant: null,
      socialReason: null,
      socialSentiment: null,
    }
  }

  const content = await callAgent(
    systemPrompt,
    buildUserMessage(input, candidate),
    modelSettings,
  )
  let enrichment

  try {
    enrichment = parseContextEnrichment(content, candidate.symbol)

    for (const [field, publications] of [
      ["newsSummary", candidate.news.items],
      ["twitterSummary", candidate.twitter.tweets],
    ]) {
      if (publications.length === 0 && enrichment[field] !== null) {
        throw new InvalidContextEnrichmentError(`${field} must be null without source publications`)
      }
    }
  } catch (error) {
    if (error instanceof InvalidContextEnrichmentError) {
      error.symbol = candidate.symbol
      error.response = content
    }

    throw error
  }

  return {
    ...identity,
    newsSummary: enrichment.newsSummary,
    twitterSummary: enrichment.twitterSummary,
    contextCaveat: enrichment.contextCaveat,
    socialSignificant: enrichment.socialSignificant,
    socialReason: enrichment.socialReason,
    socialSentiment: enrichment.socialSentiment,
  }
}

export async function enrichCandidatesWithContext (
  input,
  systemPrompt,
  { callAgent = callModel } = {},
) {
  if (!isString(systemPrompt) || !systemPrompt.trim()) {
    throw new Error("Context enrichment system prompt is required")
  }

  if (!isFunction(callAgent)) {
    throw new Error("Context enrichment agent must be a function")
  }

  const { asOf, candidates } = validateInput(input)
  const modelSettings = getModelSettings("candidateContext")
  const enrichedCandidates = []

  for (const candidate of candidates) {
    enrichedCandidates.push(await enrichCandidate(
      input,
      candidate,
      systemPrompt,
      callAgent,
      modelSettings,
    ))
  }

  return {
    schemaVersion: 9,
    generatedAt: new Date().toISOString(),
    asOf,
    newsEnrichment: input.newsEnrichment,
    twitterEnrichment: input.twitterEnrichment,
    contextEnrichment: {
      source: `github-${modelSettings.provider}`,
      model: modelSettings.model,
      reasoningEffort: modelSettings.reasoningEffort,
      candidateCallCount: candidates.filter(candidate => (
        candidate.news.items.length > 0 || candidate.twitter.tweets.length > 0
      )).length,
    },
    candidates: enrichedCandidates,
  }
}
