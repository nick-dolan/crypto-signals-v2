import assert from "node:assert/strict"
import test from "node:test"
import { setImmediate } from "node:timers/promises"
import { inspect } from "node:util"
import { fetchTweetPage } from "../src/api/twitter-api.js"
import { createRequestRateLimiter } from "../src/helpers/request-rate-limiter.js"

function mockTwitter (t, implementation) {
  const originalKey = process.env.TWITTERAPI_IO_KEY
  process.env.TWITTERAPI_IO_KEY = "test-twitter-key"
  t.after(() => {
    if (originalKey === undefined) {
      delete process.env.TWITTERAPI_IO_KEY
    } else {
      process.env.TWITTERAPI_IO_KEY = originalKey
    }
  })
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.UTC(2026, 0, 1) })

  const requestLimiter = {
    run: t.mock.fn(callback => callback()),
    pause: t.mock.fn(),
  }
  const request = t.mock.method(globalThis, "fetch", implementation)
  return { request, requestLimiter }
}

function safeError (message) {
  return (error) => {
    assert.equal(error.message, message)
    assert.equal(error.cause, undefined)
    assert.doesNotMatch(inspect(error), /test-twitter-key|private-query|private-cursor|private-body|private-cause/)
    return true
  }
}

function waitForAbort (signal) {
  return new Promise((resolve, reject) => {
    signal.addEventListener("abort", () => reject(new Error("private-cause test-twitter-key private-query")), { once: true })
  })
}

test("Twitter retries a request timeout once with a fresh signal and defaults to 30 seconds", async (t) => {
  const signals = []
  const { request, requestLimiter } = mockTwitter(t, async (url, { signal }) => {
    signals.push(signal)
    return signals.length === 1 ? waitForAbort(signal) : Response.json({ tweets: [] })
  })

  const page = fetchTweetPage("private-query", "private-cursor", { requestLimiter })
  t.mock.timers.tick(29_999)
  assert.equal(request.mock.callCount(), 1)
  assert.equal(signals[0].aborted, false)
  t.mock.timers.tick(1)

  assert.deepEqual(await page, { tweets: [] })
  assert.equal(request.mock.callCount(), 2)
  assert.notEqual(signals[0], signals[1])
  assert.equal(signals[0].aborted, true)
  assert.deepEqual(requestLimiter.pause.mock.calls.map(call => call.arguments), [[1_000]])
  assert.equal(request.mock.calls[0].arguments[0], request.mock.calls[1].arguments[0])
  assert.equal(request.mock.calls[1].arguments[1].headers["X-API-Key"], "test-twitter-key")
  assert.equal(request.mock.calls[1].arguments[1].redirect, "manual")
  t.mock.timers.tick(30_000)
  assert.equal(signals[1].aborted, false)
})

test("Twitter stops after two response-body timeouts without exposing their causes", async (t) => {
  const { request, requestLimiter } = mockTwitter(t, async (url, { signal }) => ({
    ok: true,
    text: () => waitForAbort(signal),
  }))

  const rejection = assert.rejects(
    fetchTweetPage("private-query", "", { timeoutMs: 25, requestLimiter }),
    safeError("Twitter request timed out"),
  )
  await setImmediate()
  t.mock.timers.tick(25)
  await setImmediate()
  assert.equal(request.mock.callCount(), 2)
  t.mock.timers.tick(25)
  await rejection

  assert.deepEqual(requestLimiter.pause.mock.calls.map(call => call.arguments), [[1_000]])
  assert.ok(request.mock.calls.every(call => call.arguments[1].signal.aborted))
})

test("Twitter retries HTTP 502, 503 and 504 and cancels the failed response body", async (t) => {
  for (const status of [502, 503, 504]) {
    await t.test(String(status), async (t) => {
      const failed = new Response("private-body", { status })
      const responses = [failed, Response.json({ tweets: [] })]
      const { request, requestLimiter } = mockTwitter(t, async () => responses.shift())

      assert.deepEqual(await fetchTweetPage("private-query", "", { requestLimiter }), { tweets: [] })
      assert.equal(request.mock.callCount(), 2)
      assert.equal(failed.bodyUsed, true)
      assert.deepEqual(requestLimiter.pause.mock.calls.map(call => call.arguments), [[1_000]])
      t.mock.timers.tick(60_000)
      assert.ok(request.mock.calls.every(call => !call.arguments[1].signal.aborted))
    })
  }
})

test("Twitter shares one retry budget across transient HTTP statuses", async (t) => {
  const responses = [502, 504].map(status => new Response("private-body", { status }))
  let attempt = 0
  const { request, requestLimiter } = mockTwitter(t, async () => responses[attempt++])

  await assert.rejects(
    fetchTweetPage("private-query", "", { requestLimiter }),
    safeError("Twitter API error: 504 Gateway Timeout"),
  )
  assert.equal(request.mock.callCount(), 2)
  assert.ok(responses.every(response => response.bodyUsed))
  assert.deepEqual(requestLimiter.pause.mock.calls.map(call => call.arguments), [[1_000]])
  t.mock.timers.tick(60_000)
  assert.ok(request.mock.calls.every(call => !call.arguments[1].signal.aborted))
})

test("Twitter does not retry auth, invalid JSON, unrelated HTTP, transport or programming errors", async (t) => {
  for (const [name, response, message] of [
    ["401", () => new Response("private-body", { status: 401 }), "Twitter API error: 401 Unauthorized"],
    ["403", () => new Response("private-body", { status: 403 }), "Twitter API error: 403 Forbidden"],
    ["500", () => new Response("private-body", { status: 500 }), "Twitter API error: 500 Internal Server Error"],
    ["invalid JSON", () => new Response("private-body test-twitter-key private-query"), "Twitter invalid JSON"],
    ["transport", () => {
      throw new TypeError("private-cause", { cause: new Error("test-twitter-key private-query") })
    }, "Twitter transport failure"],
    ["programming", () => {
      throw new ReferenceError("private-cause test-twitter-key")
    }, "Twitter transport failure"],
    ["unrelated timeout", () => {
      throw new DOMException("private-cause", "TimeoutError")
    }, "Twitter transport failure"],
    ["body cancellation failure", () => ({
      ok: false,
      status: 401,
      body: {
        cancel: async () => {
          throw new Error("private-cause test-twitter-key")
        },
      },
    }), "Twitter API error: 401 Unauthorized"],
  ]) {
    await t.test(name, async (t) => {
      const { request, requestLimiter } = mockTwitter(t, async () => response())
      await assert.rejects(fetchTweetPage("private-query", "private-cursor", { requestLimiter }), safeError(message))
      assert.equal(request.mock.callCount(), 1)
      assert.equal(requestLimiter.pause.mock.callCount(), 0)
      const signal = request.mock.calls[0].arguments[1].signal
      const aborted = signal.aborted
      t.mock.timers.tick(60_000)
      assert.equal(signal.aborted, aborted)
    })
  }
})

test("Twitter preserves Retry-After and two independent 429 retries", async (t) => {
  for (const { name, statuses, retryAfter, pauses, error } of [
    { name: "seconds", statuses: [429, 429, 200], retryAfter: "2", pauses: [2_000, 2_000] },
    { name: "HTTP date", statuses: [429, 200], retryAfter: "Thu, 01 Jan 2026 00:00:03 GMT", pauses: [3_000] },
    { name: "independent retry budgets", statuses: [503, 429, 429, 200], pauses: [1_000, 1_000, 2_000] },
    { name: "exhaustion", statuses: [429, 429, 429], pauses: [1_000, 2_000, 4_000], error: "Twitter API error: 429 Too Many Requests" },
  ]) {
    await t.test(name, async (t) => {
      const responses = statuses.map(status => status === 200
        ? Response.json({ tweets: [] })
        : new Response("private-body", { status, headers: retryAfter ? { "Retry-After": retryAfter } : {} }))
      let attempt = 0
      const { request, requestLimiter } = mockTwitter(t, async () => responses[attempt++])

      const page = fetchTweetPage("private-query", "", { requestLimiter })
      if (error) {
        await assert.rejects(page, safeError(error))
      } else {
        assert.deepEqual(await page, { tweets: [] })
      }
      assert.equal(request.mock.callCount(), statuses.length)
      assert.deepEqual(requestLimiter.pause.mock.calls.map(call => call.arguments[0]), pauses)
      assert.ok(responses.filter(response => !response.ok).every(response => response.bodyUsed))
      t.mock.timers.tick(60_000)
      assert.ok(request.mock.calls.every(call => !call.arguments[1].signal.aborted))
    })
  }
})

test("Twitter rejects long Retry-After cooldowns and shares them with subsequent requests", async (t) => {
  const response = new Response("private-body", { status: 429, headers: { "Retry-After": "61" } })
  const { request } = mockTwitter(t, async () => response)
  const requestLimiter = createRequestRateLimiter()

  await assert.rejects(fetchTweetPage("private-query", "", { requestLimiter }), safeError("Twitter API error: 429 Too Many Requests"))
  await assert.rejects(fetchTweetPage("another-private-query", "", { requestLimiter }), safeError("Twitter API error: 429 Too Many Requests"))
  assert.equal(request.mock.callCount(), 1)
  assert.equal(response.bodyUsed, true)
  t.mock.timers.tick(60_000)
  assert.equal(request.mock.calls[0].arguments[1].signal.aborted, false)
})
