import assert from "node:assert/strict"
import test from "node:test"

import { formatStepError } from "../src/helpers/step-error-helper.js"
import { enrichCandidatesWithTwitter } from "../src/steps/step7-twitter-enrichment/enrich-candidates-with-twitter.js"

function input (symbols = ["ETC"]) {
  return {
    asOf: "2026-11-21T12:00:00.000Z",
    candidates: symbols.map(symbol => ({ symbol })),
  }
}

function tweet (id, createdAt = "2026-11-21T12:00:00.000Z") {
  return { id, text: `Tweet ${id}`, createdAt, likeCount: 1 }
}

test("Twitter retains the first page and reports failed and partial candidates in one notification", async (t) => {
  const reportError = t.mock.fn(async () => {})
  const fetchPage = t.mock.fn(async (query, cursor) => {
    if (query.startsWith("$ETH ")) {
      throw new Error("Twitter API error: 503 Service Unavailable")
    }
    if (query.startsWith("$ETC ")) {
      if (cursor) {
        assert.equal(cursor, "next-page")
        throw new Error("Twitter request timed out")
      }
      return {
        tweets: [tweet("retained"), tweet("retained"), tweet("old", "2026-11-20T11:59:59.000Z")],
        has_next_page: true,
        next_cursor: "next-page",
      }
    }
    return { tweets: query.startsWith("$CAKE ") ? [tweet("cake")] : [], has_next_page: false }
  })

  const output = await enrichCandidatesWithTwitter(input(["ETC", "ETH", "CAKE", "BAS"]), {
    referenceTimestamp: Date.parse("2026-11-21T13:00:00.000Z") / 1_000,
    fetchPage,
    reportError,
  })

  assert.deepEqual(output.candidates.map(({ twitter }) => twitter.status), ["partial", "failed", "available", "empty"])
  const partial = output.candidates[0].twitter
  assert.equal(partial.error, "Twitter request timed out")
  assert.equal(partial.fetchedPageCount, 1)
  assert.equal(partial.recentTweetCount, 1)
  assert.deepEqual(partial.tweets.map(item => item.id), ["retained"])
  assert.equal(partial.tweets[0].text, "Tweet retained")
  const failed = output.candidates[1].twitter
  assert.equal(failed.error, "Twitter API error: 503 Service Unavailable")
  assert.equal(failed.fetchedPageCount, null)
  assert.equal(failed.recentTweetCount, null)
  assert.deepEqual(failed.tweets, [])
  assert.equal(fetchPage.mock.callCount(), 5)
  assert.equal(reportError.mock.callCount(), 1)
  const [error, context] = reportError.mock.calls[0].arguments
  assert.deepEqual(context, {
    step: "step7-twitter-enrichment.js", operation: "fetch_tweets", source: "twitterapi.io", symbols: "ETC, ETH",
  })
  const notification = formatStepError(error, context, {})
  assert.match(notification, /Монеты: ETC, ETH/u)
  assert.match(notification, /1 монет без данных, 1 — с частичными данными \(всего 4\)/u)
  assert.match(notification, /Twitter request timed out/u)
  assert.match(notification, /503 Service Unavailable/u)
})

test("a malformed second Twitter page keeps an empty first-page sample partial rather than empty", async (t) => {
  const reportError = t.mock.fn(async () => {})
  const output = await enrichCandidatesWithTwitter(input(), {
    referenceTimestamp: Date.parse("2026-11-21T13:00:00.000Z") / 1_000,
    fetchPage: async (query, cursor) => cursor
      ? { status: "error" }
      : { tweets: [tweet("old", "2026-11-20T12:59:59.000Z")], next_cursor: "next-page" },
    reportError,
  })

  const { twitter } = output.candidates[0]
  assert.equal(twitter.status, "partial")
  assert.equal(twitter.fetchedPageCount, 1)
  assert.equal(twitter.recentTweetCount, 0)
  assert.deepEqual(twitter.tweets, [])
  assert.match(twitter.error, /Twitter page 2 response does not contain a tweets array/)
  assert.equal(reportError.mock.callCount(), 1)
})

test("successful Twitter pagination merges and filters both pages without an error notification", async (t) => {
  const reportError = t.mock.fn(async () => {})
  const fetchPage = t.mock.fn(async (query, cursor) => cursor
    ? { tweets: [tweet("latest"), tweet("boundary", "2026-11-20T13:00:00.000Z")], has_next_page: false }
    : {
        tweets: [tweet("boundary", "2026-11-20T13:00:00.000Z"), tweet("future", "2026-11-21T13:00:01.000Z")],
        next_cursor: "next-page",
      })
  const output = await enrichCandidatesWithTwitter(input(), {
    referenceTimestamp: Date.parse("2026-11-21T13:00:00.000Z") / 1_000,
    fetchPage,
    reportError,
  })

  const { twitter } = output.candidates[0]
  assert.equal(twitter.status, "available")
  assert.equal(twitter.error, null)
  assert.equal(twitter.fetchedPageCount, 2)
  assert.equal(twitter.recentTweetCount, 2)
  assert.deepEqual(twitter.tweets.map(item => item.id), ["latest", "boundary"])
  assert.equal(fetchPage.mock.callCount(), 2)
  assert.equal(reportError.mock.callCount(), 0)
  assert.match(twitter.query, /since_time:1795179600 until_time:1795266001$/)
})
