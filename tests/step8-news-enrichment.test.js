import assert from "node:assert/strict"
import test from "node:test"

import { enrichTopCandidatesWithNews } from "../src/steps/step8-news-enrichment/enrich-top-candidates-with-news.js"

function createAnalysis () {
  return {
    schemaVersion: 1,
    asOf: "2027-01-15T08:00:00.000Z",
    topCandidates: [
      {
        symbol: "SUSHI",
        movementProbability: 0.7,
        explanation: "SUSHI explanation",
      },
      {
        symbol: "BTC",
        movementProbability: 0.6,
        explanation: "BTC explanation",
      },
    ],
    assessments: [
      { symbol: "SUSHI" },
      { symbol: "BTC" },
    ],
  }
}

function createShortlist () {
  return {
    asOf: "2027-01-15T08:00:00.000Z",
    candidates: [
      {
        coin: {
          symbol: "SUSHI",
          baseCurrencyId: "XTVCSUSHI",
          tradingViewSymbol: "CRYPTO:SUSHIUSD",
          marketSymbol: "BINANCE:SUSHIUSDT.P",
        },
      },
      {
        coin: {
          symbol: "BTC",
          baseCurrencyId: "XTVCBTC",
          tradingViewSymbol: "CRYPTO:BTCUSD",
          marketSymbol: "BINANCE:BTCUSDT.P",
        },
      },
    ],
  }
}

function createNewsItem ({
  id,
  published,
  requestedSymbol,
  relatedSymbols = [],
  tradingViewUrl = `https://www.tradingview.com/news/${id}/`,
}) {
  return {
    id,
    title: `Title ${id}`,
    published,
    publishedAt: new Date(published * 1_000).toISOString(),
    provider: {
      id: "provider",
      name: "Provider",
      url: "https://provider.example",
    },
    externalUrl: `https://provider.example/${id}`,
    tradingViewUrl,
    paywall: false,
    permission: "free",
    urgency: 1,
    matchedSymbols: [requestedSymbol],
    relatedSymbols,
  }
}

function createStory (id) {
  return {
    content: `Content ${id}`,
    contentStatus: "full",
    contentParserVersion: 1,
    shortDescription: `Preview ${id}`,
    readTimeSeconds: 60,
    copyright: "Provider",
    unknownContentNodeTypes: [],
    contentError: null,
    contentFetchedAt: "2027-01-15T08:01:00.000Z",
  }
}

test("enriches candidates through CRYPTO symbols and fetches each story once", async () => {
  const referenceTimestamp = 1_800_000_000
  const newsCalls = []
  const storyCalls = []
  const sharedId = "provider:shared:0"
  const result = await enrichTopCandidatesWithNews(
    createAnalysis(),
    createShortlist(),
    {
      referenceTimestamp,
      fetchNews: async ({ symbol }) => {
        newsCalls.push(symbol)

        if (symbol === "CRYPTO:SUSHIUSD") {
          return {
            items: [
              createNewsItem({
                id: sharedId,
                published: referenceTimestamp - 60,
                requestedSymbol: symbol,
                relatedSymbols: ["NASDAQ:COIN"],
              }),
              createNewsItem({
                id: "provider:sushi:0",
                published: referenceTimestamp - 120,
                requestedSymbol: symbol,
              }),
              createNewsItem({
                id: "provider:future:0",
                published: referenceTimestamp + 1,
                requestedSymbol: symbol,
              }),
              createNewsItem({
                id: "provider:old:0",
                published: referenceTimestamp - 24 * 60 * 60 - 1,
                requestedSymbol: symbol,
              }),
            ],
          }
        }

        return {
          items: [
            createNewsItem({
              id: sharedId,
              published: referenceTimestamp - 60,
              requestedSymbol: symbol,
              relatedSymbols: ["COINBASE:BTCUSD"],
            }),
            createNewsItem({
              id: "provider:btc:0",
              published: referenceTimestamp - 180,
              requestedSymbol: symbol,
              tradingViewUrl: null,
            }),
          ],
        }
      },
      fetchStory: async ({ id, url }) => {
        storyCalls.push({ id, url })
        return createStory(id)
      },
    },
  )

  assert.deepEqual(newsCalls, ["CRYPTO:SUSHIUSD", "CRYPTO:BTCUSD"])
  assert.deepEqual(
    storyCalls.map(call => call.id),
    [sharedId, "provider:sushi:0"],
  )
  assert.equal(result.schemaVersion, 2)
  assert.equal(result.asOf, "2027-01-15T08:00:00.000Z")
  assert.ok(!Number.isNaN(Date.parse(result.generatedAt)))
  assert.deepEqual(result.newsEnrichment, {
    source: "tradingview",
    asOf: new Date(referenceTimestamp * 1_000).toISOString(),
    from: new Date((referenceTimestamp - 24 * 60 * 60) * 1_000).toISOString(),
    lookbackHours: 24,
    maxItemsPerCandidate: 5,
  })
  assert.deepEqual(result.assessments, createAnalysis().assessments)

  const [sushi, btc] = result.topCandidates

  assert.equal(sushi.news.requestedSymbol, "CRYPTO:SUSHIUSD")
  assert.equal(sushi.news.status, "available")
  assert.equal(sushi.news.error, null)
  assert.deepEqual(
    sushi.news.items.map(item => item.id),
    [sharedId, "provider:sushi:0"],
  )
  assert.deepEqual(
    btc.news.items.map(item => item.id),
    [sharedId, "provider:btc:0"],
  )

  const shared = sushi.news.items[0]

  assert.deepEqual(shared.matchedCandidates, ["SUSHI", "BTC"])
  assert.deepEqual(shared.matchedSymbols, ["CRYPTO:BTCUSD", "CRYPTO:SUSHIUSD"])
  assert.deepEqual(shared.relatedSymbols, ["COINBASE:BTCUSD", "NASDAQ:COIN"])
  assert.equal(shared.content, `Content ${sharedId}`)
  assert.deepEqual(btc.news.items[0], shared)
  assert.equal(btc.news.items[1].contentStatus, "unavailable")
  assert.equal(btc.news.items[1].contentError, null)
  assert.equal(btc.news.items[1].contentFetchedAt, null)
})

test("limits news and keeps candidate and story failures in the output", async () => {
  const referenceTimestamp = 1_800_000_000
  const storyCalls = []
  const result = await enrichTopCandidatesWithNews(
    createAnalysis(),
    createShortlist(),
    {
      referenceTimestamp,
      fetchNews: async ({ symbol }) => {
        if (symbol === "CRYPTO:SUSHIUSD") {
          throw new Error("News request failed")
        }

        return {
          items: Array.from({ length: 7 }, (_, index) => createNewsItem({
            id: `provider:btc:${index}`,
            published: referenceTimestamp - (index + 1) * 60,
            requestedSymbol: symbol,
          })).reverse(),
        }
      },
      fetchStory: async ({ id }) => {
        storyCalls.push(id)

        if (id === "provider:btc:2") {
          throw new Error("Story request failed")
        }

        return createStory(id)
      },
    },
  )
  const [sushi, btc] = result.topCandidates

  assert.deepEqual(sushi.news, {
    requestedSymbol: "CRYPTO:SUSHIUSD",
    status: "failed",
    error: "News request failed",
    items: [],
  })
  assert.equal(btc.news.status, "available")
  assert.deepEqual(
    btc.news.items.map(item => item.id),
    Array.from({ length: 5 }, (_, index) => `provider:btc:${index}`),
  )
  assert.equal(storyCalls.length, 5)

  const failedStory = btc.news.items.find(item => item.id === "provider:btc:2")

  assert.equal(failedStory.contentStatus, "unavailable")
  assert.equal(failedStory.contentError, "Story request failed")
})

test("requires matching step snapshots and TradingView coin symbols", async () => {
  const shortlist = createShortlist()

  shortlist.asOf = "2027-01-15T07:00:00.000Z"

  await assert.rejects(
    enrichTopCandidatesWithNews(createAnalysis(), shortlist),
    /different market snapshots/,
  )

  const incompleteShortlist = createShortlist()

  delete incompleteShortlist.candidates[0].coin.tradingViewSymbol

  await assert.rejects(
    enrichTopCandidatesWithNews(createAnalysis(), incompleteShortlist),
    /tradingViewSymbol is required/,
  )
})
