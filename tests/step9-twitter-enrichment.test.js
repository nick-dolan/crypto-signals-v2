import assert from "node:assert/strict"
import test from "node:test"

import { isNaN } from "../src/helpers/utils.typed.js"
import { enrichTopCandidatesWithTwitter } from "../src/steps/step9-twitter-enrichment/enrich-top-candidates-with-twitter.js"

function createInput () {
  return {
    schemaVersion: 4,
    generatedAt: "2027-01-15T08:01:00.000Z",
    asOf: "2027-01-15T08:00:00.000Z",
    newsEnrichment: {
      source: "tradingview",
      lookbackHours: 24,
    },
    candidates: [
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

      if (query.startsWith("$BTC ") && !cursor) {
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

      if (query.startsWith("$BTC ") && cursor === "btc-page-2") {
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
        has_next_page: false,
        tweets: [
          createTweet({ id: "eth-old", timestamp: referenceTimestamp - 24 * 60 * 60 - 1 }),
        ],
      }
    },
  })

  assert.deepEqual(calls, [
    { query: "$BTC since_time:1799913600 until_time:1800000001", cursor: "" },
    { query: "$BTC since_time:1799913600 until_time:1800000001", cursor: "btc-page-2" },
    { query: "$ETH since_time:1799913600 until_time:1800000001", cursor: "" },
  ])
  assert.deepEqual(waits, [300, 300])
  assert.equal(result.schemaVersion, 5)
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

  const [btc, eth] = result.candidates

  assert.equal(btc.twitter.query, "$BTC since_time:1799913600 until_time:1800000001")
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
  assert.deepEqual(btc.news, createInput().candidates[0].news)
  assert.deepEqual(eth.twitter, {
    query: "$ETH since_time:1799913600 until_time:1800000001",
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
      if (query.startsWith("$BTC ")) {
        throw new Error("Twitter request failed")
      }

      return {
        tweets: [
          createTweet({ id: "eth-new", timestamp: referenceTimestamp - 300 }),
        ],
      }
    },
  })
  const [btc, eth] = result.candidates

  assert.deepEqual(btc.twitter, {
    query: "$BTC since_time:1799913600 until_time:1800000001",
    status: "failed",
    error: "Twitter request failed",
    fetchedPageCount: null,
    recentTweetCount: null,
    tweets: [],
  })
  assert.equal(eth.twitter.status, "available")
  assert.equal(eth.twitter.recentTweetCount, 1)
})

test("continues past an empty filtered page and keeps both boundaries of the fixed window", async (t) => {
  const referenceTimestamp = 1_800_000_000
  for (const [name, firstTweets] of [
    ["tweets newer than the snapshot", [createTweet({ id: "too-new", timestamp: referenceTimestamp + 17 * 60 })]],
    ["empty API page", []],
    ["invalid timestamps", [createTweet({ id: "invalid", timestamp: referenceTimestamp, createdAt: "invalid" })]],
  ]) {
    await t.test(name, async () => {
      const input = createInput()
      input.candidates = [input.candidates[0]]
      const before = structuredClone(input)
      const calls = []
      const waits = []
      const result = await enrichTopCandidatesWithTwitter(input, {
        referenceTimestamp,
        wait: async milliseconds => waits.push(milliseconds),
        fetchPage: async (query, cursor = "") => {
          calls.push({ query, cursor })
          return cursor
            ? {
                has_next_page: true,
                next_cursor: "ignored-third-page",
                tweets: [
                  createTweet({ id: "as-of", timestamp: referenceTimestamp }),
                  createTweet({ id: "inside", timestamp: referenceTimestamp - 60 }),
                  createTweet({ id: "inside", timestamp: referenceTimestamp - 60 }),
                  createTweet({ id: "from", timestamp: referenceTimestamp - 24 * 60 * 60 }),
                  createTweet({ id: "old", timestamp: referenceTimestamp - 24 * 60 * 60 - 1 }),
                  createTweet({ id: "future", timestamp: referenceTimestamp + 1 }),
                ],
              }
            : { has_next_page: true, next_cursor: "older-page", tweets: firstTweets }
        },
      })

      assert.deepEqual(calls, [
        { query: "$BTC since_time:1799913600 until_time:1800000001", cursor: "" },
        { query: "$BTC since_time:1799913600 until_time:1800000001", cursor: "older-page" },
      ])
      assert.deepEqual(waits, [300])
      const { twitter } = result.candidates[0]
      assert.equal(twitter.query, calls[0].query)
      assert.equal(twitter.status, "available")
      assert.equal(twitter.fetchedPageCount, 2)
      assert.equal(twitter.recentTweetCount, 3)
      assert.deepEqual(twitter.tweets.map(tweet => tweet.id), ["as-of", "inside", "from"])
      assert.equal(twitter.tweets[0].createdAt, result.twitterEnrichment.asOf)
      assert.equal(twitter.tweets.at(-1).createdAt, result.twitterEnrichment.from)
      assert.deepEqual(input, before)
    })
  }
})

test("does not request another page after the last page or without a usable cursor", async () => {
  for (const pagination of [
    { has_next_page: false, next_cursor: "unused-cursor" },
    { has_next_page: true, next_cursor: "" },
    { has_next_page: true, next_cursor: " \n " },
  ]) {
    const input = createInput()
    input.candidates = [input.candidates[0]]
    let callCount = 0
    const result = await enrichTopCandidatesWithTwitter(input, {
      referenceTimestamp: 1_800_000_000,
      wait: async () => assert.fail("No pagination wait expected"),
      fetchPage: async () => {
        callCount += 1
        return { ...pagination, tweets: [] }
      },
    })
    assert.equal(callCount, 1)
    assert.equal(result.candidates[0].twitter.fetchedPageCount, 1)
    assert.equal(result.candidates[0].twitter.status, "empty")
  }
})

test("default queries keep the pipeline start boundary when collection runs later", async (context) => {
  const previousStartedAt = process.env.PIPELINE_STARTED_AT
  process.env.PIPELINE_STARTED_AT = "1800000000"
  context.after(() => {
    if (previousStartedAt === undefined) {
      delete process.env.PIPELINE_STARTED_AT
    } else {
      process.env.PIPELINE_STARTED_AT = previousStartedAt
    }
  })
  context.mock.method(Date, "now", () => 1_800_001_020_000)
  const queries = []
  const result = await enrichTopCandidatesWithTwitter(createInput(), {
    wait: async () => {},
    fetchPage: async (query) => {
      queries.push(query)
      return { has_next_page: false, next_cursor: "", tweets: [] }
    },
  })

  assert.deepEqual(queries, [
    "$BTC since_time:1799913600 until_time:1800000001",
    "$ETH since_time:1799913600 until_time:1800000001",
  ])
  assert.equal(result.twitterEnrichment.asOf, new Date(1_800_000_000_000).toISOString())
})

test("validates the step 8 input and Twitter dependencies", async () => {
  await assert.rejects(
    enrichTopCandidatesWithTwitter({}, {
      fetchPage: async () => ({}),
      wait: async () => {},
    }),
    /Step 8 enrichment candidates are required/,
  )

  const input = createInput()
  input.candidates[1].symbol = "btc"

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
