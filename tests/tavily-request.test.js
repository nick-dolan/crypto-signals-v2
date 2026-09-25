import assert from "node:assert/strict"
import test, { beforeEach } from "node:test"
import { inspect } from "node:util"
import { requestTavilyJson } from "../src/api/tavily/request.js"

beforeEach((context) => {
  const previousApiKey = process.env.TAVILY_API_KEY
  process.env.TAVILY_API_KEY = "tavily-test-key"

  context.after(() => {
    if (previousApiKey === undefined) {
      delete process.env.TAVILY_API_KEY
    } else {
      process.env.TAVILY_API_KEY = previousApiKey
    }
  })
})

function rejectsSafely (promise, message) {
  return assert.rejects(promise, (error) => {
    assert.equal(error.message, message)
    assert.equal(error.cause, undefined)

    for (const value of ["tavily-test-key", "private-query", "private-response"]) {
      assert.equal(inspect(error, { showHidden: true }).includes(value), false)
    }

    return true
  })
}

test("Tavily sends an authenticated JSON POST to search and releases its timer", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] })
  process.env.TAVILY_API_KEY = "  tavily-test-key  "
  const body = { query: "новая монета & ETH/+?#=", max_results: 5, include_raw_content: false }
  const payload = { results: [{ title: "Coin website", url: "https://example.com/coin" }] }
  const fetchMock = context.mock.method(globalThis, "fetch", async () => (
    new Response(JSON.stringify(payload))
  ))

  assert.deepEqual(await requestTavilyJson("/search", body), payload)

  const [url, options] = fetchMock.mock.calls[0].arguments
  assert.equal(String(url), "https://api.tavily.com/search")
  assert.equal(options.method, "POST")
  assert.equal(options.redirect, "manual")
  assert.deepEqual(Object.fromEntries(new Headers(options.headers)), {
    "accept": "application/json",
    "authorization": "Bearer tavily-test-key",
    "content-type": "application/json",
  })
  assert.equal(options.body, JSON.stringify(body))
  assert.equal(options.signal instanceof AbortSignal, true)
  assert.equal(fetchMock.mock.callCount(), 1)

  context.mock.timers.tick(30_000)
  assert.equal(options.signal.aborted, false)
})

test("Tavily posts extract URLs and returns empty results with failed_results unchanged", async (context) => {
  const body = { urls: ["https://example.com/coin", "https://example.com/token"] }
  const payload = {
    results: [],
    failed_results: body.urls.map(url => ({ url, error: "Could not extract content" })),
  }
  const fetchMock = context.mock.method(globalThis, "fetch", async () => (
    new Response(JSON.stringify(payload), { status: 200 })
  ))

  assert.deepEqual(await requestTavilyJson("/extract", body), payload)

  const [url, options] = fetchMock.mock.calls[0].arguments
  assert.equal(String(url), "https://api.tavily.com/extract")
  assert.equal(options.method, "POST")
  assert.equal(options.redirect, "manual")
  assert.equal(new Headers(options.headers).get("authorization"), "Bearer tavily-test-key")
  assert.equal(options.body, JSON.stringify(body))
  assert.equal(fetchMock.mock.callCount(), 1)
})

test("Tavily leaves JSON response semantics to the tools", async (context) => {
  const fetchMock = context.mock.method(globalThis, "fetch", async () => assert.fail("Unexpected fetch"))

  for (const payload of [null, [], false, 0, "text", { results: [] }, { error: "No results" }]) {
    fetchMock.mock.mockImplementation(async () => new Response(JSON.stringify(payload)))
    assert.deepEqual(await requestTavilyJson("/search", {}), payload)
  }
})

test("Tavily requires a nonempty key before starting a request or timer", async (context) => {
  const fetchMock = context.mock.method(globalThis, "fetch", async () => assert.fail("Unexpected fetch"))
  const timeoutMock = context.mock.method(globalThis, "setTimeout")

  for (const apiKey of [undefined, "", " \n\t "]) {
    if (apiKey === undefined) {
      delete process.env.TAVILY_API_KEY
    } else {
      process.env.TAVILY_API_KEY = apiKey
    }

    await rejectsSafely(requestTavilyJson("/search", { query: "private-query" }), "Tavily /search API key is required")
  }

  assert.equal(fetchMock.mock.callCount(), 0)
  assert.equal(timeoutMock.mock.callCount(), 0)
})

test("Tavily rejects all non-allowlisted endpoints without sending or exposing the key", async (context) => {
  const fetchMock = context.mock.method(globalThis, "fetch", async () => assert.fail("Unexpected fetch"))
  const timeoutMock = context.mock.method(globalThis, "setTimeout")

  for (const endpoint of [
    undefined, null, "", " ", 42, [], {},
    "search", "extract", "/search/", "/SEARCH", " /search", "/extract ",
    "https://example.com/tavily-test-key",
    "https://api.tavily.com/search",
    "//example.com/search",
    "///example.com/search",
    "/\\example.com/search",
    "https:\t//example.com/search",
    "data:application/json,tavily-test-key",
    "/../search",
    "/%2e%2e/search",
    "/search/../extract",
    "/%73earch",
    "/search?api_key=tavily-test-key",
    "/extract#tavily-test-key",
    { toString: () => "/search" },
  ]) {
    await rejectsSafely(requestTavilyJson(endpoint, {}), "Tavily endpoint must be /search or /extract")
  }

  assert.equal(fetchMock.mock.callCount(), 0)
  assert.equal(timeoutMock.mock.callCount(), 0)
})

test("Tavily validates a plain object body and positive finite timeout before fetch", async (context) => {
  const fetchMock = context.mock.method(globalThis, "fetch", async () => assert.fail("Unexpected fetch"))
  const timeoutMock = context.mock.method(globalThis, "setTimeout")

  for (const body of [
    undefined, null, [], "private-query", 42, true,
    new Date(), new URLSearchParams(), new class Coin {}(),
    Object.create({ query: "private-query" }),
  ]) {
    await rejectsSafely(requestTavilyJson("/search", body), "Tavily /search body must be a plain object")
  }

  for (const timeoutMs of [0, -1, "10", NaN, Infinity, -Infinity, null, true, {}, 10n]) {
    await rejectsSafely(
      requestTavilyJson("/extract", { urls: [] }, { timeoutMs }),
      "Tavily /extract timeoutMs must be a positive finite number",
    )
  }

  assert.equal(fetchMock.mock.callCount(), 0)
  assert.equal(timeoutMock.mock.callCount(), 0)
})

for (const status of [301, 302, 303, 307, 308, 400, 401, 403, 404, 429, 500, 503]) {
  test(`Tavily reports HTTP ${status} without redirects, retries, or response details`, async (context) => {
    context.mock.timers.enable({ apis: ["setTimeout"] })
    const response = new Response("private-response tavily-test-key", {
      status,
      statusText: "private-response tavily-test-key",
      headers: {
        "location": "https://example.com/collect-key",
        "retry-after": "1",
      },
    })
    const textMock = context.mock.method(response, "text")
    const fetchMock = context.mock.method(globalThis, "fetch", async () => response)

    await rejectsSafely(
      requestTavilyJson("/search", { query: "private-query" }),
      `Tavily /search HTTP ${status}`,
    )
    assert.equal(fetchMock.mock.callCount(), 1)
    assert.equal(fetchMock.mock.calls[0].arguments[1].redirect, "manual")
    assert.equal(textMock.mock.callCount(), 0)

    context.mock.timers.tick(30_000)
    assert.equal(fetchMock.mock.calls[0].arguments[1].signal.aborted, false)
  })
}

test("Tavily reports malformed JSON without leaking parser details and releases timers", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] })
  const fetchMock = context.mock.method(globalThis, "fetch", async () => assert.fail("Unexpected fetch"))

  for (const text of ["", "tavily-test-key private-response", "{\"key\":\"tavily-test-key\",", "<html>private-response</html>"]) {
    fetchMock.mock.mockImplementation(async () => new Response(text))
    await rejectsSafely(requestTavilyJson("/extract", { urls: [] }), "Tavily /extract invalid JSON")
  }

  assert.equal(fetchMock.mock.callCount(), 4)
  context.mock.timers.tick(30_000)
  assert.equal(fetchMock.mock.calls.every(({ arguments: [, { signal }] }) => !signal.aborted), true)
})

test("Tavily sanitizes transport failures of any type without retries and releases timers", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] })
  const fetchMock = context.mock.method(globalThis, "fetch", async () => assert.fail("Unexpected fetch"))

  for (const failure of [
    new TypeError("tavily-test-key private-query", { cause: new Error("private-response") }),
    new SyntaxError("tavily-test-key private-response"),
    new DOMException("tavily-test-key", "AbortError"),
    "tavily-test-key private-response",
    { message: "tavily-test-key private-response" },
  ]) {
    fetchMock.mock.mockImplementation(async () => {
      throw failure
    })
    await rejectsSafely(requestTavilyJson("/search", { query: "private-query" }), "Tavily /search transport failure")
  }

  assert.equal(fetchMock.mock.callCount(), 5)
  context.mock.timers.tick(30_000)
  assert.equal(fetchMock.mock.calls.every(({ arguments: [, { signal }] }) => !signal.aborted), true)
})

test("Tavily treats a failed body read as transport failure, not invalid JSON", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] })
  const fetchMock = context.mock.method(globalThis, "fetch", async () => new Response(new ReadableStream({
    start (controller) {
      controller.error(new SyntaxError("tavily-test-key private-response"))
    },
  })))

  await rejectsSafely(requestTavilyJson("/search", {}), "Tavily /search transport failure")
  assert.equal(fetchMock.mock.callCount(), 1)

  context.mock.timers.tick(30_000)
  assert.equal(fetchMock.mock.calls[0].arguments[1].signal.aborted, false)
})

test("Tavily sanitizes JSON serialization failures before fetch and releases timers", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] })
  const timeoutMock = context.mock.method(globalThis, "setTimeout")
  const clearTimeoutMock = context.mock.method(globalThis, "clearTimeout")
  const fetchMock = context.mock.method(globalThis, "fetch", async () => assert.fail("Unexpected fetch"))
  const circular = { query: "private-query" }
  circular["tavily-test-key"] = circular

  for (const body of [
    circular,
    { query: 1n },
    { get query () {
      throw new Error("tavily-test-key private-query")
    } },
    { toJSON () {
      throw new SyntaxError("tavily-test-key private-query")
    } },
  ]) {
    await rejectsSafely(requestTavilyJson("/search", body), "Tavily /search transport failure")
  }

  assert.equal(fetchMock.mock.callCount(), 0)
  assert.equal(clearTimeoutMock.mock.callCount(), 4)
  assert.deepEqual(
    clearTimeoutMock.mock.calls.map(({ arguments: [id] }) => id),
    timeoutMock.mock.calls.map(({ result }) => result),
  )
})

for (const timeoutMs of [30_000, 50]) {
  test(`Tavily aborts a pending request after ${timeoutMs} ms and clears its timer`, async (context) => {
    context.mock.timers.enable({ apis: ["setTimeout"] })
    const timeoutMock = context.mock.method(globalThis, "setTimeout")
    const clearTimeoutMock = context.mock.method(globalThis, "clearTimeout")
    const fetchMock = context.mock.method(globalThis, "fetch", async (_url, { signal }) => (
      new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("tavily-test-key private-query")), { once: true })
      })
    ))

    const rejected = rejectsSafely(
      requestTavilyJson("/search", {}, timeoutMs === 30_000 ? undefined : { timeoutMs }),
      "Tavily /search request timed out",
    )
    const signal = fetchMock.mock.calls[0].arguments[1].signal

    context.mock.timers.tick(timeoutMs - 1)
    assert.equal(signal.aborted, false)
    context.mock.timers.tick(1)
    await rejected

    assert.equal(signal.aborted, true)
    assert.equal(fetchMock.mock.callCount(), 1)
    assert.equal(clearTimeoutMock.mock.callCount(), 1)
    assert.equal(clearTimeoutMock.mock.calls[0].arguments[0], timeoutMock.mock.calls[0].result)
  })
}

test("Tavily timeout covers response body reads and clears its timer", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] })
  const clearTimeoutMock = context.mock.method(globalThis, "clearTimeout")
  const reading = Promise.withResolvers()
  const fetchMock = context.mock.method(globalThis, "fetch", async (_url, { signal }) => ({
    ok: true,
    status: 200,
    text () {
      reading.resolve()
      return new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("tavily-test-key private-response")), { once: true })
      })
    },
  }))

  const rejected = rejectsSafely(requestTavilyJson("/extract", { urls: [] }, { timeoutMs: 50 }), "Tavily /extract request timed out")
  await reading.promise
  context.mock.timers.tick(50)
  await rejected

  assert.equal(fetchMock.mock.calls[0].arguments[1].signal.aborted, true)
  assert.equal(fetchMock.mock.callCount(), 1)
  assert.equal(clearTimeoutMock.mock.callCount(), 1)
})
