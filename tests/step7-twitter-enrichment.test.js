import assert from "node:assert/strict"
import test, { beforeEach } from "node:test"

import { isNaN } from "../src/helpers/utils.typed.js"
import { enrichCandidatesWithTwitter } from "../src/steps/step7-twitter-enrichment/enrich-candidates-with-twitter.js"

beforeEach((context) => {
  const fetchMock = context.mock.method(globalThis, "fetch", () => assert.fail("Real HTTP must not be used"))
  context.after(() => assert.equal(fetchMock.mock.callCount(), 0))
})

function flush () {
  return new Promise(resolve => setImmediate(resolve))
}

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
        name: "Bitcoin",
        news: { status: "available", items: [{ id: "btc-news" }] },
      },
      {
        symbol: "ETH",
        name: "Ethereum",
        news: { status: "empty", items: [] },
      },
    ],
  }
}

function createBatchInput (count) {
  return {
    ...createInput(),
    candidates: Array.from({ length: count }, (_, index) => ({
      symbol: `COIN${index}`,
      name: `Project ${index}`,
      news: {
        status: "available",
        items: [{ id: `news-${index}`, title: `News ${index}`, relatedSymbols: [`COIN${index}`] }],
      },
      description: `Description ${index}`,
      metadata: { rank: index + 1, tags: [`tag-${index}`] },
    })),
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
  const result = await enrichCandidatesWithTwitter(createInput(), {
    referenceTimestamp,
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
    { query: "$ETH since_time:1799913600 until_time:1800000001", cursor: "" },
    { query: "$BTC since_time:1799913600 until_time:1800000001", cursor: "btc-page-2" },
  ])
  assert.equal(result.schemaVersion, 6)
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
  const result = await enrichCandidatesWithTwitter(createInput(), {
    referenceTimestamp,
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
      const result = await enrichCandidatesWithTwitter(input, {
        referenceTimestamp,
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
    const result = await enrichCandidatesWithTwitter(input, {
      referenceTimestamp: 1_800_000_000,

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
  const result = await enrichCandidatesWithTwitter(createInput(), {
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

test("validates the step 6 input and Twitter dependencies", async () => {
  await assert.rejects(
    enrichCandidatesWithTwitter({}, { fetchPage: async () => ({}) }),
    /Step 6 enrichment candidates are required/,
  )

  const input = createInput()
  input.candidates[1].symbol = "btc"

  await assert.rejects(
    enrichCandidatesWithTwitter(input, { fetchPage: async () => ({}) }),
    /duplicate symbol BTC/,
  )

  await assert.rejects(
    enrichCandidatesWithTwitter(createInput(), { fetchPage: null }),
    /Twitter fetcher must be a function/,
  )

  await assert.rejects(
    enrichCandidatesWithTwitter(createInput(), {
      fetchPage: async () => ({}),
      referenceTimestamp: 0,
    }),
    /positive Unix timestamp/,
  )
})

test("reuses the news window when Twitter runs separately later", async (t) => {
  const input = createInput()
  input.newsEnrichment.asOf = "2027-01-15T08:00:00.000Z"
  t.mock.method(Date, "now", () => Date.parse("2027-01-16T08:00:00.000Z"))
  const queries = []
  const result = await enrichCandidatesWithTwitter(input, {
    fetchPage: async (query) => {
      queries.push(query)
      return { tweets: [] }
    },
  })
  const timestamp = Date.parse(input.newsEnrichment.asOf) / 1_000
  assert.equal(result.twitterEnrichment.asOf, input.newsEnrichment.asOf)
  assert.equal(queries[0], `$BTC since_time:${timestamp - 86_400} until_time:${timestamp + 1}`)
})

test("starts ten coin workers in FIFO order, bounds concurrency and deduplicates a single page", async (context) => {
  const input = createBatchInput(50)
  const before = structuredClone(input)
  const gates = input.candidates.map(() => Promise.withResolvers())
  const started = []
  let active = 0
  let maximum = 0
  const fetchPage = context.mock.fn(async (query) => {
    const index = Number(query.match(/^\$COIN(\d+) /)[1])
    started.push(index)
    active += 1
    maximum = Math.max(maximum, active)
    await gates[index].promise
    active -= 1
    const tweet = createTweet({ id: "single", timestamp: 1_800_000_000 })
    return { tweets: [tweet, tweet] }
  })
  const pending = enrichCandidatesWithTwitter(input, { referenceTimestamp: 1_800_000_000, fetchPage })

  await flush()
  assert.deepEqual(started, Array.from({ length: 10 }, (_, index) => index))
  assert.equal(active, 10)
  for (let index = 9; index < 49; index += 1) {
    gates[index].resolve()
    await flush()
    assert.deepEqual(started, Array.from({ length: index + 2 }, (_, index) => index))
    assert.equal(active, 10)
    assert.equal(maximum, 10)
  }
  gates[49].resolve()
  gates.slice(0, 9).toReversed().forEach(gate => gate.resolve())
  const result = await pending
  assert.equal(active, 0)
  assert.equal(maximum, 10)
  assert.equal(fetchPage.mock.callCount(), 50)
  assert.equal(result.candidates.length, 50)
  assert.ok(result.candidates.every(candidate => candidate.twitter.recentTweetCount === 1))
  assert.equal(result.candidates[49].name, "Project 49")
  result.candidates.forEach((candidate, index) => {
    assert.deepEqual(candidate, { ...before.candidates[index], twitter: candidate.twitter })
  })
  assert.deepEqual(input, before)
  await flush()
  assert.equal(fetchPage.mock.callCount(), 50)
})

test("holds each worker through its own cursor page and preserves results after out-of-order completion", async (context) => {
  const input = createBatchInput(12)
  const before = structuredClone(input)
  const firstPages = input.candidates.map(() => Promise.withResolvers())
  const secondPages = input.candidates.map(() => Promise.withResolvers())
  const firstFinished = new Set()
  const inFlight = new Set()
  const completed = []
  const calls = []
  let activeCoins = 0
  let maximum = 0
  const fetchPage = context.mock.fn(async (query, cursor = "") => {
    const index = Number(query.match(/^\$COIN(\d+) /)[1])
    assert.equal(query, `$COIN${index} since_time:1799913600 until_time:1800000001`)
    assert.equal(inFlight.has(index), false, "Pages of the same coin must not overlap")
    if (cursor) {
      assert.ok(firstFinished.has(index), "The first response must complete before its cursor page")
      assert.equal(cursor, `page:COIN${index}/+?=&%2F`)
    } else {
      activeCoins += 1
      maximum = Math.max(maximum, activeCoins)
    }
    calls.push({ index, cursor })
    inFlight.add(index)
    try {
      const page = await (cursor ? secondPages[index] : firstPages[index]).promise
      if (cursor) {
        completed.push(index)
        activeCoins -= 1
      } else {
        firstFinished.add(index)
      }
      return page
    } finally {
      inFlight.delete(index)
    }
  })
  const firstPage = index => ({
    has_next_page: true,
    next_cursor: `page:COIN${index}/+?=&%2F`,
    tweets: [createTweet({ id: `${index}-first`, timestamp: 1_799_999_940 })],
  })
  const secondPage = index => ({
    has_next_page: true,
    next_cursor: "ignored-third-page",
    tweets: [createTweet({ id: `${index}-second`, timestamp: 1_799_999_880 })],
  })
  let settled = false
  const pending = enrichCandidatesWithTwitter(input, { referenceTimestamp: 1_800_000_000, fetchPage }).then((result) => {
    settled = true
    return result
  })

  await flush()
  assert.deepEqual(calls, Array.from({ length: 10 }, (_, index) => ({ index, cursor: "" })))
  assert.equal(activeCoins, 10)
  for (const index of [7, 2, 9, 1, 8, 3, 6, 4, 5, 0]) {
    firstPages[index].resolve(firstPage(index))
    await flush()
    assert.deepEqual(calls.at(-1), { index, cursor: `page:COIN${index}/+?=&%2F` })
    assert.equal(calls.filter(({ cursor }) => !cursor).length, 10)
    assert.equal(activeCoins, 10)
    assert.equal(maximum, 10)
    assert.equal(settled, false)
  }

  secondPages[7].resolve(secondPage(7))
  await flush()
  assert.deepEqual(calls.at(-1), { index: 10, cursor: "" })
  assert.equal(activeCoins, 10)
  firstPages[10].resolve(firstPage(10))
  await flush()
  assert.deepEqual(calls.at(-1), { index: 10, cursor: "page:COIN10/+?=&%2F" })
  assert.equal(calls.some(({ index }) => index === 11), false)

  secondPages[2].resolve(secondPage(2))
  await flush()
  assert.deepEqual(calls.at(-1), { index: 11, cursor: "" })
  firstPages[11].resolve(firstPage(11))
  await flush()
  assert.equal(activeCoins, 10)
  for (const index of [11, 10, 9, 8, 6, 5, 4, 3, 1, 0]) {
    secondPages[index].resolve(secondPage(index))
    await flush()
  }

  const result = await pending
  assert.deepEqual(completed, [7, 2, 11, 10, 9, 8, 6, 5, 4, 3, 1, 0])
  assert.equal(activeCoins, 0)
  assert.equal(inFlight.size, 0)
  assert.equal(maximum, 10)
  assert.equal(fetchPage.mock.callCount(), 24)
  assert.equal(result.asOf, before.asOf)
  assert.deepEqual(result.newsEnrichment, before.newsEnrichment)
  result.candidates.forEach((candidate, index) => {
    assert.deepEqual(candidate, { ...before.candidates[index], twitter: candidate.twitter })
    assert.equal(candidate.twitter.status, "available")
    assert.equal(candidate.twitter.fetchedPageCount, 2)
    assert.equal(candidate.twitter.recentTweetCount, 2)
    assert.deepEqual(candidate.twitter.tweets.map(({ id }) => id), [`${index}-first`, `${index}-second`])
    assert.deepEqual(calls.filter(call => call.index === index), [
      { index, cursor: "" },
      { index, cursor: `page:COIN${index}/+?=&%2F` },
    ])
  })
  assert.deepEqual(input, before)
  await flush()
  assert.equal(fetchPage.mock.callCount(), 24)
})

for (const failedPage of [1, 2]) {
  test(`page ${failedPage} failure releases its worker without cancelling other coins or leaking calls`, async (context) => {
    context.mock.timers.enable({ apis: ["setTimeout"] })
    const input = createBatchInput(12)
    const before = structuredClone(input)
    const firstPages = input.candidates.map(() => Promise.withResolvers())
    const secondPages = input.candidates.map(() => Promise.withResolvers())
    const calls = []
    const inFlight = new Set()
    const fetchPage = context.mock.fn(async (query, cursor = "") => {
      const index = Number(query.match(/^\$COIN(\d+) /)[1])
      assert.equal(inFlight.has(index), false)
      if (cursor) {
        assert.equal(cursor, `next-${index}`)
      }
      calls.push({ index, cursor })
      inFlight.add(index)
      try {
        return await (cursor ? secondPages[index] : firstPages[index]).promise
      } finally {
        inFlight.delete(index)
      }
    })
    const firstPage = index => ({
      next_cursor: `next-${index}`,
      tweets: [createTweet({ id: `${index}-first`, timestamp: 1_800_000_000 })],
    })
    const secondPage = index => ({
      next_cursor: "ignored-third-page",
      tweets: [createTweet({ id: `${index}-second`, timestamp: 1_799_999_940 })],
    })
    let settled = false
    const pending = enrichCandidatesWithTwitter(input, { referenceTimestamp: 1_800_000_000, fetchPage }).then((result) => {
      settled = true
      return result
    })

    await flush()
    assert.deepEqual(calls, Array.from({ length: 10 }, (_, index) => ({ index, cursor: "" })))
    if (failedPage === 2) {
      firstPages[0].resolve(firstPage(0))
      await flush()
      assert.deepEqual(calls.at(-1), { index: 0, cursor: "next-0" })
      assert.equal(calls.some(({ index }) => index === 10), false)
    }
    const failedResponse = failedPage === 1 ? firstPages[0] : secondPages[0]
    failedResponse.reject(new Error(`Page ${failedPage} failed`))
    await flush()
    assert.deepEqual(calls.at(-1), { index: 10, cursor: "" })
    assert.equal(settled, false)

    firstPages.forEach((gate, index) => {
      if (index > 0) {
        gate.resolve(firstPage(index))
      }
    })
    await flush()
    assert.equal(calls.some(({ index }) => index === 11), false)
    secondPages[1].resolve(secondPage(1))
    await flush()
    assert.deepEqual(calls.slice(-2), [{ index: 11, cursor: "" }, { index: 11, cursor: "next-11" }])
    assert.equal(settled, false)
    secondPages.forEach((gate, index) => {
      if (index > 1) {
        gate.resolve(secondPage(index))
      }
    })

    const result = await pending
    assert.equal(inFlight.size, 0)
    assert.deepEqual(result.candidates[0].twitter, {
      query: "$COIN0 since_time:1799913600 until_time:1800000001",
      status: "failed",
      error: `Page ${failedPage} failed`,
      fetchedPageCount: null,
      recentTweetCount: null,
      tweets: [],
    })
    result.candidates.forEach((candidate, index) => {
      assert.deepEqual(candidate, { ...before.candidates[index], twitter: candidate.twitter })
      if (index > 0) {
        assert.equal(candidate.twitter.status, "available")
        assert.equal(candidate.twitter.fetchedPageCount, 2)
        assert.deepEqual(candidate.twitter.tweets.map(({ id }) => id), [`${index}-first`, `${index}-second`])
        assert.deepEqual(calls.filter(call => call.index === index), [
          { index, cursor: "" },
          { index, cursor: `next-${index}` },
        ])
      }
    })
    assert.equal(calls.filter(({ index }) => index === 0).length, failedPage)
    assert.equal(fetchPage.mock.callCount(), 22 + failedPage)
    assert.deepEqual(input, before)
    const completedCalls = structuredClone(calls)
    context.mock.timers.tick(60_000)
    await flush()
    assert.deepEqual(calls, completedCalls)
    assert.equal(inFlight.size, 0)
  })
}

test("empty input returns an empty result without any page or HTTP calls", async (context) => {
  const input = createBatchInput(0)
  const before = structuredClone(input)
  const fetchPage = context.mock.fn(() => assert.fail("Empty input must not fetch pages"))
  const result = await enrichCandidatesWithTwitter(input, { referenceTimestamp: 1_800_000_000, fetchPage })

  assert.deepEqual(result.candidates, [])
  assert.equal(result.schemaVersion, 6)
  assert.equal(result.twitterEnrichment.asOf, new Date(1_800_000_000_000).toISOString())
  assert.deepEqual(result.newsEnrichment, before.newsEnrichment)
  assert.deepEqual(input, before)
  await flush()
  assert.equal(fetchPage.mock.callCount(), 0)
})
