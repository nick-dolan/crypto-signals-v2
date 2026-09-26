import assert from "node:assert/strict"
import test from "node:test"

import { fetchTweetPage } from "../src/api/twitter-api.js"

test("passes the fixed time window unchanged to the latest Twitter search page", async (context) => {
  const previousApiKey = process.env.TWITTERAPI_IO_KEY

  process.env.TWITTERAPI_IO_KEY = "twitter-test-key"

  try {
    const fetchMock = context.mock.method(globalThis, "fetch", async () => (
      new Response(JSON.stringify({
        tweets: [{ id: "tweet-1" }],
        next_cursor: "next-page",
      }), {
        headers: { "content-type": "application/json" },
      })
    ))
    const result = await fetchTweetPage("$BTC since_time:1799913600 until_time:1800000001", "current-page")

    assert.equal(fetchMock.mock.callCount(), 1)

    const [requestUrl, options] = fetchMock.mock.calls[0].arguments
    const url = new URL(requestUrl)

    assert.equal(url.origin, "https://api.twitterapi.io")
    assert.equal(url.pathname, "/twitter/tweet/advanced_search")
    assert.equal(url.searchParams.get("query"), "$BTC since_time:1799913600 until_time:1800000001")
    assert.equal(url.searchParams.get("queryType"), "Latest")
    assert.equal(url.searchParams.get("cursor"), "current-page")
    assert.equal(options.headers["X-API-Key"], "twitter-test-key")
    assert.deepEqual(result, {
      tweets: [{ id: "tweet-1" }],
      next_cursor: "next-page",
    })
  } finally {
    if (previousApiKey === undefined) {
      delete process.env.TWITTERAPI_IO_KEY
    } else {
      process.env.TWITTERAPI_IO_KEY = previousApiKey
    }
  }
})

test("reports a Twitter API error", async (context) => {
  const previousApiKey = process.env.TWITTERAPI_IO_KEY

  process.env.TWITTERAPI_IO_KEY = "twitter-test-key"

  try {
    context.mock.method(globalThis, "fetch", async () => (
      new Response(null, { status: 429, statusText: "Too Many Requests" })
    ))

    await assert.rejects(
      fetchTweetPage("$BTC"),
      /Twitter API error: 429 Too Many Requests/,
    )
  } finally {
    if (previousApiKey === undefined) {
      delete process.env.TWITTERAPI_IO_KEY
    } else {
      process.env.TWITTERAPI_IO_KEY = previousApiKey
    }
  }
})
