import assert from "node:assert/strict"
import test, { beforeEach } from "node:test"
import { requestCoinGeckoJson } from "../src/api/coingecko/request.js"

beforeEach((context) => {
  const previousApiKey = process.env.COINGECKO_API_KEY
  delete process.env.COINGECKO_API_KEY

  context.after(() => {
    if (previousApiKey === undefined) {
      delete process.env.COINGECKO_API_KEY
    } else {
      process.env.COINGECKO_API_KEY = previousApiKey
    }
  })
})

test("CoinGecko builds a public GET request, encodes query values and returns JSON", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] })
  const payload = { coins: [{ id: "bitcoin" }] }
  const fetchMock = context.mock.method(globalThis, "fetch", async () => (
    new Response(JSON.stringify(payload))
  ))

  assert.deepEqual(await requestCoinGeckoJson("/search/trending", {
    searchParams: {
      query: "биткоин & ETH/+?#=",
      limit: 10,
      localization: false,
      tags: ["first", "second", null, undefined],
      ignored: undefined,
      empty: null,
    },
  }), payload)

  const [input, options] = fetchMock.mock.calls[0].arguments
  const url = new URL(input)
  assert.equal(url.origin, "https://api.coingecko.com")
  assert.equal(url.pathname, "/api/v3/search/trending")
  assert.equal(url.hash, "")
  assert.equal(url.searchParams.get("query"), "биткоин & ETH/+?#=")
  assert.equal(url.searchParams.get("limit"), "10")
  assert.equal(url.searchParams.get("localization"), "false")
  assert.deepEqual(url.searchParams.getAll("tags"), ["first", "second"])
  assert.equal(url.searchParams.has("ignored"), false)
  assert.equal(url.searchParams.has("empty"), false)
  assert.equal(options.method, "GET")
  assert.equal(options.redirect, "manual")
  assert.deepEqual(Object.fromEntries(new Headers(options.headers)), { accept: "application/json" })
  assert.equal(options.signal instanceof AbortSignal, true)
  assert.equal(fetchMock.mock.callCount(), 1)

  context.mock.timers.tick(20_000)
  assert.equal(options.signal.aborted, false)
})

test("CoinGecko resolves internal endpoints with or without a leading slash", async (context) => {
  const fetchMock = context.mock.method(globalThis, "fetch", async () => new Response("{}"))

  for (const endpoint of ["search/trending", "/coins/bitcoin", "/derivatives/exchanges/binance_futures"]) {
    await requestCoinGeckoJson(endpoint)
  }

  assert.deepEqual(fetchMock.mock.calls.map(({ arguments: [url] }) => String(url)), [
    "https://api.coingecko.com/api/v3/search/trending",
    "https://api.coingecko.com/api/v3/coins/bitcoin",
    "https://api.coingecko.com/api/v3/derivatives/exchanges/binance_futures",
  ])
})

test("CoinGecko accepts URLSearchParams and preserves existing query parameters", async (context) => {
  const fetchMock = context.mock.method(globalThis, "fetch", async () => new Response("[]"))

  assert.deepEqual(await requestCoinGeckoJson("/coins/bitcoin?localization=false", {
    searchParams: new URLSearchParams([
      ["tag", "a&b"],
      ["tag", "c+d"],
    ]),
  }), [])

  const url = new URL(fetchMock.mock.calls[0].arguments[0])
  assert.equal(url.searchParams.get("localization"), "false")
  assert.deepEqual(url.searchParams.getAll("tag"), ["a&b", "c+d"])
})

test("CoinGecko sends the optional key only in the demo header", async (context) => {
  process.env.COINGECKO_API_KEY = " demo-test-key "
  const fetchMock = context.mock.method(globalThis, "fetch", async () => new Response("{}"))

  await requestCoinGeckoJson("/search/trending")

  const [url, options] = fetchMock.mock.calls[0].arguments
  assert.equal(String(url), "https://api.coingecko.com/api/v3/search/trending")
  assert.deepEqual(Object.fromEntries(new Headers(options.headers)), {
    "accept": "application/json",
    "x-cg-demo-api-key": "demo-test-key",
  })
  assert.equal(options.body, undefined)
})

test("CoinGecko omits an empty API key", async (context) => {
  process.env.COINGECKO_API_KEY = "  "
  const fetchMock = context.mock.method(globalThis, "fetch", async () => new Response("{}"))

  await requestCoinGeckoJson("/search/trending")

  assert.equal(new Headers(fetchMock.mock.calls[0].arguments[1].headers).has("x-cg-demo-api-key"), false)
})

test("CoinGecko rejects external URLs and paths outside the API before sending the key", async (context) => {
  process.env.COINGECKO_API_KEY = "demo-test-key"
  const fetchMock = context.mock.method(globalThis, "fetch", async () => assert.fail("Unexpected fetch"))

  for (const endpoint of [
    "https://example.com/coins/bitcoin",
    "https://api.coingecko.com/api/v3/search/trending",
    "//example.com/search/trending",
    "///example.com/search/trending",
    "/\\example.com/search/trending",
    "https:\t//example.com/search/trending",
    "data:application/json,{}",
    "../coins/bitcoin",
    "/%2e%2e/coins/bitcoin",
  ]) {
    await assert.rejects(requestCoinGeckoJson(endpoint), /CoinGecko endpoint must/)
  }

  assert.equal(fetchMock.mock.callCount(), 0)
})

for (const status of [301, 302, 303, 307, 308]) {
  test(`CoinGecko does not forward the key on an HTTP ${status} redirect`, async (context) => {
    process.env.COINGECKO_API_KEY = "demo-test-key"
    const fetchMock = context.mock.method(globalThis, "fetch", async (_url, options) => {
      assert.equal(options.redirect, "manual")
      return new Response(null, {
        status,
        headers: { location: "https://example.com/collect-key" },
      })
    })

    await assert.rejects(requestCoinGeckoJson("/search/trending"), new RegExp(`HTTP ${status}`))
    assert.equal(fetchMock.mock.callCount(), 1)
  })
}

for (const status of [401, 404, 429, 500, 503]) {
  test(`CoinGecko reports HTTP ${status} without retries or echoing the response body`, async (context) => {
    context.mock.timers.enable({ apis: ["setTimeout"] })
    process.env.COINGECKO_API_KEY = "demo-test-key"
    const fetchMock = context.mock.method(globalThis, "fetch", async () => new Response(
      "Rejected demo-test-key",
      { status, headers: { "retry-after": "1" } },
    ))

    await assert.rejects(requestCoinGeckoJson("/search/trending"), {
      message: `CoinGecko /api/v3/search/trending request failed: HTTP ${status}`,
    })
    assert.equal(fetchMock.mock.callCount(), 1)

    context.mock.timers.tick(20_000)
    assert.equal(fetchMock.mock.calls[0].arguments[1].signal.aborted, false)
  })
}

test("CoinGecko reports invalid JSON", async (context) => {
  context.mock.method(globalThis, "fetch", async () => new Response("not-json"))

  await assert.rejects(requestCoinGeckoJson("/search/trending"), (error) => {
    assert.equal(error.message, "CoinGecko /api/v3/search/trending returned invalid JSON")
    assert.equal(error.cause instanceof SyntaxError, true)
    return true
  })
})

test("CoinGecko reports network failures and preserves their cause", async (context) => {
  const failure = new TypeError("socket closed")
  context.mock.method(globalThis, "fetch", async () => {
    throw failure
  })

  await assert.rejects(requestCoinGeckoJson("/search/trending"), (error) => {
    assert.equal(error.message, "CoinGecko /api/v3/search/trending request failed: socket closed")
    assert.equal(error.cause, failure)
    return true
  })
})

test("CoinGecko distinguishes a failed body read from invalid JSON", async (context) => {
  context.mock.method(globalThis, "fetch", async () => new Response(new ReadableStream({
    start (controller) {
      controller.error(new TypeError("body stream closed"))
    },
  })))

  await assert.rejects(requestCoinGeckoJson("/search/trending"), {
    message: "CoinGecko /api/v3/search/trending request failed: body stream closed",
  })
})

for (const timeoutMs of [20_000, 50]) {
  test(`CoinGecko aborts a pending request after ${timeoutMs} ms`, async (context) => {
    context.mock.timers.enable({ apis: ["setTimeout"] })
    const fetchMock = context.mock.method(globalThis, "fetch", async (_url, { signal }) => (
      new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true })
      })
    ))

    const rejected = assert.rejects(
      requestCoinGeckoJson("/search/trending", timeoutMs === 20_000 ? undefined : { timeoutMs }),
      { message: `CoinGecko /api/v3/search/trending request timed out after ${timeoutMs} ms` },
    )
    const signal = fetchMock.mock.calls[0].arguments[1].signal

    context.mock.timers.tick(timeoutMs - 1)
    assert.equal(signal.aborted, false)
    context.mock.timers.tick(1)
    await rejected
    assert.equal(signal.aborted, true)
    assert.equal(fetchMock.mock.callCount(), 1)
  })
}

test("CoinGecko timeout includes reading the response body", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] })
  const reading = Promise.withResolvers()
  const fetchMock = context.mock.method(globalThis, "fetch", async (_url, { signal }) => ({
    ok: true,
    status: 200,
    text () {
      reading.resolve()
      return new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true })
      })
    },
  }))

  const rejected = assert.rejects(requestCoinGeckoJson("/search/trending", { timeoutMs: 50 }), {
    message: "CoinGecko /api/v3/search/trending request timed out after 50 ms",
  })
  await reading.promise
  context.mock.timers.tick(50)
  await rejected
  assert.equal(fetchMock.mock.calls[0].arguments[1].signal.aborted, true)
})

test("CoinGecko validates request options without accessing the network", async (context) => {
  const fetchMock = context.mock.method(globalThis, "fetch", async () => assert.fail("Unexpected fetch"))

  for (const endpoint of [undefined, null, "", " ", 42]) {
    await assert.rejects(requestCoinGeckoJson(endpoint), /CoinGecko endpoint is required/)
  }

  for (const searchParams of [null, [], "query=value"]) {
    await assert.rejects(
      requestCoinGeckoJson("/search/trending", { searchParams }),
      /searchParams must be an object or URLSearchParams/,
    )
  }

  for (const timeoutMs of [0, -1, "10", NaN, Infinity]) {
    await assert.rejects(
      requestCoinGeckoJson("/search/trending", { timeoutMs }),
      /timeoutMs must be a positive number/,
    )
  }

  assert.equal(fetchMock.mock.callCount(), 0)
})
