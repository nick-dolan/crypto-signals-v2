import assert from "node:assert/strict"
import test from "node:test"

import { fetchTradingViewNews } from "../src/api/tradingview/news.js"

test("requests and normalizes TradingView news", async (context) => {
  const fetchMock = context.mock.method(globalThis, "fetch", async () => (
    new Response(JSON.stringify({
      items: [
        {
          id: "provider:article:0",
          title: "Bitcoin update",
          published: 1_800_000_000,
          provider: {
            id: "provider",
            name: "Provider",
            url: "https://provider.example",
          },
          link: "https://provider.example/article",
          storyPath: "/news/provider-article/",
          paywall: false,
          permission: "free",
          urgency: 1,
          relatedSymbols: [
            { symbol: "COINBASE:BTCUSD" },
            { symbol: "COINBASE:BTCUSD" },
          ],
        },
      ],
      sections: [{ id: "latest" }],
    }), {
      headers: {
        "content-type": "application/json",
      },
    })
  ))

  const result = await fetchTradingViewNews({
    symbol: "BINANCE:BTCUSDT.P",
    language: "en",
    client: "web",
    timeoutMs: 100,
  })

  assert.equal(fetchMock.mock.callCount(), 1)

  const [url, options] = fetchMock.mock.calls[0].arguments

  assert.deepEqual(
    url.searchParams.getAll("filter"),
    ["lang:en", "symbol:BINANCE:BTCUSDT.P"],
  )
  assert.equal(url.searchParams.get("client"), "web")
  assert.equal(url.searchParams.get("streaming"), "false")
  assert.equal(options.headers.accept, "application/json")
  assert.equal(options.headers["user-agent"], "crypto-signals/1.0")
  assert.deepEqual(result.sections, [{ id: "latest" }])
  assert.deepEqual(result.items[0], {
    id: "provider:article:0",
    title: "Bitcoin update",
    published: 1_800_000_000,
    publishedAt: "2027-01-15T08:00:00.000Z",
    provider: {
      id: "provider",
      name: "Provider",
      url: "https://provider.example",
    },
    externalUrl: "https://provider.example/article",
    tradingViewUrl: "https://www.tradingview.com/news/provider-article/",
    paywall: false,
    permission: "free",
    urgency: 1,
    matchedSymbols: ["BINANCE:BTCUSDT.P"],
    relatedSymbols: ["COINBASE:BTCUSD"],
  })
})
