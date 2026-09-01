import { getRequiredString } from "../../helpers/normalization-helper.js"
import { requestTradingViewJson } from "./request.js"

function getOptionalString (value) {
  if (typeof value !== "string") {
    return null
  }

  return value.trim() || null
}

function createNewsRequestUrl ({ symbol, language, client }) {
  const url = new URL("https://news-mediator.tradingview.com/public/view/v1/symbol")

  url.searchParams.append("filter", `lang:${language}`)
  url.searchParams.append("filter", `symbol:${symbol}`)
  url.searchParams.set("client", client)
  url.searchParams.set("streaming", "false")

  return url
}

function getItemError (index, message) {
  return new Error(`TradingView news item at index ${index}: ${message}`)
}

function normalizeProvider (provider, index) {
  if (!provider || typeof provider !== "object" || Array.isArray(provider)) {
    throw getItemError(index, "provider is missing")
  }

  let id
  let name

  try {
    id = getRequiredString(provider.id, "provider.id")
    name = getRequiredString(provider.name, "provider.name")
  } catch (error) {
    throw getItemError(index, error.message)
  }

  return {
    id,
    name,
    url: getOptionalString(provider.url),
  }
}

function normalizeRelatedSymbols (relatedSymbols) {
  if (!Array.isArray(relatedSymbols)) {
    return []
  }

  return [...new Set(
    relatedSymbols
      .map(item => getOptionalString(item?.symbol))
      .filter(Boolean),
  )].sort()
}

function createTradingViewUrl (storyPath, index) {
  if (!storyPath) {
    return null
  }

  try {
    return new URL(storyPath, "https://www.tradingview.com").toString()
  } catch {
    throw getItemError(index, "storyPath is invalid")
  }
}

function normalizeNewsItem (item, requestedSymbol, index) {
  if (!item || typeof item !== "object" || Array.isArray(item)) {
    throw getItemError(index, "expected an object")
  }

  let id
  let title

  try {
    id = getRequiredString(item.id, "id")
    title = getRequiredString(item.title, "title")
  } catch (error) {
    throw getItemError(index, error.message)
  }

  if (!Number.isInteger(item.published) || item.published <= 0) {
    throw getItemError(index, "published must be a positive Unix timestamp")
  }

  if (!Number.isFinite(item.urgency)) {
    throw getItemError(index, "urgency must be a finite number")
  }

  if (typeof item.paywall !== "boolean") {
    throw getItemError(index, "paywall must be a boolean")
  }

  const storyPath = getOptionalString(item.storyPath)

  return {
    id,
    title,
    published: item.published,
    publishedAt: new Date(item.published * 1000).toISOString(),
    provider: normalizeProvider(item.provider, index),
    externalUrl: getOptionalString(item.link),
    tradingViewUrl: createTradingViewUrl(storyPath, index),
    paywall: item.paywall,
    permission: getOptionalString(item.permission),
    urgency: item.urgency,
    matchedSymbols: [requestedSymbol],
    relatedSymbols: normalizeRelatedSymbols(item.relatedSymbols),
  }
}

export async function fetchTradingViewNews ({
  symbol,
  language = "en",
  client = "web",
  timeoutMs = 15_000,
} = {}) {
  const normalizedSymbol = getRequiredString(symbol, "symbol")
  const normalizedLanguage = getRequiredString(language, "language")
  const normalizedClient = getRequiredString(client, "client")
  const url = createNewsRequestUrl({
    symbol: normalizedSymbol,
    language: normalizedLanguage,
    client: normalizedClient,
  })
  const payload = await requestTradingViewJson(url, {
    label: "TradingView news",
    timeoutMs,
  })

  if (!payload || typeof payload !== "object" || !Array.isArray(payload.items)) {
    throw new Error("TradingView news response does not contain an items array")
  }

  return {
    items: payload.items.map((item, index) => (
      normalizeNewsItem(item, normalizedSymbol, index)
    )),
    sections: Array.isArray(payload.sections) ? payload.sections : [],
  }
}
