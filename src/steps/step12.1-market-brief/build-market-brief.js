import { callModel, getModelSettings } from "../../helpers/model-helper.js"
import { isFinite, isString } from "../../helpers/utils.typed.js"
import { collectMarketSources } from "./collect-market-sources.js"
import { deduplicateMarketSources } from "./deduplicate-market-sources.js"
import { InvalidMarketBriefError, parseMarketBrief } from "./parse-market-brief.js"

function agentPayload (collection, groups) {
  const sources = new Map(collection.sources.map(source => [source.id, source]))
  return {
    from: collection.from,
    asOf: collection.asOf,
    coverage: collection.coverage,
    warnings: collection.warnings,
    groups: groups.map(({ id, title, text, sourceIds }) => {
      const texts = new Set([text])
      return {
        id, title, text,
        sources: sourceIds.map((sourceId) => {
          const { text: sourceText, ...source } = sources.get(sourceId)
          // Similar headlines can conceal corrections or different details. Keep those texts too.
          if (!texts.has(sourceText)) {
            texts.add(sourceText)
            return { ...source, text: sourceText }
          }
          return source
        }),
      }
    }),
  }
}

export async function buildMarketBrief (systemPrompt, {
  marketAsOf = null,
  referenceTimestamp = Math.floor(Date.now() / 1_000),
  collectSources = collectMarketSources,
  callAgent = callModel,
} = {}) {
  if (!isString(systemPrompt) || !systemPrompt.trim()) {
    throw new Error("Market brief system prompt is required")
  }
  if (marketAsOf !== null && (!isString(marketAsOf) || !isFinite(Date.parse(marketAsOf)))) {
    throw new Error("Market brief marketAsOf must be a timestamp or null")
  }
  const modelSettings = getModelSettings("marketBrief")
  const collection = await collectSources({ referenceTimestamp })
  const groups = deduplicateMarketSources(collection.sources)
  const incomplete = collection.coverage.some(source => ["partial", "failed"].includes(source.status))
  const failed = collection.coverage.some(source => source.status === "failed" || source.error)
  const output = {
    schemaVersion: 5,
    marketAsOf,
    ...collection,
    generatedAt: new Date().toISOString(),
    status: incomplete ? "partial" : "empty",
    warning: failed ? "Не все источники удалось загрузить." : null,
    items: [],
    analysis: {
      source: `github-${modelSettings.provider}`,
      model: modelSettings.model,
      reasoningEffort: modelSettings.reasoningEffort,
      callCount: 0,
      groupCount: groups.length,
      status: "skipped_no_sources",
      error: null,
    },
  }
  if (!groups.length) {
    if (failed) {
      output.status = "unavailable"
      output.warning = "Не получено достаточно доступных публикаций для сводки. Это не означает отсутствия важных событий."
    }
    return output
  }

  output.analysis.callCount = 1
  try {
    const response = await callAgent(systemPrompt, JSON.stringify(agentPayload(collection, groups)), modelSettings)
    const items = parseMarketBrief(response, collection.asOf, collection.sources)
    output.items = items
    output.status = incomplete ? "partial" : items.length ? "available" : "empty"
    output.analysis.status = "complete"
  } catch (error) {
    output.status = "unavailable"
    output.warning = "Не удалось сформировать сводку. Собранные источники сохранены; основной анализ не изменён."
    output.analysis.status = "failed"
    output.analysis.error = error instanceof InvalidMarketBriefError ? error.message : "Запрос к модели не выполнен"
  }
  output.generatedAt = new Date().toISOString()
  return output
}
