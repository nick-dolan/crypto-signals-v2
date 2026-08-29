import assert from "node:assert/strict"
import test from "node:test"
import { fetchCryptoUniverseCandidates } from "../src/steps/step1-crypto-universe/fetch-crypto-universe-candidates.js"

const SCREENER_PAYLOAD = {
  totalCount: 2,
  data: [
    {
      s: "CRYPTO:ETHUSD",
      d: [
        2,
        "crypto-ethereum",
        "ETH",
        "Ethereum",
        ["Smart contract platforms"],
        120_000_000,
        300_000_000_000,
        300_000_000_000,
      ],
    },
    {
      s: "CRYPTO:BTCUSD",
      d: [
        1,
        "crypto-bitcoin",
        "BTC",
        "Bitcoin",
        ["Layer 1"],
        20_000_000,
        1_500_000_000_000,
        1_575_000_000_000,
      ],
    },
  ],
}

test("crypto universe fetcher requests and normalizes ranked candidates", async (context) => {
  let capturedUrl
  let capturedOptions

  context.mock.method(globalThis, "fetch", async (url, options) => {
    capturedUrl = url
    capturedOptions = options

    return new Response(JSON.stringify(SCREENER_PAYLOAD), { status: 200 })
  })

  const candidates = await fetchCryptoUniverseCandidates({
    rankMax: 2,
    timeoutMs: 100,
  })
  const requestBody = JSON.parse(capturedOptions.body)
  const headers = new Headers(capturedOptions.headers)

  assert.equal(capturedUrl, "https://scanner.tradingview.com/coin/scan")
  assert.equal(capturedOptions.method, "POST")
  assert.equal(headers.get("content-type"), "application/json")
  assert.equal(headers.get("origin"), "https://www.tradingview.com")
  assert.deepEqual(requestBody.columns, [
    "crypto_total_rank",
    "base_currency_id",
    "base_currency",
    "base_currency_desc",
    "crypto_common_categories",
    "circulating_supply",
    "market_cap_calc",
    "market_cap_diluted_calc",
  ])
  assert.deepEqual(requestBody.filter, [
    {
      left: "crypto_total_rank",
      operation: "eless",
      right: 2,
    },
  ])
  assert.deepEqual(requestBody.range, [0, 2])
  assert.deepEqual(requestBody.sort, {
    sortBy: "crypto_total_rank",
    sortOrder: "asc",
  })
  assert.deepEqual(candidates, [
    {
      rank: 1,
      baseCurrencyId: "crypto-bitcoin",
      symbol: "BTC",
      name: "Bitcoin",
      tradingViewSymbol: "CRYPTO:BTCUSD",
      categories: ["Layer 1"],
      circulatingSupply: 20_000_000,
      marketCap: 1_500_000_000_000,
      fullyDilutedValuation: 1_575_000_000_000,
    },
    {
      rank: 2,
      baseCurrencyId: "crypto-ethereum",
      symbol: "ETH",
      name: "Ethereum",
      tradingViewSymbol: "CRYPTO:ETHUSD",
      categories: ["Smart contract platforms"],
      circulatingSupply: 120_000_000,
      marketCap: 300_000_000_000,
      fullyDilutedValuation: 300_000_000_000,
    },
  ])
})

test("crypto universe fetcher preserves missing categories for coverage filtering", async (context) => {
  context.mock.method(globalThis, "fetch", async () => new Response(
    JSON.stringify({
      totalCount: 1,
      data: [
        {
          s: "CRYPTO:NEWUSD",
          d: [
            1,
            "crypto-new",
            "NEW",
            "New Coin",
            null,
            1_000_000,
            10_000_000,
            12_000_000,
          ],
        },
      ],
    }),
    { status: 200 },
  ))

  const [candidate] = await fetchCryptoUniverseCandidates({
    rankMax: 1,
    timeoutMs: 100,
  })

  assert.deepEqual(candidate.categories, [])
})

test("crypto universe fetcher rejects duplicate baseCurrencyId values", async (context) => {
  context.mock.method(globalThis, "fetch", async () => new Response(
    JSON.stringify({
      totalCount: 2,
      data: [
        {
          s: "CRYPTO:BTCUSD",
          d: [
            1,
            "duplicate-id",
            "BTC",
            "Bitcoin",
            ["Layer 1"],
            20_000_000,
            1_500_000_000_000,
            1_575_000_000_000,
          ],
        },
        {
          s: "CRYPTO:ETHUSD",
          d: [
            2,
            "duplicate-id",
            "ETH",
            "Ethereum",
            ["Layer 1"],
            120_000_000,
            300_000_000_000,
            300_000_000_000,
          ],
        },
      ],
    }),
    { status: 200 },
  ))

  await assert.rejects(
    fetchCryptoUniverseCandidates({ rankMax: 2, timeoutMs: 100 }),
    /duplicate baseCurrencyId: duplicate-id/,
  )
})
