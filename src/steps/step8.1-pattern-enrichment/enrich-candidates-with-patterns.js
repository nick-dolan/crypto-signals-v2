import path from "node:path"

import { writeTmpJson } from "../../helpers/fs-helper.js"
import { callModel, getModelSettings } from "../../helpers/model-helper.js"
import { isArray, isError, isFunction, isString } from "../../helpers/utils.typed.js"
import { parsePatternEnrichment } from "./parse-pattern-enrichment.js"

async function enrichCandidate (input, candidate, systemPrompt, modelSettings, callAgent, writeJson) {
  let content
  let result
  if (!candidate.ready) {
    result = {
      symbol: candidate.symbol,
      status: "unavailable",
      summary: null,
      caveat: candidate.caveat || "Нет корректной свечи на рыночном срезе; график не анализировался.",
    }
  } else {
    try {
      content = await callAgent(systemPrompt, JSON.stringify({
        symbol: candidate.symbol,
        name: candidate.name,
        marketSymbol: candidate.marketSymbol,
        asOf: input.asOf,
        timeframe: input.timeframe,
        from: input.from,
        to: input.to,
        coverage: candidate.coverage,
        dataCaveat: candidate.caveat,
      }), {
        ...modelSettings,
        attachments: [{ type: "file", path: path.resolve(candidate.files.png), displayName: "chart.png" }],
      })
      const enrichment = parsePatternEnrichment(content, candidate.symbol)
      result = {
        symbol: candidate.symbol,
        status: enrichment.summary === null ? "unavailable" : "available",
        summary: enrichment.summary,
        caveat: [candidate.caveat, enrichment.caveat].filter(Boolean).join(" ") || null,
      }
    } catch (error) {
      result = {
        symbol: candidate.symbol,
        status: "unavailable",
        summary: null,
        caveat: `Анализ графика недоступен: ${isError(error) ? error.message : String(error)}`,
      }
      console.warn(`⚠ ${candidate.symbol}: ${result.caveat}`)
      if (content !== undefined) {
        await writeJson(path.join(input.directory, candidate.directory, "analysis.invalid.json"), {
          error: result.caveat, response: content,
        })
      }
    }
  }
  await writeJson(path.join(input.directory, candidate.directory, "analysis.json"), result)
  return result
}

export async function enrichCandidatesWithPatterns (input, systemPrompt, {
  callAgent = callModel,
  writeJson = writeTmpJson,
} = {}) {
  if (!isString(systemPrompt) || !systemPrompt.trim()) {
    throw new Error("Pattern enrichment system prompt is required")
  }
  if (!isArray(input?.candidates) || input.candidateCount !== input.candidates.length) {
    throw new Error("Prepared pattern candidates and matching candidateCount are required")
  }
  if (!isFunction(callAgent)) {
    throw new Error("Pattern enrichment agent must be a function")
  }
  const modelSettings = getModelSettings("candidatePattern")
  if (modelSettings.provider !== "copilot-sdk") {
    throw new Error("Pattern image analysis requires copilot-sdk attachments")
  }
  const candidates = []
  for (const candidate of input.candidates) {
    candidates.push(await enrichCandidate(input, candidate, systemPrompt, modelSettings, callAgent, writeJson))
  }
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    asOf: input.asOf,
    timeframe: input.timeframe,
    candidateCount: candidates.length,
    patternEnrichment: {
      source: `github-${modelSettings.provider}`,
      model: modelSettings.model,
      reasoningEffort: modelSettings.reasoningEffort,
      lookbackHours: 168,
      from: input.from,
      to: input.to,
      candidateCallCount: input.candidates.filter(candidate => candidate.ready).length,
    },
    candidates,
  }
}
