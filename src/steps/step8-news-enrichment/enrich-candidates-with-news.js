import { token_sort_ratio as getTitleSimilarity } from "fuzzball"
import { parallel } from "radash"

import { fetchTradingViewNewsStory } from "../../api/tradingview/news-story.js"
import { fetchTradingViewNews } from "../../api/tradingview/news.js"
import { getRequiredString } from "../../helpers/normalization-helper.js"
import {
  isArray,
  isError,
  isFunction,
  isInt,
  isObject,
  isSafeInteger,
  isString,
} from "../../helpers/utils.typed.js"

function getDefaultReferenceTimestamp () {
  const pipelineStartedAt = Number(process.env.PIPELINE_STARTED_AT)

  return isSafeInteger(pipelineStartedAt) && pipelineStartedAt > 0
    ? pipelineStartedAt
    : Math.floor(Date.now() / 1_000)
}

function getErrorMessage (error) {
  return isError(error) ? error.message : String(error)
}

function mergeStrings (...values) {
  return [...new Set(values
    .flat()
    .filter(value => isString(value) && value))]
    .sort()
}

function validateInput (shortlist) {
  if (!isObject(shortlist) || !isArray(shortlist.candidates)) {
    throw new Error("Step 5 candidates are required")
  }

  getRequiredString(shortlist.asOf, "Step 5 asOf")
  const symbols = new Set()

  return shortlist.candidates.map((candidate, index) => {
    const coin = candidate?.coin
    const symbol = getRequiredString(
      coin?.symbol,
      `Step 5 candidate ${index} symbol`,
    )

    if (symbols.has(symbol.toUpperCase())) {
      throw new Error(`Step 5 candidates contain duplicate symbol ${symbol}`)
    }

    symbols.add(symbol.toUpperCase())
    return {
      symbol,
      ...(isString(coin.name) && coin.name.trim() ? { name: coin.name.trim() } : {}),
      tradingViewSymbol: getRequiredString(
        coin.tradingViewSymbol,
        `Step 5 candidate ${symbol} tradingViewSymbol`,
      ),
    }
  })
}

function normalizeTitle (value) {
  return isString(value)
    ? value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim()
    : ""
}

function getTitleNumbers (title) {
  return [...new Set(title.match(/\d+(?:[.,]\d+)*/g) ?? [])].sort()
}

function haveDifferentTitleNumbers (firstTitle, secondTitle) {
  const firstNumbers = getTitleNumbers(firstTitle)
  const secondNumbers = getTitleNumbers(secondTitle)

  return firstNumbers.length > 0
    && secondNumbers.length > 0
    && (
      firstNumbers.length !== secondNumbers.length
      || firstNumbers.some((number, index) => number !== secondNumbers[index])
    )
}

function haveSameArticleUrl (first, second) {
  return ["tradingViewUrl", "externalUrl"].some(field => (
    isString(first[field])
    && first[field]
    && first[field] === second[field]
  ))
}

function haveSameArticleIdentity (first, second) {
  return first.id === second.id || haveSameArticleUrl(first, second)
}

function isSameNewsItem (first, second) {
  if (haveSameArticleIdentity(first, second)) {
    return true
  }

  const firstTitle = normalizeTitle(first.title)
  const secondTitle = normalizeTitle(second.title)

  if (!firstTitle || !secondTitle) {
    return false
  }

  return firstTitle === secondTitle || (
    !haveDifferentTitleNumbers(firstTitle, secondTitle)
    && getTitleSimilarity(firstTitle, secondTitle) >= 92
  )
}

function deduplicateNewsItems (items) {
  const uniqueItems = []

  for (const item of items) {
    if (!uniqueItems.some(uniqueItem => isSameNewsItem(uniqueItem, item))) {
      uniqueItems.push(item)
    }
  }

  return uniqueItems
}

function selectNewsItems (items, referenceTimestamp) {
  if (!isArray(items)) {
    throw new Error("TradingView news response does not contain an items array")
  }

  const recentItems = items
    .filter(item => (
      isInt(item?.published)
      && item.published >= referenceTimestamp - 24 * 60 * 60
      && item.published <= referenceTimestamp
    ))
    .sort((first, second) => (
      second.published - first.published
      || first.id.localeCompare(second.id)
    ))
  const uniqueItems = deduplicateNewsItems(recentItems)

  return {
    recentItemCount: recentItems.length,
    uniqueItemCount: uniqueItems.length,
    items: uniqueItems.slice(0, 3),
  }
}

async function fetchCandidateNews (
  coin,
  referenceTimestamp,
  fetchNews,
) {
  try {
    const { items } = await fetchNews({ symbol: coin.tradingViewSymbol })
    const selected = selectNewsItems(items, referenceTimestamp)

    return {
      symbol: coin.symbol,
      requestedSymbol: coin.tradingViewSymbol,
      ...selected,
      error: null,
    }
  } catch (error) {
    return {
      symbol: coin.symbol,
      requestedSymbol: coin.tradingViewSymbol,
      recentItemCount: null,
      uniqueItemCount: null,
      items: [],
      error: getErrorMessage(error),
    }
  }
}

function collectArticles (candidateNews) {
  const articles = []

  for (const result of candidateNews) {
    for (const item of result.items) {
      const existing = articles.find(article => (
        haveSameArticleIdentity(article.item, item)
      ))

      if (existing) {
        existing.item = {
          ...existing.item,
          matchedSymbols: mergeStrings(
            existing.item.matchedSymbols,
            item.matchedSymbols,
            result.requestedSymbol,
          ),
          relatedSymbols: mergeStrings(
            existing.item.relatedSymbols,
            item.relatedSymbols,
          ),
        }
        existing.ids.add(item.id)
        existing.matchedCandidates.add(result.symbol)
        continue
      }

      articles.push({
        item: {
          ...item,
          matchedSymbols: mergeStrings(
            item.matchedSymbols,
            result.requestedSymbol,
          ),
          relatedSymbols: mergeStrings(item.relatedSymbols),
        },
        ids: new Set([item.id]),
        matchedCandidates: new Set([result.symbol]),
      })
    }
  }

  return articles
}

function createUnavailableContent (contentError = null) {
  return {
    content: null,
    contentStatus: "unavailable",
    contentParserVersion: null,
    shortDescription: null,
    readTimeSeconds: null,
    copyright: null,
    unknownContentNodeTypes: [],
    contentError,
    contentFetchedAt: null,
  }
}

async function enrichArticle (article, fetchStory) {
  const item = {
    ...article.item,
    matchedCandidates: [...article.matchedCandidates],
  }

  if (!item.tradingViewUrl) {
    return {
      ...item,
      ...createUnavailableContent(),
    }
  }

  try {
    return {
      ...item,
      ...await fetchStory({
        id: item.id,
        url: item.tradingViewUrl,
      }),
    }
  } catch (error) {
    return {
      ...item,
      ...createUnavailableContent(getErrorMessage(error)),
    }
  }
}

export async function enrichCandidatesWithNews (
  shortlist,
  {
    fetchNews = fetchTradingViewNews,
    fetchStory = fetchTradingViewNewsStory,
    referenceTimestamp = getDefaultReferenceTimestamp(),
  } = {},
) {
  if (!isFunction(fetchNews) || !isFunction(fetchStory)) {
    throw new Error("News fetchers must be functions")
  }

  if (!isSafeInteger(referenceTimestamp) || referenceTimestamp <= 0) {
    throw new Error("News referenceTimestamp must be a positive Unix timestamp")
  }

  const candidates = validateInput(shortlist)
  const candidateNews = await parallel(5, candidates, candidate => (
    fetchCandidateNews(candidate, referenceTimestamp, fetchNews)
  ))
  const articles = collectArticles(candidateNews)
  const enrichedArticles = await parallel(5, articles, async article => ({
    ids: article.ids,
    item: await enrichArticle(article, fetchStory),
  }))
  const enrichedArticleById = new Map(enrichedArticles.flatMap(({ ids, item }) => (
    [...ids].map(id => [id, item])
  )))
  const newsBySymbol = new Map(
    candidateNews.map(result => [result.symbol, result]),
  )

  return {
    schemaVersion: 5,
    generatedAt: new Date().toISOString(),
    asOf: shortlist.asOf,
    newsEnrichment: {
      source: "tradingview",
      asOf: new Date(referenceTimestamp * 1_000).toISOString(),
      from: new Date((referenceTimestamp - 24 * 60 * 60) * 1_000).toISOString(),
      lookbackHours: 24,
      maxItemsPerCandidate: 3,
    },
    candidates: candidates.map(({ symbol, name }) => {
      const result = newsBySymbol.get(symbol)
      const items = result.items.map(item => enrichedArticleById.get(item.id))

      return {
        symbol,
        ...(name ? { name } : {}),
        news: {
          requestedSymbol: result.requestedSymbol,
          status: result.error
            ? "failed"
            : items.length > 0
              ? "available"
              : "empty",
          error: result.error,
          recentItemCount: result.recentItemCount,
          uniqueItemCount: result.uniqueItemCount,
          items,
        },
      }
    }),
  }
}
