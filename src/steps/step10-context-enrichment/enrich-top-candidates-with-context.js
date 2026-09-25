import { omit } from "radash"
import { callUnofficialCopilot } from "../../api/copilot-unofficial/chat.js"
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

    if (!isString(candidate.explanation)) {
      throw new Error(`Step 9 enrichment candidate ${symbol} explanation must be a string`)
    }

    const explanation = candidate.explanation.trim()
    const normalizedSymbol = symbol.toUpperCase()

    if (symbols.has(normalizedSymbol)) {
      throw new Error(`Step 9 enrichment candidates contain duplicate symbol ${normalizedSymbol}`)
    }

    if (!isObject(candidate.news)) {
      throw new Error(`Step 9 enrichment candidate ${symbol} news are required`)
    }

    if (!isObject(candidate.twitter)) {
      throw new Error(`Step 9 enrichment candidate ${symbol} twitter data are required`)
    }

    symbols.add(normalizedSymbol)
    return { candidate, explanation, symbol }
  })

  return { asOf, candidates }
}

function buildUserMessage (asOf, { candidate, explanation, symbol }) {
  return JSON.stringify({
    asOf,
    symbol,
    explanation,
    ...(!explanation ? { drivers: candidate.drivers, counterSignals: candidate.counterSignals } : {}),
    news: candidate.news,
    twitter: candidate.twitter,
  })
}

async function enrichCandidate (
  asOf,
  candidate,
  systemPrompt,
  callAgent,
) {
  const content = await callAgent(
    systemPrompt,
    buildUserMessage(asOf, candidate),
    {
      model: "gemini-3.7-flash",
      reasoningEffort: "medium",
    },
  )
  let enrichment

  try {
    enrichment = parseContextEnrichment(content, candidate.symbol)
  } catch (error) {
    if (error instanceof InvalidContextEnrichmentError) {
      error.symbol = candidate.symbol
      error.response = content
    }

    throw error
  }

  return {
    ...omit(candidate.candidate, ["news", "twitter"]),
    enrichedExplanation: [candidate.explanation, enrichment.informationBackground].filter(Boolean).join(" "),
  }
}

export async function enrichTopCandidatesWithContext (
  input,
  systemPrompt,
  { callAgent = callUnofficialCopilot } = {},
) {
  if (!isString(systemPrompt) || !systemPrompt.trim()) {
    throw new Error("Context enrichment system prompt is required")
  }

  if (!isFunction(callAgent)) {
    throw new Error("Context enrichment agent must be a function")
  }

  const { asOf, candidates } = validateInput(input)
  const enrichedCandidates = []

  for (const candidate of candidates) {
    enrichedCandidates.push(await enrichCandidate(
      asOf,
      candidate,
      systemPrompt,
      callAgent,
    ))
  }

  return {
    ...input,
    schemaVersion: 6,
    generatedAt: new Date().toISOString(),
    contextEnrichment: {
      source: "github-copilot-unofficial",
      model: "gemini-3.7-flash",
      reasoningEffort: "medium",
      candidateCallCount: enrichedCandidates.length,
    },
    candidates: enrichedCandidates,
  }
}
