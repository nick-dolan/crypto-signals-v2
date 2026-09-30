import assert from "node:assert/strict"
import test, { beforeEach } from "node:test"

import { fetchTradingViewCryptoNews, fetchTradingViewNews } from "../src/api/tradingview/news.js"

beforeEach((context) => {
  context.mock.method(globalThis, "fetch", async () => assert.fail("Unexpected network request"))
})

function newsItem (id, overrides = {}) {
  return {
    id,
    title: `Crypto news ${id}`,
    published: 1_800_000_000,
    provider: { id: "provider", name: "Provider" },
    storyPath: `/news/${id}/`,
    paywall: false,
    urgency: 1,
    ...overrides,
  }
}

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

  assert.equal(url.origin, "https://news-mediator.tradingview.com")
  assert.equal(url.pathname, "/public/view/v1/symbol")
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

test("requests one anonymous global crypto batch without symbol, date filters or pagination", async (context) => {
  const fetchMock = context.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({
    items: [
      newsItem("altcoin", {
        title: "  Solana ecosystem update  ",
        link: "https://provider.example/solana",
        relatedSymbols: [{ symbol: "BINANCE:SOLUSDT" }, { symbol: " BINANCE:SOLUSDT " }],
      }),
      newsItem("market", { title: "Crypto exchange regulatory update", storyPath: null }),
    ],
    pagination: { cursor: "next-batch" },
  })))
  const result = await fetchTradingViewCryptoNews()

  assert.equal(fetchMock.mock.callCount(), 1)
  const [url, options] = fetchMock.mock.calls[0].arguments
  assert.equal(url.href, "https://news-mediator.tradingview.com/public/news-flow/v2/news?filter=lang%3Aen&filter=market%3Acrypto&client=landing&streaming=false")
  assert.deepEqual(options.headers, { "accept": "application/json", "user-agent": "crypto-signals/1.0" })
  assert.deepEqual(result.sections, [])
  assert.deepEqual(result.items[0], {
    id: "altcoin",
    title: "Solana ecosystem update",
    published: 1_800_000_000,
    publishedAt: "2027-01-15T08:00:00.000Z",
    provider: { id: "provider", name: "Provider", url: null },
    externalUrl: "https://provider.example/solana",
    tradingViewUrl: "https://www.tradingview.com/news/altcoin/",
    paywall: false,
    permission: null,
    urgency: 1,
    matchedSymbols: [],
    relatedSymbols: ["BINANCE:SOLUSDT"],
  })
  assert.equal(result.items[1].title, "Crypto exchange regulatory update")
  assert.equal(result.items[1].tradingViewUrl, null)
  assert.deepEqual(result.items[1].matchedSymbols, [])
  assert.deepEqual(result.items[1].relatedSymbols, [])
})

for (const fetchNews of [fetchTradingViewNews, fetchTradingViewCryptoNews]) {
  test(`${fetchNews.name} normalizes request options and keeps empty batches`, async (context) => {
    const fetchMock = context.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ items: [], sections: null })))
    const result = await fetchNews({ symbol: " BINANCE:SOLUSDT ", language: " en ", client: " landing ", timeoutMs: 100 })
    const [url] = fetchMock.mock.calls[0].arguments

    assert.deepEqual(result, { items: [], sections: [] })
    assert.deepEqual(url.searchParams.getAll("filter"), [
      "lang:en", fetchNews === fetchTradingViewNews ? "symbol:BINANCE:SOLUSDT" : "market:crypto",
    ])
    assert.equal(url.searchParams.get("client"), "landing")
  })

  test(`${fetchNews.name} rejects invalid options before requesting data`, async () => {
    for (const options of [{ language: " " }, { client: null }, { timeoutMs: 0 }]) {
      await assert.rejects(fetchNews({ symbol: "BINANCE:SOLUSDT", ...options }), /required|timeoutMs/)
    }
  })

  test(`${fetchNews.name} rejects malformed responses and unknown timestamps without inventing dates`, async (context) => {
    for (const payload of [null, {}, { items: null }, { items: "invalid" }]) {
      context.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify(payload)))
      await assert.rejects(fetchNews({ symbol: "BINANCE:SOLUSDT" }), /items array/)
    }
    for (const published of [undefined, null, 0, -1, "1800000000", 1.5]) {
      context.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ items: [newsItem("invalid", { published })] })))
      await assert.rejects(fetchNews({ symbol: "BINANCE:SOLUSDT" }), /positive Unix timestamp/)
    }
  })
}

test("the symbol endpoint still requires a symbol", async () => {
  await assert.rejects(fetchTradingViewNews(), /symbol is required/)
})
