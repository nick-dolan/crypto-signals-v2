import assert from "node:assert/strict"
import test from "node:test"
import { requestAlternativeMeJson } from "../src/api/alternative-me/index.js"

const SUCCESS_PAYLOAD = {
  name: "Fear and Greed Index",
  data: [
    {
      value: "74",
      value_classification: "Greed",
      timestamp: "1787616000",
    },
  ],
  metadata: {
    error: null,
  },
}

test("Alternative.me requester builds a GET request and returns JSON", async (context) => {
  let capturedUrl
  let capturedOptions

  context.mock.method(globalThis, "fetch", async (url, options) => {
    capturedUrl = url
    capturedOptions = options

    return new Response(JSON.stringify(SUCCESS_PAYLOAD), {
      headers: {
        "content-type": "application/json",
      },
      status: 200,
    })
  })

  const payload = await requestAlternativeMeJson("/fng/", {
    headers: {
      "x-request-id": "test-request",
    },
    searchParams: {
      format: "json",
      ignored: undefined,
      limit: 10,
      tags: ["first", "second"],
    },
    timeoutMs: 100,
  })
  const url = new URL(capturedUrl)
  const headers = new Headers(capturedOptions.headers)

  assert.deepEqual(payload, SUCCESS_PAYLOAD)
  assert.equal(url.origin, "https://api.alternative.me")
  assert.equal(url.pathname, "/fng/")
  assert.equal(url.searchParams.get("format"), "json")
  assert.equal(url.searchParams.get("limit"), "10")
  assert.deepEqual(url.searchParams.getAll("tags"), ["first", "second"])
  assert.equal(url.searchParams.has("ignored"), false)
  assert.equal(capturedOptions.method, "GET")
  assert.equal(headers.get("accept"), "application/json")
  assert.equal(headers.get("user-agent"), "crypto-signals/1.0")
  assert.equal(headers.get("x-request-id"), "test-request")
  assert.equal(capturedOptions.signal instanceof AbortSignal, true)
})

test("Alternative.me requester accepts URLSearchParams", async (context) => {
  let capturedUrl

  context.mock.method(globalThis, "fetch", async (url) => {
    capturedUrl = url
    return new Response(JSON.stringify(SUCCESS_PAYLOAD), { status: 200 })
  })

  await requestAlternativeMeJson("fng/", {
    searchParams: new URLSearchParams([
      ["limit", "2"],
      ["format", "json"],
    ]),
  })

  const url = new URL(capturedUrl)

  assert.equal(url.searchParams.get("limit"), "2")
  assert.equal(url.searchParams.get("format"), "json")
})

test("Alternative.me requester reports HTTP error details", async (context) => {
  context.mock.method(globalThis, "fetch", async () => new Response(
    JSON.stringify({
      metadata: {
        error: "Rate limit exceeded",
      },
    }),
    { status: 429 },
  ))

  await assert.rejects(
    requestAlternativeMeJson("fng/"),
    /Alternative\.me \/fng\/ request failed with HTTP 429: Rate limit exceeded/,
  )
})

test("Alternative.me requester reports API errors returned with HTTP 200", async (context) => {
  context.mock.method(globalThis, "fetch", async () => new Response(
    JSON.stringify({
      data: [],
      metadata: {
        error: "Invalid limit",
      },
    }),
    { status: 200 },
  ))

  await assert.rejects(
    requestAlternativeMeJson("fng/"),
    /Alternative\.me \/fng\/ API error: Invalid limit/,
  )
})

test("Alternative.me requester reports invalid JSON", async (context) => {
  context.mock.method(globalThis, "fetch", async () => new Response(
    "not-json",
    { status: 200 },
  ))

  await assert.rejects(
    requestAlternativeMeJson("fng/"),
    /Alternative\.me \/fng\/ returned invalid JSON/,
  )
})

test("Alternative.me requester reports network failures", async (context) => {
  context.mock.method(globalThis, "fetch", async () => {
    throw new TypeError("socket closed")
  })

  await assert.rejects(
    requestAlternativeMeJson("fng/"),
    /Alternative\.me \/fng\/ request failed: socket closed/,
  )
})

test("Alternative.me requester aborts timed out requests", async (context) => {
  context.mock.method(globalThis, "fetch", async (_url, { signal }) => (
    new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => {
        reject(new DOMException("Aborted", "AbortError"))
      }, { once: true })
    })
  ))

  await assert.rejects(
    requestAlternativeMeJson("fng/", { timeoutMs: 5 }),
    /Alternative\.me \/fng\/ request timed out after 5 ms/,
  )
})

test("Alternative.me requester validates request options", async () => {
  await assert.rejects(
    requestAlternativeMeJson(""),
    /Alternative\.me endpoint is required/,
  )
  await assert.rejects(
    requestAlternativeMeJson("https://example.com/fng/"),
    /Alternative\.me endpoint must be relative/,
  )
  await assert.rejects(
    requestAlternativeMeJson("fng/", { searchParams: [] }),
    /searchParams must be an object or URLSearchParams/,
  )
  await assert.rejects(
    requestAlternativeMeJson("fng/", { timeoutMs: 0 }),
    /timeoutMs must be a positive number/,
  )
})
