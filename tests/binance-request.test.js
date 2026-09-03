import assert from "node:assert/strict"
import test from "node:test"
import {
  BinanceRequestError,
  requestBinanceFuturesJson,
} from "../src/api/binance/index.js"

test("Binance requester builds a public GET request and returns JSON", async (context) => {
  let capturedUrl
  let capturedOptions

  context.mock.method(globalThis, "fetch", async (url, options) => {
    capturedUrl = url
    capturedOptions = options

    return new Response(JSON.stringify([[1788440400000, "100.0"]]), {
      status: 200,
    })
  })

  const payload = await requestBinanceFuturesJson("/fapi/v1/klines", {
    searchParams: {
      symbol: "BTCUSDT",
      interval: "15m",
      limit: 500,
      endTime: undefined,
    },
    timeoutMs: 100,
  })
  const url = new URL(capturedUrl)
  const headers = new Headers(capturedOptions.headers)

  assert.deepEqual(payload, [[1788440400000, "100.0"]])
  assert.equal(url.origin, "https://fapi.binance.com")
  assert.equal(url.pathname, "/fapi/v1/klines")
  assert.equal(url.searchParams.get("symbol"), "BTCUSDT")
  assert.equal(url.searchParams.get("interval"), "15m")
  assert.equal(url.searchParams.get("limit"), "500")
  assert.equal(url.searchParams.has("endTime"), false)
  assert.equal(capturedOptions.method, "GET")
  assert.equal(headers.get("accept"), "application/json")
  assert.equal(headers.get("user-agent"), "crypto-signals/1.0")
  assert.equal(headers.has("x-mbx-apikey"), false)
  assert.equal(capturedOptions.signal instanceof AbortSignal, true)
})

test("Binance requester sends an explicitly provided API key", async (context) => {
  let capturedOptions

  context.mock.method(globalThis, "fetch", async (_url, options) => {
    capturedOptions = options

    return new Response("[]", { status: 200 })
  })

  await requestBinanceFuturesJson("fapi/v1/historicalTrades", {
    apiKey: " test-key ",
    searchParams: new URLSearchParams({
      symbol: "BTCUSDT",
      limit: "100",
    }),
  })

  const headers = new Headers(capturedOptions.headers)

  assert.equal(headers.get("x-mbx-apikey"), "test-key")
})

test("Binance requester exposes HTTP and Binance error details", async (context) => {
  context.mock.method(globalThis, "fetch", async () => new Response(
    JSON.stringify({
      code: -1121,
      msg: "Invalid symbol.",
    }),
    {
      headers: { "retry-after": "30" },
      status: 400,
    },
  ))

  await assert.rejects(
    requestBinanceFuturesJson("/fapi/v1/klines"),
    (error) => {
      assert.equal(error instanceof BinanceRequestError, true)
      assert.equal(error.message, "Binance /fapi/v1/klines request failed with HTTP 400: Binance error -1121: Invalid symbol.")
      assert.equal(error.code, -1121)
      assert.equal(error.retryAfter, "30")
      assert.equal(error.status, 400)

      return true
    },
  )
})

test("Binance requester reports API errors returned with HTTP 200", async (context) => {
  context.mock.method(globalThis, "fetch", async () => new Response(
    JSON.stringify({
      code: -1003,
      msg: "Too many requests.",
    }),
    { status: 200 },
  ))

  await assert.rejects(
    requestBinanceFuturesJson("/futures/data/openInterestHist"),
    /Binance \/futures\/data\/openInterestHist API error -1003: Too many requests\./,
  )
})

test("Binance requester reports invalid JSON and network failures", async (context) => {
  context.mock.method(globalThis, "fetch", async () => new Response(
    "not-json",
    { status: 200 },
  ))

  await assert.rejects(
    requestBinanceFuturesJson("/fapi/v1/klines"),
    /Binance \/fapi\/v1\/klines returned invalid JSON/,
  )

  globalThis.fetch.mock.mockImplementation(async () => {
    throw new TypeError("socket closed")
  })

  await assert.rejects(
    requestBinanceFuturesJson("/fapi/v1/klines"),
    /Binance \/fapi\/v1\/klines request failed: socket closed/,
  )
})

test("Binance requester aborts timed out requests", async (context) => {
  context.mock.method(globalThis, "fetch", async (_url, { signal }) => (
    new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => {
        reject(new DOMException("Aborted", "AbortError"))
      }, { once: true })
    })
  ))

  await assert.rejects(
    requestBinanceFuturesJson("/fapi/v1/klines", { timeoutMs: 5 }),
    /Binance \/fapi\/v1\/klines request timed out after 5 ms/,
  )
})

test("Binance requester validates request options", async () => {
  await assert.rejects(
    requestBinanceFuturesJson(""),
    /Binance endpoint is required/,
  )
  await assert.rejects(
    requestBinanceFuturesJson("https://example.com/fapi/v1/klines"),
    /Binance endpoint must be relative/,
  )
  await assert.rejects(
    requestBinanceFuturesJson("/fapi/v1/klines", { searchParams: [] }),
    /searchParams must be an object or URLSearchParams/,
  )
  await assert.rejects(
    requestBinanceFuturesJson("/fapi/v1/klines", { apiKey: " " }),
    /apiKey must be a non-empty string/,
  )
  await assert.rejects(
    requestBinanceFuturesJson("/fapi/v1/klines", { timeoutMs: 0 }),
    /timeoutMs must be a positive number/,
  )
})
