import assert from "node:assert/strict"
import test from "node:test"
import { inspect } from "node:util"

import { fetchTweetPage } from "../src/api/twitter-api.js"
import { createRequestRateLimiter } from "../src/helpers/request-rate-limiter.js"

function setup (context) {
  const environment = process.env
  process.env = { TWITTERAPI_IO_KEY: "twitter-test-key" }
  context.after(() => {
    process.env = environment
  })
  context.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 0 })
  context.mock.method(performance, "now", () => Date.now())
  return createRequestRateLimiter()
}

function flush () {
  return new Promise(resolve => setImmediate(resolve))
}

async function tick (context, ms) {
  context.mock.timers.tick(ms)
  await flush()
}

function rejectsSafely (promise, message) {
  return assert.rejects(promise, (error) => {
    assert.equal(error.message, message)
    assert.equal(error.cause, undefined)
    assert.deepEqual(Object.getOwnPropertyNames(error).sort(), ["message", "stack"])
    for (const value of ["twitter-test-key", "private-query", "private-cursor", "private-response", "private-header"]) {
      assert.equal(inspect(error, { showHidden: true }).includes(value), false)
    }
    return true
  })
}

function rateLimited (retryAfter) {
  return new Response("private-response twitter-test-key", {
    status: 429,
    statusText: "private-response twitter-test-key",
    headers: {
      "x-private": "private-header",
      ...(retryAfter === undefined ? {} : { "retry-after": retryAfter }),
    },
  })
}

function assertTimersCleared (fetchMock) {
  assert.ok(fetchMock.mock.calls.every(({ arguments: [, { signal }] }) => !signal.aborted))
}

test("passes the fixed time window unchanged to the latest Twitter search page", async (context) => {
  const requestLimiter = setup(context)
  const fetchMock = context.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({
    tweets: [{ id: "tweet-1" }],
    next_cursor: "next-page",
  }), { headers: { "content-type": "application/json" } }))
  const result = await fetchTweetPage("$BTC since_time:1799913600 until_time:1800000001", "current-page", { requestLimiter })

  assert.equal(fetchMock.mock.callCount(), 1)
  const [requestUrl, options] = fetchMock.mock.calls[0].arguments
  const url = new URL(requestUrl)
  assert.equal(url.origin, "https://api.twitterapi.io")
  assert.equal(url.pathname, "/twitter/tweet/advanced_search")
  assert.equal(url.searchParams.get("query"), "$BTC since_time:1799913600 until_time:1800000001")
  assert.equal(url.searchParams.get("queryType"), "Latest")
  assert.equal(url.searchParams.get("cursor"), "current-page")
  assert.deepEqual(Object.keys(options).sort(), ["headers", "redirect", "signal"])
  assert.deepEqual(options.headers, { "X-API-Key": "twitter-test-key" })
  assert.equal(options.redirect, "manual")
  assert.deepEqual(result, { tweets: [{ id: "tweet-1" }], next_cursor: "next-page" })
})

test("requires a nonempty Twitter key without admission, HTTP or timers", async (context) => {
  setup(context)
  const fetchMock = context.mock.method(globalThis, "fetch", async () => assert.fail("Unexpected fetch"))
  const timerMock = context.mock.method(globalThis, "setTimeout")
  const requestLimiter = { run: context.mock.fn(() => assert.fail("Unexpected admission")) }

  for (const key of [undefined, "", " \n\t "]) {
    if (key === undefined) {
      delete process.env.TWITTERAPI_IO_KEY
    } else {
      process.env.TWITTERAPI_IO_KEY = key
    }
    await rejectsSafely(fetchTweetPage("private-query", "", { requestLimiter }), "Twitter API key is required")
  }
  assert.equal(fetchMock.mock.callCount(), 0)
  assert.equal(timerMock.mock.callCount(), 0)
  assert.equal(requestLimiter.run.mock.callCount(), 0)
})

test("validates Twitter timeouts before admission, HTTP or timers", async (context) => {
  setup(context)
  const fetchMock = context.mock.method(globalThis, "fetch", async () => assert.fail("Unexpected fetch"))
  const timerMock = context.mock.method(globalThis, "setTimeout")
  const requestLimiter = { run: context.mock.fn(() => assert.fail("Unexpected admission")) }

  for (const timeoutMs of [0, -1, NaN, Infinity, "10", null]) {
    await rejectsSafely(fetchTweetPage("private-query", "", { timeoutMs, requestLimiter }), "Twitter timeoutMs must be a positive finite number")
  }
  assert.equal(fetchMock.mock.callCount(), 0)
  assert.equal(timerMock.mock.callCount(), 0)
  assert.equal(requestLimiter.run.mock.callCount(), 0)
})

test("trims the key, prevents credential redirects and releases the timer after success", async (context) => {
  const requestLimiter = setup(context)
  process.env.TWITTERAPI_IO_KEY = "  twitter-test-key  "
  const fetchMock = context.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ tweets: [] })))

  assert.deepEqual(await fetchTweetPage("private-query", "", { requestLimiter }), { tweets: [] })
  const options = fetchMock.mock.calls[0].arguments[1]
  assert.equal(options.headers["X-API-Key"], "twitter-test-key")
  assert.equal(options.redirect, "manual")
  assert.equal(options.signal instanceof AbortSignal, true)
  await tick(context, 15_000)
  assertTimersCleared(fetchMock)
})

test("returns parsed JSON unchanged even when it resembles retry metadata", async (context) => {
  setup(context)
  const fetchMock = context.mock.method(globalThis, "fetch")

  for (const page of [null, false, 0, "text", [1, 2], { retry: true, page: { tweets: [] } }]) {
    fetchMock.mock.mockImplementation(async () => new Response(JSON.stringify(page)))
    assert.deepEqual(await fetchTweetPage("private-query", "", { requestLimiter: createRequestRateLimiter() }), page)
  }
  await tick(context, 15_000)
  assertTimersCleared(fetchMock)
})

test("aborts at the default or optional timeout without retries or exposed errors", async (context) => {
  const requestLimiter = setup(context)
  const fetchMock = context.mock.method(globalThis, "fetch", async (url, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener("abort", () => reject(new Error("twitter-test-key private-query")), { once: true })
  }))

  for (const timeoutMs of [undefined, 100]) {
    const pending = rejectsSafely(fetchTweetPage("private-query", "", { timeoutMs, requestLimiter }), "Twitter request timed out")
    await flush()
    await tick(context, (timeoutMs ?? 15_000) - 1)
    assert.equal(fetchMock.mock.calls.at(-1).arguments[1].signal.aborted, false)
    await tick(context, 1)
    await pending
    assert.equal(fetchMock.mock.calls.at(-1).arguments[1].signal.aborted, true)
  }
  await tick(context, 60_000)
  assert.equal(fetchMock.mock.callCount(), 2)
})

test("keeps the timeout active until the Twitter response body has been read", async (context) => {
  const requestLimiter = setup(context)
  const reading = Promise.withResolvers()
  const fetchMock = context.mock.method(globalThis, "fetch", async (url, { signal }) => ({
    ok: true,
    text: () => new Promise((resolve, reject) => {
      signal.addEventListener("abort", () => reject(new Error("private-response")), { once: true })
      reading.resolve()
    }),
  }))

  const pending = rejectsSafely(fetchTweetPage("private-query", "", { timeoutMs: 100, requestLimiter }), "Twitter request timed out")
  await reading.promise
  await tick(context, 100)
  await pending
  assert.equal(fetchMock.mock.callCount(), 1)
  assert.equal(fetchMock.mock.calls[0].arguments[1].signal.aborted, true)
})

test("does not create an attempt timeout during gate wait and recovers after an earlier timeout", async (context) => {
  const requestLimiter = setup(context)
  const timerMock = context.mock.method(globalThis, "setTimeout")
  const fetchMock = context.mock.method(globalThis, "fetch", async (url, { signal }) => {
    if (new URL(url).searchParams.get("query") === "first") {
      return new Promise((resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("private-response")), { once: true })
      })
    }
    return new Response(JSON.stringify({ tweets: [] }))
  })
  const first = rejectsSafely(fetchTweetPage("first", "", { timeoutMs: 50, requestLimiter }), "Twitter request timed out")
  const second = fetchTweetPage("second", "", { timeoutMs: 50, requestLimiter })

  await flush()
  assert.equal(fetchMock.mock.callCount(), 1)
  assert.deepEqual(timerMock.mock.calls.map(({ arguments: [, delay] }) => delay), [50, 100])
  await tick(context, 50)
  await first
  await tick(context, 49)
  assert.equal(fetchMock.mock.callCount(), 1)
  await tick(context, 1)
  assert.deepEqual(await second, { tweets: [] })
  const signals = fetchMock.mock.calls.map(({ arguments: [, { signal }] }) => signal)
  assert.equal(signals[0].aborted, true)
  assert.equal(signals[1].aborted, false)
  assert.notEqual(signals[0], signals[1])
  await tick(context, 15_000)
  assert.equal(signals[1].aborted, false)
})

for (const [name, retryAfter, starts] of [
  ["delay-seconds", "2", [0, 2_000, 4_000]],
  ["zero delay", "0", [0, 100, 200]],
  ["HTTP-date", new Date(3_000).toUTCString(), [0, 3_000, 3_100]],
  ["RFC850 HTTP-date", "Thursday, 01-Jan-70 00:00:03 GMT", [0, 3_000, 3_100]],
  ["asctime HTTP-date", "Thu Jan  1 00:00:03 1970", [0, 3_000, 3_100]],
  ["past HTTP-date", new Date(-1_000).toUTCString(), [0, 100, 200]],
  ["missing header", undefined, [0, 1_000, 3_000]],
  ["empty header", "", [0, 1_000, 3_000]],
  ["invalid header", "private-header", [0, 1_000, 3_000]],
  ["negative delay", "-1", [0, 1_000, 3_000]],
  ["fractional delay", "1.5", [0, 1_000, 3_000]],
  ["scientific notation", "1e3", [0, 1_000, 3_000]],
  ["invalid HTTP-date", "Sun, 99 Oct 2026 12:00:00 GMT", [0, 1_000, 3_000]],
  ["impossible calendar date", "Sun, 31 Feb 2027 12:00:00 GMT", [0, 1_000, 3_000]],
  ["impossible RFC850 date", "Sunday, 31-Feb-27 12:00:00 GMT", [0, 1_000, 3_000]],
  ["impossible asctime date", "Sun Feb 31 12:00:00 2027", [0, 1_000, 3_000]],
  ["non-leap February 29", "Sun, 29 Feb 2027 12:00:00 GMT", [0, 1_000, 3_000]],
  ["wrong weekday", "Fri, 01 Jan 1970 00:00:03 GMT", [0, 1_000, 3_000]],
  ["missing HTTP timezone", "Thu, 01 Jan 1970 00:00:03", [0, 1_000, 3_000]],
  ["non-HTTP date", "Jan 1 2099", [0, 1_000, 3_000]],
]) {
  test(`429 retries respect ${name}, preserve request content and use fresh cleared timers`, async (context) => {
    const requestLimiter = setup(context)
    const observed = []
    const fetchMock = context.mock.method(globalThis, "fetch", async () => {
      observed.push(Date.now())
      return observed.length < 3 ? rateLimited(retryAfter) : new Response(JSON.stringify({ tweets: [] }))
    })
    const pending = fetchTweetPage("private-query", "private-cursor", { timeoutMs: 50, requestLimiter })

    await flush()
    for (let index = 1; index < starts.length; index += 1) {
      await tick(context, starts[index] - Date.now() - 1)
      assert.equal(fetchMock.mock.callCount(), index)
      assertTimersCleared(fetchMock)
      await tick(context, 1)
    }
    assert.deepEqual(await pending, { tweets: [] })
    assert.deepEqual(observed, starts)
    const calls = fetchMock.mock.calls.map(({ arguments: [url, options] }) => ({ url, options }))
    assert.ok(calls.every(({ url, options }) => url === calls[0].url && options.redirect === "manual" && options.headers["X-API-Key"] === "twitter-test-key"))
    assert.equal(new Set(calls.map(({ options }) => options.signal)).size, 3)
    assert.equal(new URL(calls[0].url).searchParams.get("query"), "private-query")
    assert.equal(new URL(calls[0].url).searchParams.get("cursor"), "private-cursor")
    await tick(context, 15_000)
    assertTimersCleared(fetchMock)
    assert.equal(fetchMock.mock.callCount(), 3)
  })
}

for (const retryAfter of [
  "Sun, 11 Oct 2026 12:00:05 GMT",
  "Sunday, 11-Oct-26 12:00:05 GMT",
  "Sun Oct 11 12:00:05 2026",
]) {
  test(`HTTP-date ${retryAfter} uses UTC even in a non-UTC process timezone`, async (context) => {
    const environment = process.env
    const timezone = environment.TZ
    environment.TZ = "Europe/Moscow"
    const requestLimiter = setup(context)
    context.after(() => {
      if (timezone === undefined) {
        delete environment.TZ
      } else {
        environment.TZ = timezone
      }
    })
    const now = Date.parse("2026-10-11T12:00:00Z")
    context.mock.timers.setTime(now)
    assert.equal(new Date(now).getTimezoneOffset(), -180)
    const starts = []
    const fetchMock = context.mock.method(globalThis, "fetch", async () => {
      starts.push(Date.now() - now)
      return starts.length < 3 ? rateLimited(retryAfter) : new Response(JSON.stringify({ tweets: [] }))
    })
    const pending = fetchTweetPage("private-query", "private-cursor", { timeoutMs: 50, requestLimiter })

    await flush()
    await tick(context, 4_999)
    assert.equal(fetchMock.mock.callCount(), 1)
    assertTimersCleared(fetchMock)
    await tick(context, 1)
    assert.equal(fetchMock.mock.callCount(), 2)
    await tick(context, 99)
    assert.equal(fetchMock.mock.callCount(), 2)
    await tick(context, 1)
    assert.deepEqual(await pending, { tweets: [] })
    assert.deepEqual(starts, [0, 5_000, 5_100])
    await tick(context, 15_000)
    assertTimersCleared(fetchMock)
  })
}

for (const [now, retryAfter, deadline] of [
  ["2026-10-11T12:00:00Z", "Sunday, 11-Oct-76 12:00:00 GMT", "2076-10-11T12:00:00Z"],
  ["2026-10-11T12:00:00Z", "Tuesday, 11-Oct-77 12:00:00 GMT", "1977-10-11T12:00:00Z"],
  ["2095-10-11T12:00:00Z", "Saturday, 11-Oct-10 12:00:00 GMT", "2110-10-11T12:00:00Z"],
]) {
  test(`RFC850 two-digit year respects the 50-year window: ${retryAfter}`, async (context) => {
    const requestLimiter = setup(context)
    context.mock.timers.setTime(Date.parse(now))
    const pauseMock = context.mock.method(requestLimiter, "pause")
    const fetchMock = context.mock.method(globalThis, "fetch", async () => rateLimited(retryAfter))
    const pending = rejectsSafely(fetchTweetPage("private-query", "", { requestLimiter }), "Twitter API error: 429 Too Many Requests")

    await flush()
    const delayMs = Math.max(0, Date.parse(deadline) - Date.now())
    assert.equal(pauseMock.mock.calls[0].arguments[0], delayMs)
    if (delayMs === 0) {
      await tick(context, 100)
      await tick(context, 100)
    }
    await pending
    assert.equal(fetchMock.mock.callCount(), delayMs === 0 ? 3 : 1)
    assertTimersCleared(fetchMock)
  })
}

test("a retry gets its own full timeout after cooldown and is not retried when it times out", async (context) => {
  const requestLimiter = setup(context)
  let calls = 0
  const fetchMock = context.mock.method(globalThis, "fetch", async (url, { signal }) => {
    calls += 1
    if (calls === 1) {
      return rateLimited("1")
    }
    return new Promise((resolve, reject) => {
      signal.addEventListener("abort", () => reject(new Error("private-response twitter-test-key")), { once: true })
    })
  })
  const pending = rejectsSafely(fetchTweetPage("private-query", "", { timeoutMs: 50, requestLimiter }), "Twitter request timed out")

  await flush()
  await tick(context, 999)
  assert.equal(fetchMock.mock.callCount(), 1)
  assertTimersCleared(fetchMock)
  await tick(context, 1)
  assert.equal(fetchMock.mock.callCount(), 2)
  const signals = fetchMock.mock.calls.map(({ arguments: [, { signal }] }) => signal)
  assert.notEqual(signals[0], signals[1])
  await tick(context, 49)
  assert.equal(signals[1].aborted, false)
  await tick(context, 1)
  await pending
  assert.equal(signals[0].aborted, false)
  assert.equal(signals[1].aborted, true)
  await tick(context, 60_000)
  assert.equal(fetchMock.mock.callCount(), 2)
})

test("429 stops after two retries, sanitizes the error and keeps the last cooldown shared", async (context) => {
  const requestLimiter = setup(context)
  const starts = []
  const fetchMock = context.mock.method(globalThis, "fetch", async (url) => {
    starts.push(Date.now())
    return new URL(url).searchParams.get("query") === "private-query"
      ? rateLimited()
      : new Response(JSON.stringify({ tweets: [] }))
  })
  const pending = rejectsSafely(fetchTweetPage("private-query", "private-cursor", { requestLimiter }), "Twitter API error: 429 Too Many Requests")

  await flush()
  await tick(context, 1_000)
  await tick(context, 2_000)
  await pending
  assert.deepEqual(starts, [0, 1_000, 3_000])
  assert.equal(fetchMock.mock.callCount(), 3)
  const next = fetchTweetPage("next", "", { requestLimiter })
  await flush()
  await tick(context, 3_999)
  assert.equal(fetchMock.mock.callCount(), 3)
  await tick(context, 1)
  assert.deepEqual(await next, { tweets: [] })
  assert.deepEqual(starts, [0, 1_000, 3_000, 7_000])
  await tick(context, 60_000)
  assert.equal(fetchMock.mock.callCount(), 4)
  assertTimersCleared(fetchMock)
})

test("shared 429 cooldown includes queued requests and retries and is extended by another in-flight response", async (context) => {
  const requestLimiter = setup(context)
  const firstResponse = Promise.withResolvers()
  const secondResponse = Promise.withResolvers()
  const starts = []
  const seen = new Set()
  const fetchMock = context.mock.method(globalThis, "fetch", async (url) => {
    const query = new URL(url).searchParams.get("query")
    starts.push({ query, time: Date.now() })
    if (!seen.has(query)) {
      seen.add(query)
      if (query === "first") {
        return firstResponse.promise
      }
      if (query === "second") {
        return secondResponse.promise
      }
    }
    return new Response(JSON.stringify({ tweets: [] }))
  })
  const pending = Promise.all(["first", "second", "queued"].map(query => fetchTweetPage(query, "", { requestLimiter })))

  await flush()
  await tick(context, 100)
  assert.deepEqual(starts, [{ query: "first", time: 0 }, { query: "second", time: 100 }])
  firstResponse.resolve(rateLimited("1"))
  await flush()
  await tick(context, 400)
  secondResponse.resolve(rateLimited("2"))
  await flush()
  await tick(context, 600)
  assert.equal(starts.length, 2)
  await tick(context, 1_399)
  assert.equal(starts.length, 2)
  assertTimersCleared(fetchMock)
  await tick(context, 1)
  await tick(context, 100)
  await tick(context, 100)
  assert.deepEqual(await pending, Array.from({ length: 3 }, () => ({ tweets: [] })))
  assert.deepEqual(starts, [
    { query: "first", time: 0 },
    { query: "second", time: 100 },
    { query: "queued", time: 2_500 },
    { query: "first", time: 2_600 },
    { query: "second", time: 2_700 },
  ])
  await tick(context, 15_000)
  assertTimersCleared(fetchMock)
})

for (const [name, retryAfter] of [
  ["delay-seconds", "61"],
  ["HTTP-date", new Date(61_000).toUTCString()],
]) {
  test(`429 with ${name} over 60s rejects promptly without admitting other requests early`, async (context) => {
    const requestLimiter = setup(context)
    let calls = 0
    const fetchMock = context.mock.method(globalThis, "fetch", async () => {
      calls += 1
      return calls === 1 ? rateLimited(retryAfter) : new Response(JSON.stringify({ tweets: [] }))
    })
    const rejected = Promise.all(["private-query", "queued"].map(query => rejectsSafely(
      fetchTweetPage(query, "private-cursor", { requestLimiter }), "Twitter API error: 429 Too Many Requests",
    )))

    await rejected
    assert.equal(Date.now(), 0)
    assert.equal(fetchMock.mock.callCount(), 1)
    await tick(context, 60_000)
    assert.equal(fetchMock.mock.callCount(), 1)
    const next = fetchTweetPage("next", "", { requestLimiter })
    await flush()
    await tick(context, 999)
    assert.equal(fetchMock.mock.callCount(), 1)
    await tick(context, 1)
    assert.deepEqual(await next, { tweets: [] })
    assert.equal(fetchMock.mock.callCount(), 2)
    await tick(context, 15_000)
    assertTimersCleared(fetchMock)
  })
}

test("an extremely large valid Retry-After does not overflow into an early retry or long timer", async (context) => {
  const requestLimiter = setup(context)
  const fetchMock = context.mock.method(globalThis, "fetch", async () => rateLimited("9".repeat(400)))
  const timerMock = context.mock.method(globalThis, "setTimeout")

  await rejectsSafely(fetchTweetPage("private-query", "", { requestLimiter }), "Twitter API error: 429 Too Many Requests")
  await tick(context, 70_000)
  await rejectsSafely(fetchTweetPage("next", "", { requestLimiter }), "Twitter API error: 429 Too Many Requests")
  assert.equal(fetchMock.mock.callCount(), 1)
  assert.deepEqual(timerMock.mock.calls.map(({ arguments: [, delay] }) => delay), [15_000])
  assertTimersCleared(fetchMock)
})

test("a valid Retry-After of exactly 60s is honored without counting the wait toward timeout", async (context) => {
  const requestLimiter = setup(context)
  let calls = 0
  const fetchMock = context.mock.method(globalThis, "fetch", async () => {
    calls += 1
    return calls === 1 ? rateLimited("60") : new Response(JSON.stringify({ tweets: [] }))
  })
  const pending = fetchTweetPage("private-query", "", { timeoutMs: 50, requestLimiter })

  await flush()
  await tick(context, 59_999)
  assert.equal(fetchMock.mock.callCount(), 1)
  assertTimersCleared(fetchMock)
  await tick(context, 1)
  assert.deepEqual(await pending, { tweets: [] })
  assert.equal(fetchMock.mock.callCount(), 2)
  await tick(context, 15_000)
  assertTimersCleared(fetchMock)
})

for (const [status, statusText] of [
  [302, "Found"],
  [401, "Unauthorized"],
  [408, "Request Timeout"],
  [500, "Internal Server Error"],
  [503, "Service Unavailable"],
  [599, "HTTP error"],
]) {
  test(`HTTP ${status} is sanitized without retries or reading its body`, async (context) => {
    const requestLimiter = setup(context)
    const text = context.mock.fn(() => assert.fail("Must not read error body"))
    const fetchMock = context.mock.method(globalThis, "fetch", async () => ({
      ok: false,
      status,
      statusText: "private-response twitter-test-key",
      headers: new Headers({ "retry-after": "1", "x-private": "private-header" }),
      text,
    }))

    await rejectsSafely(fetchTweetPage("private-query", "private-cursor", { requestLimiter }), `Twitter API error: ${status} ${statusText}`)
    await tick(context, 60_000)
    assert.equal(fetchMock.mock.callCount(), 1)
    assert.equal(text.mock.callCount(), 0)
    assertTimersCleared(fetchMock)
  })
}

test("JSON, transport and response-body failures are sanitized without retries and clear timers", async (context) => {
  setup(context)
  const fetchMock = context.mock.method(globalThis, "fetch", async () => new Response("private-response twitter-test-key"))

  await rejectsSafely(fetchTweetPage("private-query", "", { requestLimiter: createRequestRateLimiter() }), "Twitter invalid JSON")
  for (const failure of [new Error("twitter-test-key private-query"), { message: "private-response" }, "private-response"]) {
    fetchMock.mock.mockImplementation(async () => {
      throw failure
    })
    await rejectsSafely(fetchTweetPage("private-query", "", { requestLimiter: createRequestRateLimiter() }), "Twitter transport failure")
  }
  fetchMock.mock.mockImplementation(async () => ({
    ok: true,
    text: async () => {
      throw new Error("private-response private-header")
    },
  }))
  await rejectsSafely(fetchTweetPage("private-query", "", { requestLimiter: createRequestRateLimiter() }), "Twitter transport failure")
  await tick(context, 60_000)
  assert.equal(fetchMock.mock.callCount(), 5)
  assertTimersCleared(fetchMock)
})

test("the default singleton gates both pages from separate producers and the summary, including retries", async (context) => {
  setup(context)
  const starts = []
  let limited = false
  const fetchMock = context.mock.method(globalThis, "fetch", async (url) => {
    const params = new URL(url).searchParams
    const query = params.get("query")
    const cursor = params.get("cursor")
    starts.push({ query, cursor, time: Date.now() })
    if (query === "coin-A" && !limited) {
      limited = true
      return rateLimited("1")
    }
    return new Response(JSON.stringify({ tweets: [], next_cursor: "second-page" }))
  })
  const pending = Promise.all(["coin-A", "coin-B", "summary"].map(async (query) => {
    const first = await fetchTweetPage(query)
    return fetchTweetPage(query, first.next_cursor)
  }))

  await flush()
  assert.equal(fetchMock.mock.callCount(), 1)
  await tick(context, 999)
  assert.equal(fetchMock.mock.callCount(), 1)
  await tick(context, 1)
  for (let index = 0; index < 5; index += 1) {
    await tick(context, 100)
  }
  assert.deepEqual(await pending, Array.from({ length: 3 }, () => ({ tweets: [], next_cursor: "second-page" })))
  assert.deepEqual(starts, [
    { query: "coin-A", cursor: "", time: 0 },
    { query: "coin-B", cursor: "", time: 1_000 },
    { query: "summary", cursor: "", time: 1_100 },
    { query: "coin-A", cursor: "", time: 1_200 },
    { query: "coin-B", cursor: "second-page", time: 1_300 },
    { query: "summary", cursor: "second-page", time: 1_400 },
    { query: "coin-A", cursor: "second-page", time: 1_500 },
  ])
  await tick(context, 15_000)
  assertTimersCleared(fetchMock)
})
