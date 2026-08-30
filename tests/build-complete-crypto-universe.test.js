import assert from "node:assert/strict"
import test from "node:test"
import { buildCompleteCryptoUniverse } from "../src/steps/step2-data-bootstrap/build-complete-crypto-universe.js"

function createMarket (
  baseCurrencyId,
  {
    exchange = "BINANCE",
    instrumentType = "swap",
    quoteSymbol = "USDT",
    symbol = `${baseCurrencyId}${quoteSymbol}.P`,
    typeSpecifications = ["crypto", "perpetual"],
    volume24hUsd = 1_000_000,
  } = {},
) {
  return {
    tradingViewSymbol: `${exchange}:${symbol}`,
    symbol,
    baseSymbol: baseCurrencyId.replace("XTVC", ""),
    baseCurrencyId,
    quoteSymbol,
    exchange,
    price: 1,
    volume24hUsd,
    instrumentType,
    typeSpecifications,
  }
}

function createCoin (
  rank,
  {
    baseCurrencyId = `XTVC${rank}`,
    market = createMarket(baseCurrencyId),
    symbol = `COIN${rank}`,
  } = {},
) {
  return {
    rank,
    baseCurrencyId,
    symbol,
    name: `Coin ${rank}`,
    tradingViewSymbol: `CRYPTO:COIN${rank}USD`,
    categories: ["cryptocurrencies"],
    circulatingSupply: 1_000_000,
    marketCap: 10_000_000,
    fullyDilutedValuation: 12_000_000,
    market,
  }
}

function createSourceUniverse (
  coins,
  {
    selection = {
      exchange: "BINANCE",
      quoteSymbol: "USDT",
      instrumentType: "swap",
      typeSpecification: "perpetual",
    },
    source = "tradingview",
  } = {},
) {
  return {
    source,
    selection,
    coins,
  }
}

function createCoverageResult (
  complete,
  retryable = false,
  {
    dataFile,
    unavailableMetrics = [],
  } = {},
) {
  return {
    complete,
    retryable,
    reasonCodes: complete ? [] : ["premium:missing_values"],
    reasons: complete ? [] : ["Premium is unavailable"],
    unavailableMetrics,
    coverage: {
      ohlcv: {
        completePeriodCount: 2_400,
      },
    },
    ...(dataFile ? { dataFile } : {}),
  }
}

test("complete universe checks every attached market by rank", async () => {
  const candidates = [
    createCoin(5),
    createCoin(2, { baseCurrencyId: "XTVCEDGEX", symbol: "EDGE" }),
    createCoin(4, { baseCurrencyId: "XTVCBTC", symbol: "BTC" }),
    createCoin(3, { baseCurrencyId: "XTVCEDGED", symbol: "EDGE" }),
  ]
  const checkedIds = []
  const report = await buildCompleteCryptoUniverse(
    createSourceUniverse(candidates),
    async (coin) => {
      checkedIds.push(coin.baseCurrencyId)

      return createCoverageResult(coin.baseCurrencyId !== "XTVCEDGED")
    },
    { generatedAt: "2026-08-29T12:00:00Z" },
  )

  assert.deepEqual(checkedIds, [
    "XTVCEDGEX",
    "XTVCEDGED",
    "XTVCBTC",
    "XTVC5",
  ])
  assert.deepEqual(
    report.coins.map(coin => coin.baseCurrencyId),
    ["XTVCEDGEX", "XTVCBTC", "XTVC5"],
  )
  assert.deepEqual(
    report.rejected.map(coin => [coin.baseCurrencyId, coin.reasonCodes]),
    [["XTVCEDGED", ["premium:missing_values"]]],
  )
  assert.deepEqual(report.selection, {
    exchange: "BINANCE",
    quoteSymbol: "USDT",
    instrumentType: "swap",
    typeSpecification: "perpetual",
  })
  assert.equal(report.candidateCount, 4)
  assert.equal(report.coinCount, 3)
})

test("complete universe accepts every complete coin and retries transient failures", async () => {
  let attempts = 0
  const report = await buildCompleteCryptoUniverse(
    createSourceUniverse([createCoin(1)]),
    async (_coin, attempt) => {
      attempts += 1
      assert.equal(attempt, attempts)

      if (attempts === 1) {
        throw new Error("Temporary WebSocket failure")
      }

      return createCoverageResult(true)
    },
    { generatedAt: "2026-08-29T12:00:00Z" },
  )

  assert.equal(attempts, 2)
  assert.equal(report.candidateCount, 1)
  assert.equal(report.coinCount, 1)
  assert.equal(report.coins[0].attempts, 2)
})

test("complete universe keeps the accepted coin data file reference", async () => {
  const dataFile = "tmp/step2-data-bootstrap/COIN1--XTVC1/data.json"
  const report = await buildCompleteCryptoUniverse(
    createSourceUniverse([createCoin(1)]),
    async () => createCoverageResult(true, false, { dataFile }),
  )

  assert.equal(report.coins[0].dataFile, dataFile)
  assert.equal("hourlyData" in report.coins[0], false)
})

test("complete universe confirms unavailable metrics with a second attempt", async () => {
  let attempts = 0
  const report = await buildCompleteCryptoUniverse(
    createSourceUniverse([createCoin(1)]),
    async () => {
      attempts += 1

      return createCoverageResult(false, true, {
        unavailableMetrics: ["premium"],
      })
    },
  )

  assert.equal(attempts, 2)
  assert.equal(report.rejected[0].attempts, 2)
  assert.deepEqual(report.rejected[0].unavailableMetrics, ["premium"])
  assert.deepEqual(report.rejected[0].confirmedUnavailableMetrics, ["premium"])
  assert.equal("dataFile" in report.rejected[0], false)
})

test("complete universe does not confirm absence after a failed first request", async () => {
  let attempts = 0
  const report = await buildCompleteCryptoUniverse(
    createSourceUniverse([createCoin(1)]),
    async () => {
      attempts += 1

      if (attempts === 1) {
        throw new Error("Temporary WebSocket failure")
      }

      return createCoverageResult(false, true, {
        unavailableMetrics: ["premium"],
      })
    },
  )

  assert.deepEqual(report.rejected[0].unavailableMetrics, ["premium"])
  assert.deepEqual(report.rejected[0].confirmedUnavailableMetrics, [])
})

test("complete universe only rechecks market identity needed by step 2", async () => {
  await assert.rejects(
    buildCompleteCryptoUniverse(
      createSourceUniverse([createCoin(1, { market: null })]),
      async () => createCoverageResult(true),
    ),
    /market is required/,
  )

  await assert.rejects(
    buildCompleteCryptoUniverse(
      createSourceUniverse([
        createCoin(1, { market: createMarket("XTVCOTHER") }),
      ]),
      async () => createCoverageResult(true),
    ),
    /baseCurrencyId does not match its coin/,
  )

  const preselectedMarket = createMarket("XTVC1", { exchange: "BYBIT" })
  preselectedMarket.price = null
  preselectedMarket.volume24hUsd = null
  preselectedMarket.typeSpecifications = []

  const report = await buildCompleteCryptoUniverse(
    createSourceUniverse([createCoin(1, { market: preselectedMarket })]),
    async () => createCoverageResult(true),
  )

  assert.equal(report.coinCount, 1)
})

test("complete universe does not hardcode the market selection", async () => {
  const selection = {
    exchange: "EXAMPLE",
    quoteSymbol: "USD",
    instrumentType: "futures",
    typeSpecification: "quarterly",
  }
  const market = createMarket("XTVC1", {
    exchange: selection.exchange,
    instrumentType: selection.instrumentType,
    quoteSymbol: selection.quoteSymbol,
    symbol: "COIN1USDZ26",
    typeSpecifications: ["crypto", selection.typeSpecification],
  })
  const report = await buildCompleteCryptoUniverse(
    createSourceUniverse(
      [createCoin(1, { market })],
      { selection, source: "fixture" },
    ),
    async () => createCoverageResult(true),
    { generatedAt: "2026-08-29T12:00:00Z" },
  )

  assert.equal(report.source, "fixture")
  assert.deepEqual(report.selection, selection)
  assert.equal(report.coinCount, 1)
})
