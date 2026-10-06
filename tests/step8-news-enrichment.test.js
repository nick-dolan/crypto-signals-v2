import assert from "node:assert/strict"
import test from "node:test"

import { isNaN } from "../src/helpers/utils.typed.js"
import { enrichCandidatesWithNews } from "../src/steps/step8-news-enrichment/enrich-candidates-with-news.js"

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
  title = `Title ${id}`,
  published,
  requestedSymbol,
  externalUrl = `https://provider.example/${id}`,
  relatedSymbols = [],
  tradingViewUrl = `https://www.tradingview.com/news/${id}/`,
}) {
  return {
    id,
    title,
    published,
    publishedAt: new Date(published * 1_000).toISOString(),
    provider: {
      id: "provider",
      name: "Provider",
      url: "https://provider.example",
    },
    externalUrl,
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
  const result = await enrichCandidatesWithNews(
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

  assert.deepEqual(newsCalls.sort(), ["CRYPTO:BTCUSD", "CRYPTO:SUSHIUSD"])
  assert.deepEqual(
    storyCalls.map(call => call.id).sort(),
    [sharedId, "provider:sushi:0"].sort(),
  )
  assert.equal(result.schemaVersion, 5)
  assert.equal(result.asOf, "2027-01-15T08:00:00.000Z")
  assert.ok(!isNaN(Date.parse(result.generatedAt)))
  assert.deepEqual(result.newsEnrichment, {
    source: "tradingview",
    asOf: new Date(referenceTimestamp * 1_000).toISOString(),
    from: new Date((referenceTimestamp - 24 * 60 * 60) * 1_000).toISOString(),
    lookbackHours: 24,
    maxItemsPerCandidate: 3,
  })
  assert.ok(!Object.hasOwn(result, "assessments"))

  const [sushi, btc] = result.candidates

  assert.equal(sushi.news.requestedSymbol, "CRYPTO:SUSHIUSD")
  assert.equal(sushi.news.status, "available")
  assert.equal(sushi.news.error, null)
  assert.equal(sushi.news.recentItemCount, 2)
  assert.equal(sushi.news.uniqueItemCount, 2)
  assert.equal(btc.news.recentItemCount, 2)
  assert.equal(btc.news.uniqueItemCount, 2)
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

test("deduplicates all recent news before keeping the latest three", async () => {
  const referenceTimestamp = 1_800_000_000
  const storyCalls = []
  const result = await enrichCandidatesWithNews(
    createShortlist(),
    {
      referenceTimestamp,
      fetchNews: async ({ symbol }) => {
        if (symbol === "CRYPTO:SUSHIUSD") {
          throw new Error("News request failed")
        }

        return {
          items: [
            createNewsItem({
              id: "provider:btc:0",
              title: "Bitcoin jumps after Federal Reserve decision",
              published: referenceTimestamp - 60,
              requestedSymbol: symbol,
            }),
            createNewsItem({
              id: "copy:btc:0",
              title: "Bitcoin jumps after the Federal Reserve decision",
              published: referenceTimestamp - 90,
              requestedSymbol: symbol,
            }),
            createNewsItem({
              id: "provider:btc:2",
              title: "Bitcoin climbs 5% after Fed decision",
              published: referenceTimestamp - 120,
              requestedSymbol: symbol,
            }),
            createNewsItem({
              id: "provider:btc:3",
              title: "Bitcoin climbs 6% after Fed decision",
              published: referenceTimestamp - 180,
              requestedSymbol: symbol,
            }),
            createNewsItem({
              id: "provider:btc:4",
              title: "ETF inflows accelerate during US session",
              published: referenceTimestamp - 240,
              requestedSymbol: symbol,
            }),
            createNewsItem({
              id: "provider:btc:5",
              title: "Bitcoin whales increase exchange deposits",
              published: referenceTimestamp - 300,
              requestedSymbol: symbol,
            }),
            createNewsItem({
              id: "provider:btc:6",
              title: "Options traders prepare for monthly expiry",
              published: referenceTimestamp - 360,
              requestedSymbol: symbol,
            }),
          ].reverse(),
        }
      },
      fetchStory: async ({ id }) => {
        storyCalls.push(id)

        if (id === "provider:btc:3") {
          throw new Error("Story request failed")
        }

        return createStory(id)
      },
    },
  )
  const [sushi, btc] = result.candidates

  assert.deepEqual(sushi.news, {
    requestedSymbol: "CRYPTO:SUSHIUSD",
    status: "failed",
    error: "News request failed",
    recentItemCount: null,
    uniqueItemCount: null,
    items: [],
  })
  assert.equal(btc.news.status, "available")
  assert.equal(btc.news.recentItemCount, 7)
  assert.equal(btc.news.uniqueItemCount, 6)
  assert.deepEqual(
    btc.news.items.map(item => item.id),
    ["provider:btc:0", "provider:btc:2", "provider:btc:3"],
  )
  assert.deepEqual(
    storyCalls.sort(),
    ["provider:btc:0", "provider:btc:2", "provider:btc:3"],
  )

  const failedStory = btc.news.items.find(item => item.id === "provider:btc:3")

  assert.equal(failedStory.contentStatus, "unavailable")
  assert.equal(failedStory.contentError, "Story request failed")
})

test("keeps an explicit empty result without falling back to old news", async () => {
  const referenceTimestamp = 1_800_000_000
  let storyCallCount = 0
  const result = await enrichCandidatesWithNews(
    createShortlist(),
    {
      referenceTimestamp,
      fetchNews: async ({ symbol }) => ({
        items: [
          createNewsItem({
            id: `provider:${symbol}:old`,
            published: referenceTimestamp - 24 * 60 * 60 - 1,
            requestedSymbol: symbol,
          }),
          createNewsItem({
            id: `provider:${symbol}:future`,
            published: referenceTimestamp + 1,
            requestedSymbol: symbol,
          }),
        ],
      }),
      fetchStory: async () => {
        storyCallCount += 1
        return createStory("unexpected")
      },
    },
  )

  for (const candidate of result.candidates) {
    assert.equal(candidate.news.status, "empty")
    assert.equal(candidate.news.error, null)
    assert.equal(candidate.news.recentItemCount, 0)
    assert.equal(candidate.news.uniqueItemCount, 0)
    assert.deepEqual(candidate.news.items, [])
  }

  assert.equal(storyCallCount, 0)
})

test("enriches all 50 preliminary candidates with bounded requests and no analysis fields", async () => {
  const shortlist = createShortlist()
  shortlist.candidates = Array.from({ length: 50 }, (_, index) => ({ coin: {
    symbol: `COIN${index}`,
    name: `Project ${index}`,
    tradingViewSymbol: `CRYPTO:COIN${index}USD`,
  } }))
  const before = structuredClone(shortlist)
  const active = { news: 0, story: 0 }
  const maximum = { news: 0, story: 0 }
  async function recordCall (kind, output) {
    active[kind] += 1
    maximum[kind] = Math.max(maximum[kind], active[kind])
    await new Promise(resolve => setImmediate(resolve))
    active[kind] -= 1
    return output
  }
  const result = await enrichCandidatesWithNews(shortlist, {
    referenceTimestamp: 1_800_000_000,
    fetchNews: async ({ symbol }) => recordCall("news", { items: [createNewsItem({
      id: symbol, published: 1_800_000_000, requestedSymbol: symbol,
    })] }),
    fetchStory: async ({ id }) => recordCall("story", createStory(id)),
  })

  assert.deepEqual(maximum, { news: 5, story: 5 })
  assert.equal(result.candidates.length, 50)
  assert.deepEqual(result.candidates.map(candidate => candidate.symbol), shortlist.candidates.map(({ coin }) => coin.symbol))
  assert.equal(result.candidates[49].name, "Project 49")
  assert.deepEqual(Object.keys(result.candidates[0]).sort(), ["name", "news", "symbol"])
  assert.deepEqual(shortlist, before)
})

test("rejects duplicate candidates before requesting sources", async () => {
  const shortlist = createShortlist()
  shortlist.candidates.push({ coin: { ...shortlist.candidates[0].coin, symbol: "sushi" } })

  await assert.rejects(enrichCandidatesWithNews(shortlist, {
    fetchNews: async () => assert.fail("Invalid candidates must not reach sources"),
    fetchStory: async () => assert.fail("Invalid candidates must not reach sources"),
  }), /duplicate symbol sushi/)
})

test("requires a step 5 snapshot and TradingView coin symbols", async () => {
  await assert.rejects(enrichCandidatesWithNews({}), /Step 5 candidates are required/)
  const shortlist = createShortlist()
  delete shortlist.asOf
  await assert.rejects(enrichCandidatesWithNews(shortlist), /Step 5 asOf is required/)
  const incompleteShortlist = createShortlist()
  delete incompleteShortlist.candidates[0].coin.tradingViewSymbol
  await assert.rejects(enrichCandidatesWithNews(incompleteShortlist), /tradingViewSymbol is required/)
})
