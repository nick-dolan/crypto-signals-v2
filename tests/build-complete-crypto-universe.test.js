import assert from "node:assert/strict"
import test from "node:test"
import { buildCompleteCryptoUniverse } from "../src/steps/step2-data-coverage/build-complete-crypto-universe.js"

function createMarket (
  baseCurrencyId,
  {
    exchange = "BINANCE",
    instrumentType = "swap",
    quoteSymbol = "USDT",
    symbol = `${baseCurrencyId}USDT.P`,
    typeSpecifications = ["crypto", "perpetual"],
    volume24hUsd = 1_000_000,
  } = {},
) {
  return {
    tradingViewSymbol: `BINANCE:${symbol}`,
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

function createCoverageResult (complete, retryable = false) {
  return {
    complete,
    retryable,
    reasonCodes: complete ? [] : ["premium:insufficient_values"],
    reasons: complete ? [] : ["Premium is unavailable"],
    coverage: {
      ohlcv: {
        completePeriodCount: 168,
      },
    },
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
    candidates,
    async (coin, market) => {
      checkedIds.push(coin.baseCurrencyId)
      assert.equal(market, coin.market)

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
  assert.equal(report.targetReached, true)
  assert.equal(report.checkedCandidateCount, 3)
  assert.equal(report.uncheckedCandidateCount, 1)
  assert.equal(report.liveCheckedCount, 3)
  assert.equal(report.marketMatchedCandidateCount, 4)
})

test("complete universe allows fewer coins than target and retries transient failures", async () => {
  let attempts = 0
  const report = await buildCompleteCryptoUniverse(
    [createCoin(1)],
    async () => {
      attempts += 1

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

test("complete universe requires a preselected Binance perpetual market", async () => {
  await assert.rejects(
    buildCompleteCryptoUniverse(
      [createCoin(1, { market: null })],
      async () => createCoverageResult(true),
    ),
    /market is required/,
  )

  await assert.rejects(
    buildCompleteCryptoUniverse(
      [createCoin(1, {
        market: createMarket("XTVC1", { exchange: "BYBIT" }),
      })],
      async () => createCoverageResult(true),
    ),
    /must be a Binance USDT perpetual/,
  )
})
