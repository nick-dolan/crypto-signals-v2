import assert from "node:assert/strict"
import test from "node:test"
import { fetchCryptoUniverseData } from "../src/steps/step1-crypto-universe/fetch-crypto-universe-data.js"

test("crypto universe data fetcher applies the step configuration", async (context) => {
  const requests = []

  context.mock.method(globalThis, "fetch", async (url, options) => {
    requests.push({ url, body: JSON.parse(options.body) })

    if (url.endsWith("/coin/scan")) {
      return new Response(JSON.stringify({
        totalCount: 1,
        data: [
          {
            s: "CRYPTO:BTCUSD",
            d: [
              1,
              "XTVCBTC",
              "BTC",
              "Bitcoin",
              ["Layer 1"],
              20_000_000,
              1_500_000_000_000,
              1_575_000_000_000,
            ],
          },
        ],
      }), { status: 200 })
    }

    return new Response(JSON.stringify({
      totalCount: 1,
      data: [
        {
          s: "BINANCE:BTCUSDT.P",
          d: [
            "BTCUSDT.P",
            "Bitcoin perpetual",
            "BTC",
            "XTVCBTC",
            "USDT",
            "BINANCE",
            75_000,
            10_000_000_000,
            "swap",
            "crypto",
            ["crypto", "perpetual"],
          ],
        },
      ],
    }), { status: 200 })
  })

  const { candidates, markets } = await fetchCryptoUniverseData()
  const coinRequest = requests[0].body
  const marketRequest = requests[1].body

  assert.equal(coinRequest.filter[0].right, 500)
  assert.deepEqual(marketRequest.filter.slice(1, 4), [
    {
      left: "currency",
      operation: "in_range",
      right: ["USDT"],
    },
    {
      left: "exchange",
      operation: "in_range",
      right: ["BINANCE"],
    },
    {
      left: "type",
      operation: "in_range",
      right: ["swap"],
    },
  ])
  assert.equal(candidates[0].baseCurrencyId, "XTVCBTC")
  assert.equal(markets[0].tradingViewSymbol, "BINANCE:BTCUSDT.P")
})
