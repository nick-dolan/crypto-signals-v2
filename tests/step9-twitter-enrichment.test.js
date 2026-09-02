import assert from "node:assert/strict"
import test from "node:test"

import { isNaN } from "../src/helpers/utils.typed.js"
import { enrichTopCandidatesWithTwitter } from "../src/steps/step9-twitter-enrichment/enrich-top-candidates-with-twitter.js"

function createInput () {
  return {
    schemaVersion: 3,
    generatedAt: "2027-01-15T08:01:00.000Z",
    asOf: "2027-01-15T08:00:00.000Z",
    newsEnrichment: {
      source: "tradingview",
      lookbackHours: 24,
    },
    topCandidates: [
      {
        symbol: "BTC",
        movementProbability: 0.7,
        news: { status: "available", items: [{ id: "btc-news" }] },
      },
      {
        symbol: "ETH",
        movementProbability: 0.6,
        news: { status: "empty", items: [] },
      },
    ],
  }
}

function createTweet ({
  id,
  timestamp,
  text = `Tweet ${id}`,
  createdAt = new Date(timestamp * 1_000).toISOString(),
}) {
  return {
    id,
    text,
    createdAt,
    likeCount: 10,
    retweetCount: 3,
    viewCount: 500,
    author: {
      userName: `${id}-author`,
      followers: 1_000,
    },
  }
}

test("fetches at most two pages and keeps only the fixed 24-hour window", async () => {
  const referenceTimestamp = 1_800_000_000
  const calls = []
  const waits = []
  const result = await enrichTopCandidatesWithTwitter(createInput(), {
    referenceTimestamp,
    wait: async milliseconds => waits.push(milliseconds),
    fetchPage: async (query, cursor = "") => {
      calls.push({ query, cursor })

      if (query === "$BTC" && !cursor) {
        return {
          next_cursor: "btc-page-2",
          tweets: [
            createTweet({ id: "btc-new", timestamp: referenceTimestamp - 60 }),
            createTweet({ id: "btc-boundary", timestamp: referenceTimestamp - 24 * 60 * 60 }),
            createTweet({ id: "btc-future", timestamp: referenceTimestamp + 1 }),
            createTweet({ id: "btc-old", timestamp: referenceTimestamp - 24 * 60 * 60 - 1 }),
            createTweet({
              id: "btc-invalid",
              timestamp: referenceTimestamp,
              createdAt: "not-a-date",
            }),
          ],
        }
      }

      if (query === "$BTC" && cursor === "btc-page-2") {
        return {
          next_cursor: "ignored-page-3",
          tweets: [
            createTweet({ id: "btc-second", timestamp: referenceTimestamp - 120 }),
            createTweet({ id: "btc-new", timestamp: referenceTimestamp - 60 }),
          ],
        }
      }

      return {
        next_cursor: "eth-page-2",
        tweets: [
          createTweet({ id: "eth-old", timestamp: referenceTimestamp - 24 * 60 * 60 - 1 }),
        ],
      }
    },
  })

  assert.deepEqual(calls, [
    { query: "$BTC", cursor: "" },
    { query: "$BTC", cursor: "btc-page-2" },
    { query: "$ETH", cursor: "" },
  ])
  assert.deepEqual(waits, [300, 300])
  assert.equal(result.schemaVersion, 4)
  assert.equal(result.asOf, createInput().asOf)
  assert.deepEqual(result.newsEnrichment, createInput().newsEnrichment)
  assert.ok(!isNaN(Date.parse(result.generatedAt)))
  assert.deepEqual(result.twitterEnrichment, {
    source: "twitterapi.io",
    asOf: new Date(referenceTimestamp * 1_000).toISOString(),
    from: new Date((referenceTimestamp - 24 * 60 * 60) * 1_000).toISOString(),
    lookbackHours: 24,
    maxPagesPerCandidate: 2,
  })

  const [btc, eth] = result.topCandidates

  assert.equal(btc.twitter.query, "$BTC")
  assert.equal(btc.twitter.status, "available")
  assert.equal(btc.twitter.error, null)
  assert.equal(btc.twitter.fetchedPageCount, 2)
  assert.equal(btc.twitter.recentTweetCount, 3)
  assert.deepEqual(
    btc.twitter.tweets.map(tweet => tweet.id),
    ["btc-new", "btc-second", "btc-boundary"],
  )
  assert.deepEqual(btc.twitter.tweets[0], {
    id: "btc-new",
    text: "Tweet btc-new",
    createdAt: new Date((referenceTimestamp - 60) * 1_000).toISOString(),
    hoursAgo: 0,
    likeCount: 10,
    retweetCount: 3,
    viewCount: 500,
    authorUsername: "btc-new-author",
    authorFollowers: 1_000,
  })
  assert.deepEqual(btc.news, createInput().topCandidates[0].news)
  assert.deepEqual(eth.twitter, {
    query: "$ETH",
    status: "empty",
    error: null,
    fetchedPageCount: 1,
    recentTweetCount: 0,
    tweets: [],
  })
})

test("keeps candidate failures isolated", async () => {
  const referenceTimestamp = 1_800_000_000
  const result = await enrichTopCandidatesWithTwitter(createInput(), {
    referenceTimestamp,
    wait: async () => {},
    fetchPage: async (query) => {
      if (query === "$BTC") {
        throw new Error("Twitter request failed")
      }

      return {
        tweets: [
          createTweet({ id: "eth-new", timestamp: referenceTimestamp - 300 }),
        ],
      }
    },
  })
  const [btc, eth] = result.topCandidates

  assert.deepEqual(btc.twitter, {
    query: "$BTC",
    status: "failed",
    error: "Twitter request failed",
    fetchedPageCount: null,
    recentTweetCount: null,
    tweets: [],
  })
  assert.equal(eth.twitter.status, "available")
  assert.equal(eth.twitter.recentTweetCount, 1)
})

test("validates the step 8 input and Twitter dependencies", async () => {
  await assert.rejects(
    enrichTopCandidatesWithTwitter({}, {
      fetchPage: async () => ({}),
      wait: async () => {},
    }),
    /Step 8 top candidates are required/,
  )

  const input = createInput()
  input.topCandidates[1].symbol = "btc"

  await assert.rejects(
    enrichTopCandidatesWithTwitter(input, {
      fetchPage: async () => ({}),
      wait: async () => {},
    }),
    /duplicate symbol BTC/,
  )

  await assert.rejects(
    enrichTopCandidatesWithTwitter(createInput(), {
      fetchPage: null,
      wait: async () => {},
    }),
    /Twitter fetcher and wait must be functions/,
  )

  await assert.rejects(
    enrichTopCandidatesWithTwitter(createInput(), {
      fetchPage: async () => ({}),
      referenceTimestamp: 0,
      wait: async () => {},
    }),
    /positive Unix timestamp/,
  )
})
