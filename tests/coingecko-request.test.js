import assert from "node:assert/strict"
import test from "node:test"
import { requestCoinGeckoJson } from "../src/api/coingecko/request.js"

test("CoinGecko retries two timeouts with fresh signals and preserves request parameters", async (t) => {
  const signals = []
  const warnings = t.mock.method(console, "warn", () => {})
  t.mock.method(globalThis, "fetch", async (url, options) => {
    assert.equal(url.pathname, "/api/v3/coins/pudgy-penguins")
    assert.equal(url.searchParams.get("market_data"), "false")
    assert.equal(options.signal.aborted, false)
    signals.push(options.signal)
    if (signals.length < 3) {
      return new Promise((resolve, reject) => {
        options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true })
      })
    }
    return Response.json({ id: "pudgy-penguins", categories: [] })
  })

  const result = await requestCoinGeckoJson("/coins/pudgy-penguins", {
    searchParams: { market_data: false },
    timeoutMs: 10,
  })

  assert.deepEqual(result, { id: "pudgy-penguins", categories: [] })
  assert.equal(new Set(signals).size, 3)
  assert.equal(signals[0].aborted, true)
  assert.equal(signals[1].aborted, true)
  assert.equal(signals[2].aborted, false)
  assert.equal(warnings.mock.callCount(), 2)
  assert.match(warnings.mock.calls[0].arguments[0], /2000 ms \(attempt 2\/3\)/)
  assert.match(warnings.mock.calls[1].arguments[0], /2000 ms \(attempt 3\/3\)/)
})

test("CoinGecko stops after three response-body timeouts and retains the cause", async (t) => {
  let cause
  const warnings = t.mock.method(console, "warn", () => {})
  const request = t.mock.method(globalThis, "fetch", async (url, { signal }) => ({
    ok: true,
    text: () => new Promise((resolve, reject) => {
      signal.addEventListener("abort", () => {
        cause = signal.reason
        reject(cause)
      }, { once: true })
    }),
  }))

  await assert.rejects(requestCoinGeckoJson("/coins/pudgy-penguins", { timeoutMs: 10 }), (error) => {
    assert.equal(error.message, "CoinGecko /api/v3/coins/pudgy-penguins request timed out after 10 ms")
    assert.equal(error.cause, cause)
    return true
  })
  assert.equal(request.mock.callCount(), 3)
  assert.equal(warnings.mock.callCount(), 2)
})

test("CoinGecko does not retry HTTP, JSON or transport errors", async (t) => {
  for (const [name, response, expected] of [
    ["HTTP", async () => new Response("Unavailable", { status: 503 }), /request failed: HTTP 503/],
    ["JSON", async () => new Response("{"), /returned invalid JSON/],
    ["transport", async () => {
      throw new Error("fetch failed")
    }, /request failed: fetch failed/],
  ]) {
    await t.test(name, async (t) => {
      const request = t.mock.method(globalThis, "fetch", response)
      const warnings = t.mock.method(console, "warn", () => {})

      await assert.rejects(requestCoinGeckoJson("/search/trending"), expected)
      assert.equal(request.mock.callCount(), 1)
      assert.equal(warnings.mock.callCount(), 0)
    })
  }
})
