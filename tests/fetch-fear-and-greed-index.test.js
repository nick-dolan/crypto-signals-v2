import assert from "node:assert/strict"
import test from "node:test"
import { fetchFearAndGreedIndex } from "../src/steps/step1-market-bias/fetch-fear-and-greed-index.js"

const RESPONSE_PAYLOAD = {
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

test("Fear and Greed fetcher requests the latest JSON value", async (context) => {
  let capturedUrl

  context.mock.method(globalThis, "fetch", async (url) => {
    capturedUrl = url
    return new Response(JSON.stringify(RESPONSE_PAYLOAD), { status: 200 })
  })

  const payload = await fetchFearAndGreedIndex()
  const url = new URL(capturedUrl)

  assert.deepEqual(payload, RESPONSE_PAYLOAD)
  assert.equal(url.pathname, "/fng/")
  assert.equal(url.searchParams.get("format"), "json")
  assert.equal(url.searchParams.get("limit"), "1")
})
