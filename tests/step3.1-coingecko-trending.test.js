import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { buildCoinGeckoTrendingContext } from "../src/steps/step3.1-coingecko-trending/build-coingecko-trending-context.js"
import { fetchCoinGeckoTrendingData } from "../src/steps/step3.1-coingecko-trending/fetch-coingecko-trending-data.js"
import { buildBaseSeries } from "../src/steps/step4-feature-metrics/build-base-series.js"
import { readFeatureInput } from "../src/steps/step4-feature-metrics/read-feature-input.js"

function createUniverse () {
  return {
    generatedAt: "2026-09-18T12:00:00.000Z",
    coins: ["BTC", "LIT", "DOGE", "OTHER"].map((symbol, index) => ({
      rank: index + 1,
      baseCurrencyId: `XTVC${symbol}`,
      symbol,
      name: symbol,
      tradingViewSymbol: `CRYPTO:${symbol}USD`,
      categories: ["tradingview-category"],
      market: { tradingViewSymbol: `BINANCE:${symbol}USDT.P` },
    })),
  }
}

function createData () {
  return {
    trending: {
      coins: [
        { item: { id: "bitcoin", symbol: "BTC", name: "Bitcoin" } },
        { item: { id: "lighter", symbol: "DIFFERENT", name: "Lighter" } },
        { item: { id: "unrelated-lit", symbol: "LIT", name: "Unrelated LIT" } },
        { item: { id: "dogecoin", symbol: "DOGE", name: "Dogecoin" } },
        { item: { id: "outside", symbol: "OUTSIDE", name: "Outside universe" } },
      ],
      categories: [
        { id: 1, slug: "layer-1", name: "Layer 1" },
        { id: 2, slug: "meme-token", name: "Meme" },
      ],
    },
    coinCategories: [
      { id: "bitcoin", categories: [" layer 1 "] },
      { id: "lighter", categories: ["DeFi"] },
      { id: "unrelated-lit", categories: ["Meme"] },
      { id: "dogecoin", categories: ["Meme"] },
      { id: "outside", categories: ["Meme tokens"] },
    ],
    futures: {
      tickers: [
        { coin_id: "bitcoin", symbol: "BTCUSDT", target: "USDT", contract_type: "perpetual" },
        { coin_id: "lighter", symbol: "LITUSDT", target: "USDT", contract_type: "perpetual" },
        { coin_id: "unrelated-lit", symbol: "LITUSDT", target: "USDT", contract_type: "futures" },
        { coin_id: "unrelated-lit", symbol: "LITUSDT", target: "USDC", contract_type: "perpetual" },
        { coin_id: null, symbol: "DOGEUSDT", target: "USDT", contract_type: "perpetual" },
        { coin_id: "outside", symbol: "OUTSIDEUSDT", target: "USDT", contract_type: "perpetual" },
      ],
    },
  }
}

function createContext (universe = createUniverse(), data = createData()) {
  return buildCoinGeckoTrendingContext(universe, data, { generatedAt: "2026-09-18T12:05:00.000Z" })
}

function createCoinData (universe) {
  return universe.coins.map(coin => ({
    coin: { baseCurrencyId: coin.baseCurrencyId, marketSymbol: coin.market.tradingViewSymbol },
    chart: { periods: [{ time: 3_600, close: 10 }] },
  }))
}

test("CoinGecko joins only exact Binance USDT perpetual markets and preserves inputs", () => {
  const universe = createUniverse()
  const data = createData()
  const before = structuredClone({ universe, data })
  const result = createContext(universe, data)

  assert.deepEqual({ universe, data }, before)
  assert.equal(result.source, "coingecko")
  assert.equal(result.universeGeneratedAt, universe.generatedAt)
  assert.equal(result.generatedAt, "2026-09-18T12:05:00.000Z")
  assert.equal(result.trendingCoins.length, 5)
  assert.deepEqual(result.trendingCategories, data.trending.categories)
  assert.deepEqual(result.matches, [
    {
      baseCurrencyId: "XTVCBTC",
      marketSymbol: "BINANCE:BTCUSDT.P",
      coingecko: { id: "bitcoin", isTrending: true, trendingCategories: ["Layer 1"] },
    },
    {
      baseCurrencyId: "XTVCLIT",
      marketSymbol: "BINANCE:LITUSDT.P",
      coingecko: { id: "lighter", isTrending: true, trendingCategories: [] },
    },
  ])
  assert.equal(result.skippedMissingCoinIdCount, 1)
  assert.deepEqual(result.trendingCoins.find(coin => coin.id === "outside").trendingCategories, [])
  assert.equal(result.matches.some(match => match.coingecko.id === "unrelated-lit"), false)
})

for (const missingId of [undefined, null, "", "   "]) {
  test(`CoinGecko skips a futures market with missing coin_id ${JSON.stringify(missingId)}`, () => {
    const data = createData()
    data.futures.tickers[0].coin_id = missingId
    const result = createContext(createUniverse(), data)

    assert.equal(result.skippedMissingCoinIdCount, 2)
    assert.deepEqual(result.matches.map(match => match.coingecko.id), ["lighter"])
  })
}

test("CoinGecko does not strip contract multipliers or match other exchanges or spot", () => {
  const universe = createUniverse()
  universe.coins[0].market.tradingViewSymbol = "BYBIT:BTCUSDT.P"
  universe.coins[1].market.tradingViewSymbol = "BINANCE:LITUSDT"
  const data = createData()
  data.futures.tickers.push({
    coin_id: "dogecoin", symbol: "1000DOGEUSDT", target: "USDT", contract_type: "perpetual",
  })

  assert.deepEqual(createContext(universe, data).matches, [])
})

test("CoinGecko tolerates repeated identical market mappings but rejects conflicting IDs", () => {
  const data = createData()
  data.futures.tickers.push({ ...data.futures.tickers[0] })
  assert.equal(createContext(createUniverse(), data).matches.length, 2)

  data.futures.tickers.at(-1).coin_id = "unrelated-lit"
  assert.throws(() => createContext(createUniverse(), data), /BTCUSDT.P has conflicting coin IDs/)
})

test("CoinGecko retains trending coins with empty categories and handles an empty trending list", () => {
  const data = createData()
  data.coinCategories[0].categories = []
  data.trending.categories = []
  assert.deepEqual(createContext(createUniverse(), data).matches[0].coingecko.trendingCategories, [])

  data.trending.coins = []
  data.coinCategories = []
  const empty = createContext(createUniverse(), data)
  assert.deepEqual(empty.trendingCoins, [])
  assert.deepEqual(empty.matches, [])
})

test("CoinGecko rejects missing category data instead of treating it as no category overlap", () => {
  const data = createData()
  data.coinCategories = data.coinCategories.slice(1)
  assert.throws(() => createContext(createUniverse(), data), /categories are missing for bitcoin/)
})

test("CoinGecko rejects incomplete responses and duplicate trending coin IDs", () => {
  const data = createData()
  assert.throws(() => createContext(createUniverse(), { ...data, trending: {} }), /coins and categories arrays/)
  assert.throws(() => createContext(createUniverse(), { ...data, futures: {} }), /tickers array/)
  data.trending.coins.push(data.trending.coins[0])
  assert.throws(() => createContext(createUniverse(), data), /duplicate coin IDs/)
})

test("CoinGecko fetches only trending coin details and spaces out requests", async () => {
  const data = createData()
  const requests = []
  const pauses = []
  const progress = []
  const result = await fetchCoinGeckoTrendingData({
    pause: async ms => pauses.push(ms),
    onProgress: event => progress.push(event),
    request: async (endpoint, options) => {
      requests.push({ endpoint, options })
      if (endpoint === "/search/trending") {
        return data.trending
      }
      if (endpoint === "/derivatives/exchanges/binance_futures") {
        return data.futures
      }
      return data.coinCategories.find(coin => endpoint === `/coins/${coin.id}`)
    },
  })

  assert.deepEqual(result, data)
  assert.equal(requests.length, data.trending.coins.length + 2)
  assert.deepEqual(requests[1].options, { searchParams: { include_tickers: "unexpired" } })
  assert.deepEqual(requests.slice(2).map(request => request.endpoint), [
    "/coins/bitcoin", "/coins/lighter", "/coins/unrelated-lit", "/coins/dogecoin", "/coins/outside",
  ])
  assert.deepEqual(requests[2].options.searchParams, {
    localization: false, tickers: false, market_data: false,
    community_data: false, developer_data: false, sparkline: false,
  })
  assert.deepEqual(pauses, [2_000, 2_000, 2_000, 2_000, 2_000])
  assert.deepEqual(progress.at(-1), { index: 5, total: 5, coinId: "outside" })
})

test("CoinGecko fetcher does not request coin details when the trending list is empty", async () => {
  const result = await fetchCoinGeckoTrendingData({
    pause: async () => assert.fail("No detail requests should be made"),
    request: async endpoint => endpoint === "/search/trending"
      ? { coins: [], categories: [] }
      : { tickers: [] },
  })

  assert.deepEqual(result.coinCategories, [])
})

test("CoinGecko fetcher propagates API errors and rejects wrong detail identities", async () => {
  await assert.rejects(fetchCoinGeckoTrendingData({
    request: async () => {
      throw new Error("CoinGecko HTTP 429")
    },
  }), /HTTP 429/)

  const data = createData()
  await assert.rejects(fetchCoinGeckoTrendingData({
    pause: async () => {},
    request: async (endpoint) => {
      if (endpoint === "/search/trending") {
        return data.trending
      }
      if (endpoint === "/derivatives/exchanges/binance_futures") {
        return data.futures
      }
      return { id: "another-coin", categories: [] }
    },
  }), /bitcoin response must contain its ID and categories array/)
})

test("step 4 enriches accepted coins without changing their order, categories or market data", () => {
  const universe = createUniverse()
  const coinData = createCoinData(universe)
  const input = { sourceUniverse: universe, coinData }
  const before = structuredClone(input)
  const original = buildBaseSeries(input)
  const enriched = buildBaseSeries({ ...input, coingeckoTrending: createContext(universe) })

  assert.deepEqual(input, before)
  assert.deepEqual(enriched[0].coin.coingecko, {
    id: "bitcoin", isTrending: true, trendingCategories: ["Layer 1"],
  })
  assert.deepEqual(enriched[1].coin.coingecko.trendingCategories, [])
  assert.equal("coingecko" in enriched[2].coin, false)
  assert.equal("coingecko" in enriched[3].coin, false)
  const withoutCoinGecko = structuredClone(enriched)
  for (const baseCoin of withoutCoinGecko) {
    delete baseCoin.coin.coingecko
  }
  assert.deepEqual(withoutCoinGecko, original)

  const acceptedOnly = buildBaseSeries({
    sourceUniverse: universe,
    coinData: coinData.slice(1),
    coingeckoTrending: createContext(universe),
  })
  assert.equal(acceptedOnly.length, 3)
  assert.equal(acceptedOnly[0].coin.coingecko.id, "lighter")
})

test("step 4 rejects a stale CoinGecko universe or a mismatched market", () => {
  const universe = createUniverse()
  const coingeckoTrending = createContext(universe)
  const input = { sourceUniverse: universe, coinData: createCoinData(universe), coingeckoTrending }
  coingeckoTrending.universeGeneratedAt = "2026-09-17T12:00:00.000Z"
  assert.throws(() => buildBaseSeries(input), /rerun step 3.1/)

  coingeckoTrending.universeGeneratedAt = universe.generatedAt
  coingeckoTrending.matches[0].marketSymbol = "BINANCE:OTHERUSDT.P"
  assert.throws(() => buildBaseSeries(input), /market does not match CoinGecko context/)
})

test("step 4 reads the new step 3.1 artifact and requires it for file-based runs", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "coingecko-pipeline-"))
  const previousDirectory = process.cwd()
  const universe = createUniverse()
  const coingeckoTrending = createContext(universe)
  const coinData = createCoinData(universe)

  try {
    process.chdir(directory)
    await fs.mkdir("tmp/step2-data-bootstrap", { recursive: true })
    for (const [filename, data] of [
      ["step1-crypto-universe.json", universe],
      ["step2-data-bootstrap.json", { coinCount: coinData.length }],
      ["step3-market-context.json", { source: "tradingview" }],
      ["step3.1-coingecko-trending.json", coingeckoTrending],
    ]) {
      await fs.writeFile(path.join("tmp", filename), JSON.stringify(data))
    }
    for (const data of coinData) {
      const coinDirectory = path.join("tmp", "step2-data-bootstrap", data.coin.baseCurrencyId)
      await fs.mkdir(coinDirectory)
      await fs.writeFile(path.join(coinDirectory, "data.json"), JSON.stringify(data))
    }

    const input = await readFeatureInput()
    assert.deepEqual(input.coingeckoTrending, coingeckoTrending)
    assert.equal(buildBaseSeries(input)[0].coin.coingecko.id, "bitcoin")

    await fs.rm("tmp/step3.1-coingecko-trending.json")
    await assert.rejects(readFeatureInput(), /step3\.1-coingecko-trending\.json/)
  } finally {
    process.chdir(previousDirectory)
    await fs.rm(directory, { recursive: true, force: true })
  }
})
