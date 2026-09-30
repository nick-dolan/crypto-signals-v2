import { readTmpJson } from "../../helpers/fs-helper.js"
import { isArray, isFinite, isObject, isSafeInteger, isString } from "../../helpers/utils.typed.js"
import { validateBriefEvents, validateBriefParagraphs } from "../step12.1-market-brief/parse-market-brief.js"
import { normalizeSourceUrl } from "../step12.1-market-brief/source-normalization.js"

function isTimestamp (value) {
  return isString(value) && isFinite(Date.parse(value))
}

function validBrief (data) {
  if (!isObject(data) || ![1, 2].includes(data.schemaVersion)) {
    return false
  }
  const channels = data.schemaVersion === 1 ? ["tavily", "tradingview", "twitter"] : ["tradingview", "twitter"]
  if (
    !["available", "partial", "empty", "unavailable"].includes(data.status)
    || ![data.marketAsOf, data.asOf, data.from, data.generatedAt].every(isTimestamp)
    || Date.parse(data.asOf) - Date.parse(data.from) !== (data.schemaVersion === 1 ? 24 : 6) * 60 * 60 * 1_000
    || Date.parse(data.asOf) < Date.parse(data.marketAsOf) + 3_600_000
    || (data.warning !== null && !isString(data.warning))
    || !isArray(data.sources) || !isArray(data.coverage) || data.coverage.length !== channels.length
    || !channels.every(channel => data.coverage.some(item => item?.source === channel))
    || !isObject(data.analysis) || data.analysis.model !== "gemini-3.7-flash"
  ) {
    return false
  }
  const ids = new Set()
  for (const source of data.sources) {
    if (
      !isString(source?.id) || !source.id || ids.has(source.id)
      || !channels.includes(source.channel)
      || ![source.title, source.text].every(value => isString(value) && value.trim())
      || (source.author !== null && !isString(source.author))
      || !normalizeSourceUrl(source.url) || !isTimestamp(source.publishedAt)
      || Date.parse(source.publishedAt) < Date.parse(data.from)
      || Date.parse(source.publishedAt) > Date.parse(data.asOf)
    ) {
      return false
    }
    ids.add(source.id)
  }
  if (!data.coverage.every(item => (
    ["available", "empty", "partial", "failed"].includes(item.status)
    && isSafeInteger(item.fetchedCount) && item.fetchedCount >= 0
    && item.fetchedCount === data.sources.filter(source => source.channel === item.source).length
    && (item.error === null || isString(item.error))
    && (!["empty", "failed"].includes(item.status) || item.fetchedCount === 0)
  ))) {
    return false
  }
  const content = data.schemaVersion === 1
    ? validateBriefEvents(data.events, data.sources)
    : validateBriefParagraphs(data.paragraphs, data.sources)
  const incomplete = data.coverage.some(item => ["partial", "failed"].includes(item.status))
  return (data.status !== "available" || (content.length > 0 && !incomplete))
    && (data.status !== "empty" || (!content.length && !incomplete))
    && (data.status !== "unavailable" || !content.length)
    && (data.status !== "partial" || incomplete)
    && (!content.length || data.analysis.status === "complete")
}

function unavailable (marketAsOf, warning) {
  return {
    schemaVersion: 2, marketAsOf, asOf: null, from: null, generatedAt: null,
    status: "unavailable", warning, coverage: [], sources: [], paragraphs: [],
  }
}

export async function readMarketBriefReport (marketAsOf, { readJson = readTmpJson } = {}) {
  let data
  try {
    data = await readJson("step12.1-market-brief.json")
  } catch (error) {
    return unavailable(marketAsOf, error.code === "ENOENT"
      ? "Сводка событий не подготовлена. Запустите шаг 12.1 и повторите шаг 13."
      : "Не удалось прочитать сводку событий. Основной отчёт доступен без неё.")
  }
  try {
    if (!validBrief(data)) {
      return unavailable(marketAsOf, "Некорректный результат шага 12.1. Повторите сбор сводки; основной отчёт сохранён.")
    }
    if (data.marketAsOf !== marketAsOf) {
      return unavailable(marketAsOf, "Сводка событий относится к другому запуску анализа. Повторите шаг 12.1; старая сводка не показана.")
    }
    return data
  } catch {
    return unavailable(marketAsOf, "Некорректный результат шага 12.1. Повторите сбор сводки; основной отчёт сохранён.")
  }
}
