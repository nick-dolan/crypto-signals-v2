import assert from "node:assert/strict"
import test from "node:test"
import { inspect } from "node:util"

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

function useTwitterKey (context) {
  const previous = process.env.TWITTERAPI_IO_KEY
  process.env.TWITTERAPI_IO_KEY = "twitter-test-key"

  context.after(() => {
    if (previous === undefined) {
      delete process.env.TWITTERAPI_IO_KEY
    } else {
      process.env.TWITTERAPI_IO_KEY = previous
    }
  })
}

function rejectsSafely (promise, message) {
  return assert.rejects(promise, (error) => {
    assert.equal(error.message, message)
    assert.equal(error.cause, undefined)
    for (const value of ["twitter-test-key", "private-query", "private-response"]) {
      assert.equal(inspect(error, { showHidden: true }).includes(value), false)
    }
    return true
  })
}

test("requires a nonempty Twitter key without sending a request or starting a timer", async (context) => {
  useTwitterKey(context)
  const fetchMock = context.mock.method(globalThis, "fetch", async () => assert.fail("Unexpected fetch"))
  const timerMock = context.mock.method(globalThis, "setTimeout")

  for (const key of [undefined, "", " \n\t "]) {
    if (key === undefined) {
      delete process.env.TWITTERAPI_IO_KEY
    } else {
      process.env.TWITTERAPI_IO_KEY = key
    }
    await rejectsSafely(fetchTweetPage("private-query"), "Twitter API key is required")
  }

  assert.equal(fetchMock.mock.callCount(), 0)
  assert.equal(timerMock.mock.callCount(), 0)
})

test("validates Twitter timeouts before sending a request", async (context) => {
  useTwitterKey(context)
  const fetchMock = context.mock.method(globalThis, "fetch", async () => assert.fail("Unexpected fetch"))

  for (const timeoutMs of [0, -1, NaN, Infinity, "10", null]) {
    await rejectsSafely(fetchTweetPage("private-query", "", { timeoutMs }), "Twitter timeoutMs must be a positive finite number")
  }
  assert.equal(fetchMock.mock.callCount(), 0)
})

test("trims the key, prevents credential redirects and releases the timer after success", async (context) => {
  useTwitterKey(context)
  process.env.TWITTERAPI_IO_KEY = "  twitter-test-key  "
  context.mock.timers.enable({ apis: ["setTimeout"] })
  const fetchMock = context.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ tweets: [] })))

  assert.deepEqual(await fetchTweetPage("private-query"), { tweets: [] })
  const options = fetchMock.mock.calls[0].arguments[1]
  assert.equal(options.headers["X-API-Key"], "twitter-test-key")
  assert.equal(options.redirect, "manual")
  assert.equal(options.signal instanceof AbortSignal, true)
  context.mock.timers.tick(15_000)
  assert.equal(options.signal.aborted, false)
})

test("aborts Twitter requests at the default or optional timeout without exposing errors", async (context) => {
  useTwitterKey(context)
  context.mock.timers.enable({ apis: ["setTimeout"] })
  const fetchMock = context.mock.method(globalThis, "fetch", async (url, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener("abort", () => reject(new Error("twitter-test-key private-query")), { once: true })
  }))

  for (const timeoutMs of [undefined, 100]) {
    const pending = rejectsSafely(fetchTweetPage("private-query", "", { timeoutMs }), "Twitter request timed out")
    context.mock.timers.tick((timeoutMs ?? 15_000) - 1)
    assert.equal(fetchMock.mock.calls.at(-1).arguments[1].signal.aborted, false)
    context.mock.timers.tick(1)
    await pending
    assert.equal(fetchMock.mock.calls.at(-1).arguments[1].signal.aborted, true)
  }
})

test("keeps the timeout active until the Twitter response body has been read", async (context) => {
  useTwitterKey(context)
  context.mock.timers.enable({ apis: ["setTimeout"] })
  let started
  const reading = new Promise((resolve) => {
    started = resolve
  })
  context.mock.method(globalThis, "fetch", async (url, { signal }) => ({
    ok: true,
    text: () => new Promise((resolve, reject) => {
      signal.addEventListener("abort", () => reject(new Error("private-response")), { once: true })
      started()
    }),
  }))

  const pending = rejectsSafely(fetchTweetPage("private-query", "", { timeoutMs: 100 }), "Twitter request timed out")
  await reading
  context.mock.timers.tick(100)
  await pending
})

test("sanitizes Twitter HTTP, JSON and transport errors and clears their timers", async (context) => {
  useTwitterKey(context)
  context.mock.timers.enable({ apis: ["setTimeout"] })
  const fetchMock = context.mock.method(globalThis, "fetch", async () => new Response("private-response twitter-test-key", {
    status: 429,
    statusText: "private-response twitter-test-key",
  }))

  await rejectsSafely(fetchTweetPage("private-query"), "Twitter API error: 429 Too Many Requests")
  fetchMock.mock.mockImplementation(async () => new Response("private-response twitter-test-key"))
  await rejectsSafely(fetchTweetPage("private-query"), "Twitter invalid JSON")

  for (const failure of [new Error("twitter-test-key private-query"), { message: "private-response" }, "private-response"]) {
    fetchMock.mock.mockImplementation(async () => {
      throw failure
    })
    await rejectsSafely(fetchTweetPage("private-query"), "Twitter transport failure")
  }
  context.mock.timers.tick(15_000)
  assert.ok(fetchMock.mock.calls.every(({ arguments: [, { signal }] }) => !signal.aborted))
})
