import assert from "node:assert/strict"
import test from "node:test"
import { fetchTradingViewCryptoMarkets } from "../src/api/tradingview/crypto-market-screener.js"

function createMarketRow ({
  baseCurrencyId = "XTVCBTC",
  baseSymbol = "BTC",
  symbol = "BTCUSDT.P",
  tradingViewSymbol = "BINANCE:BTCUSDT.P",
} = {}) {
  return {
    s: tradingViewSymbol,
    d: [
      symbol,
      `${baseSymbol} perpetual`,
      baseSymbol,
      baseCurrencyId,
      "USDT",
      "BINANCE",
      75_000,
      10_000_000_000,
      "swap",
      "crypto",
      ["crypto", "perpetual"],
    ],
  }
}

test("crypto market screener requests Binance USDT swaps by baseCurrencyId", async (context) => {
  let capturedUrl
  let capturedOptions

  context.mock.method(globalThis, "fetch", async (url, options) => {
    capturedUrl = url
    capturedOptions = options

    return new Response(JSON.stringify({
      totalCount: 1,
      data: [createMarketRow()],
    }), { status: 200 })
  })

  const markets = await fetchTradingViewCryptoMarkets({
    baseCurrencyIds: ["xtvcbtc", "XTVCBTC"],
    maxRows: 100,
    timeoutMs: 100,
  })
  const request = JSON.parse(capturedOptions.body)

  assert.equal(capturedUrl, "https://scanner.tradingview.com/crypto/scan")
  assert.deepEqual(request.columns, [
    "name",
    "description",
    "base_currency",
    "base_currency_id",
    "currency",
    "exchange",
    "close",
    "24h_vol|5",
    "type",
    "subtype",
    "typespecs",
  ])
  assert.deepEqual(request.filter, [
    {
      left: "base_currency_id",
      operation: "in_range",
      right: ["XTVCBTC"],
    },
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
    {
      left: "24h_vol|5",
      operation: "greater",
      right: 0,
    },
  ])
  assert.deepEqual(request.range, [0, 100])
  assert.deepEqual(markets, [
    {
      tradingViewSymbol: "BINANCE:BTCUSDT.P",
      symbol: "BTCUSDT.P",
      description: "BTC perpetual",
      baseSymbol: "BTC",
      baseCurrencyId: "XTVCBTC",
      quoteSymbol: "USDT",
      exchange: "BINANCE",
      price: 75_000,
      volume24hUsd: 10_000_000_000,
      instrumentType: "swap",
      instrumentSubtype: "crypto",
      typeSpecifications: ["crypto", "perpetual"],
    },
  ])
})

test("crypto market screener preserves identity for duplicate display tickers", async (context) => {
  context.mock.method(globalThis, "fetch", async () => new Response(
    JSON.stringify({
      totalCount: 2,
      data: [
        createMarketRow({
          baseCurrencyId: "XTVCLITL",
          baseSymbol: "LIT",
          symbol: "LITLUSDT.P",
          tradingViewSymbol: "BINANCE:LITLUSDT.P",
        }),
        createMarketRow({
          baseCurrencyId: "XTVCLITENTRY",
          baseSymbol: "LIT",
          symbol: "LITUSDT.P",
          tradingViewSymbol: "BINANCE:LITUSDT.P",
        }),
      ],
    }),
    { status: 200 },
  ))

  const markets = await fetchTradingViewCryptoMarkets({
    baseCurrencyIds: ["XTVCLITL", "XTVCLITENTRY"],
    timeoutMs: 100,
  })

  assert.deepEqual(
    markets.map(market => [market.baseSymbol, market.baseCurrencyId]),
    [
      ["LIT", "XTVCLITL"],
      ["LIT", "XTVCLITENTRY"],
    ],
  )
})

test("crypto market screener rejects a truncated response", async (context) => {
  context.mock.method(globalThis, "fetch", async () => new Response(
    JSON.stringify({
      totalCount: 2,
      data: [createMarketRow()],
    }),
    { status: 200 },
  ))

  await assert.rejects(
    fetchTradingViewCryptoMarkets({
      baseCurrencyIds: ["XTVCBTC"],
      timeoutMs: 100,
    }),
    /response is incomplete/,
  )
})
