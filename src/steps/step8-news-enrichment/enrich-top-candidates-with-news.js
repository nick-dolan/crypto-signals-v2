import { token_sort_ratio as getTitleSimilarity } from "fuzzball"

import { fetchTradingViewNewsStory } from "../../api/tradingview/news-story.js"
import { fetchTradingViewNews } from "../../api/tradingview/news.js"
import { getRequiredString } from "../../helpers/normalization-helper.js"

function isObject (value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function getDefaultReferenceTimestamp () {
  const pipelineStartedAt = Number(process.env.PIPELINE_STARTED_AT)

  return Number.isSafeInteger(pipelineStartedAt) && pipelineStartedAt > 0
    ? pipelineStartedAt
    : Math.floor(Date.now() / 1_000)
}

function getErrorMessage (error) {
  return error instanceof Error ? error.message : String(error)
}

function mergeStrings (...values) {
  return [...new Set(values
    .flat()
    .filter(value => typeof value === "string" && value))]
    .sort()
}

function validateInputs (analysis, shortlist) {
  if (!isObject(analysis) || !Array.isArray(analysis.topCandidates)) {
    throw new Error("Step 7 top candidates are required")
  }

  if (!isObject(shortlist) || !Array.isArray(shortlist.candidates)) {
    throw new Error("Step 5 candidates are required")
  }

  const analysisAsOf = getRequiredString(analysis.asOf, "Step 7 asOf")
  const shortlistAsOf = getRequiredString(shortlist.asOf, "Step 5 asOf")

  if (analysisAsOf !== shortlistAsOf) {
    throw new Error("Step 5 and step 7 use different market snapshots")
  }

  const coinBySymbol = new Map()

  shortlist.candidates.forEach((candidate, index) => {
    const coin = candidate?.coin
    const symbol = getRequiredString(
      coin?.symbol,
      `Step 5 candidate ${index} symbol`,
    )

    if (coinBySymbol.has(symbol)) {
      throw new Error(`Step 5 candidates contain duplicate symbol ${symbol}`)
    }

    coinBySymbol.set(symbol, {
      baseCurrencyId: getRequiredString(
        coin.baseCurrencyId,
        `Step 5 candidate ${symbol} baseCurrencyId`,
      ),
      tradingViewSymbol: getRequiredString(
        coin.tradingViewSymbol,
        `Step 5 candidate ${symbol} tradingViewSymbol`,
      ),
    })
  })

  const topSymbols = new Set()

  return analysis.topCandidates.map((candidate, index) => {
    const symbol = getRequiredString(
      candidate?.symbol,
      `Step 7 top candidate ${index} symbol`,
    )
    const coin = coinBySymbol.get(symbol)

    if (topSymbols.has(symbol)) {
      throw new Error(`Step 7 top candidates contain duplicate symbol ${symbol}`)
    }

    if (!coin) {
      throw new Error(`Step 7 top candidate ${symbol} is missing from step 5`)
    }

    topSymbols.add(symbol)
    return { candidate, coin }
  })
}

function normalizeTitle (value) {
  return typeof value === "string"
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
    typeof first[field] === "string"
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
  if (!Array.isArray(items)) {
    throw new Error("TradingView news response does not contain an items array")
  }

  const recentItems = items
    .filter(item => (
      Number.isInteger(item?.published)
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
  { candidate, coin },
  referenceTimestamp,
  fetchNews,
) {
  try {
    const { items } = await fetchNews({ symbol: coin.tradingViewSymbol })
    const selected = selectNewsItems(items, referenceTimestamp)

    return {
      baseCurrencyId: coin.baseCurrencyId,
      symbol: candidate.symbol,
      requestedSymbol: coin.tradingViewSymbol,
      ...selected,
      error: null,
    }
  } catch (error) {
    return {
      baseCurrencyId: coin.baseCurrencyId,
      symbol: candidate.symbol,
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

export async function enrichTopCandidatesWithNews (
  analysis,
  shortlist,
  {
    fetchNews = fetchTradingViewNews,
    fetchStory = fetchTradingViewNewsStory,
    referenceTimestamp = getDefaultReferenceTimestamp(),
  } = {},
) {
  if (typeof fetchNews !== "function" || typeof fetchStory !== "function") {
    throw new Error("News fetchers must be functions")
  }

  if (!Number.isSafeInteger(referenceTimestamp) || referenceTimestamp <= 0) {
    throw new Error("News referenceTimestamp must be a positive Unix timestamp")
  }

  const topCandidates = validateInputs(analysis, shortlist)
  const candidateNews = await Promise.all(topCandidates.map(candidate => (
    fetchCandidateNews(candidate, referenceTimestamp, fetchNews)
  )))
  const articles = collectArticles(candidateNews)
  const enrichedArticles = await Promise.all(articles.map(async article => ({
    ids: article.ids,
    item: await enrichArticle(article, fetchStory),
  })))
  const enrichedArticleById = new Map(enrichedArticles.flatMap(({ ids, item }) => (
    [...ids].map(id => [id, item])
  )))
  const candidateNewsById = new Map(
    candidateNews.map(result => [result.baseCurrencyId, result]),
  )

  return {
    schemaVersion: 2,
    generatedAt: new Date().toISOString(),
    asOf: analysis.asOf,
    newsEnrichment: {
      source: "tradingview",
      asOf: new Date(referenceTimestamp * 1_000).toISOString(),
      from: new Date((referenceTimestamp - 24 * 60 * 60) * 1_000).toISOString(),
      lookbackHours: 24,
      maxItemsPerCandidate: 3,
    },
    topCandidates: topCandidates.map(({ candidate, coin }) => {
      const result = candidateNewsById.get(coin.baseCurrencyId)
      const items = result.items.map(item => enrichedArticleById.get(item.id))

      return {
        ...candidate,
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
    assessments: analysis.assessments,
  }
}
