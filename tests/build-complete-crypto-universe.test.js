import assert from "node:assert/strict"
import test from "node:test"
import { buildCompleteCryptoUniverse } from "../src/steps/step2-data-bootstrap/build-complete-crypto-universe.js"

const DEFAULT_SELECTION = Object.freeze({
  exchange: "BINANCE",
  quoteSymbol: "USDT",
  instrumentType: "swap",
  typeSpecification: "perpetual",
})

function createMarket (
  baseCurrencyId,
  {
    exchange = DEFAULT_SELECTION.exchange,
    instrumentType = DEFAULT_SELECTION.instrumentType,
    quoteSymbol = DEFAULT_SELECTION.quoteSymbol,
    symbol = `${baseCurrencyId}${quoteSymbol}.P`,
    typeSpecifications = ["crypto", DEFAULT_SELECTION.typeSpecification],
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
    selection = DEFAULT_SELECTION,
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
    hourlyData,
    unavailableMetrics = [],
  } = {},
) {
  return {
    complete,
    retryable,
    reasonCodes: complete ? [] : ["premium:insufficient_values"],
    reasons: complete ? [] : ["Premium is unavailable"],
    unavailableMetrics,
    coverage: {
      ohlcv: {
        completePeriodCount: 168,
      },
    },
    ...(hourlyData ? { hourlyData } : {}),
  }
}

test("complete universe checks attached markets by rank and stops at target", async () => {
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
    {
      generatedAt: "2026-08-29T12:00:00Z",
      targetCount: 2,
    },
  )

  assert.deepEqual(checkedIds, ["XTVCEDGEX", "XTVCEDGED", "XTVCBTC"])
  assert.deepEqual(
    report.coins.map(coin => coin.baseCurrencyId),
    ["XTVCEDGEX", "XTVCBTC"],
  )
  assert.deepEqual(
    report.rejected.map(coin => [coin.baseCurrencyId, coin.reasonCodes]),
    [["XTVCEDGED", ["premium:insufficient_values"]]],
  )
  assert.deepEqual(report.selection, DEFAULT_SELECTION)
  assert.equal(report.targetReached, true)
  assert.equal(report.checkedCandidateCount, 3)
  assert.equal(report.uncheckedCandidateCount, 1)
  assert.equal(report.liveCheckedCount, 3)
})

test("complete universe allows fewer coins than target and retries transient failures", async () => {
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
    {
      generatedAt: "2026-08-29T12:00:00Z",
      targetCount: 2,
    },
  )

  assert.equal(attempts, 2)
  assert.equal(report.coinCount, 1)
  assert.equal(report.targetReached, false)
  assert.equal(report.uncheckedCandidateCount, 0)
  assert.equal(report.coins[0].attempts, 2)
})

test("complete universe keeps downloaded history for accepted coins", async () => {
  const hourlyData = {
    timeframe: "1h",
    requestedHours: 2_400,
    chart: { periods: [{ time: 1, close: 1 }] },
    studies: {},
  }
  const report = await buildCompleteCryptoUniverse(
    createSourceUniverse([createCoin(1)]),
    async () => createCoverageResult(true, false, { hourlyData }),
    { targetCount: 1 },
  )

  assert.equal(report.coins[0].hourlyData, hourlyData)
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
    { targetCount: 1 },
  )

  assert.equal(attempts, 2)
  assert.equal(report.rejected[0].attempts, 2)
  assert.deepEqual(report.rejected[0].unavailableMetrics, ["premium"])
  assert.deepEqual(report.rejected[0].confirmedUnavailableMetrics, ["premium"])
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
    { targetCount: 1 },
  )

  assert.deepEqual(report.rejected[0].unavailableMetrics, ["premium"])
  assert.deepEqual(report.rejected[0].confirmedUnavailableMetrics, [])
})

test("complete universe validates markets against selection from step 1", async () => {
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
        createCoin(1, {
          market: createMarket("XTVC1", { exchange: "BYBIT" }),
        }),
      ]),
      async () => createCoverageResult(true),
    ),
    /does not match crypto universe selection/,
  )
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
    {
      generatedAt: "2026-08-29T12:00:00Z",
      targetCount: 1,
    },
  )

  assert.equal(report.source, "fixture")
  assert.deepEqual(report.selection, selection)
  assert.equal(report.coinCount, 1)
})
