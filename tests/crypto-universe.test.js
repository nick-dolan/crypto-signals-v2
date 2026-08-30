import assert from "node:assert/strict"
import test from "node:test"
import { buildCryptoUniverse } from "../src/steps/step1-crypto-universe/build-crypto-universe.js"

import { selectUniverseMarketsByBaseCurrencyId } from "../src/steps/step1-crypto-universe/crypto-universe-helpers.js"

function createCandidate (
  rank,
  {
    baseCurrencyId = `asset-${rank}`,
    categories = [],
  } = {},
) {
  return {
    rank,
    baseCurrencyId,
    symbol: `COIN${rank}`,
    name: `Coin ${rank}`,
    tradingViewSymbol: `CRYPTO:COIN${rank}USD`,
    categories,
    circulatingSupply: rank * 1_000_000,
    marketCap: rank * 10_000_000,
    fullyDilutedValuation: rank * 12_000_000,
  }
}

function createMarket (
  rank,
  {
    baseCurrencyId = `asset-${rank}`,
    baseSymbol = `COIN${rank}`,
    exchange = "BINANCE",
    instrumentType = "swap",
    quoteSymbol = "USDT",
    typeSpecifications = ["crypto", "perpetual"],
    volume24hUsd = rank * 1_000_000,
  } = {},
) {
  const symbol = `${baseSymbol}USDT.P`

  return {
    tradingViewSymbol: `${exchange}:${symbol}`,
    symbol,
    baseSymbol,
    baseCurrencyId,
    quoteSymbol,
    exchange,
    price: rank,
    volume24hUsd,
    instrumentType,
    typeSpecifications,
  }
}

test("crypto universe uses the production collection defaults", () => {
  const candidates = Array.from(
    { length: 500 },
    (_, index) => createCandidate(index + 1),
  )
  const markets = candidates.map(candidate => createMarket(candidate.rank))
  const universe = buildCryptoUniverse(candidates, markets, {
    generatedAt: "2026-08-28T12:00:00Z",
  })

  assert.equal(universe.candidateCount, 500)
  assert.equal(universe.marketMatchedCandidateCount, 500)
  assert.equal(universe.coinCount, 250)
  assert.equal(universe.coins.at(-1).rank, 250)
  assert.throws(
    () => buildCryptoUniverse([createCandidate(501)], [createMarket(501)]),
    /must be between 1 and 500/,
  )
})

test("crypto universe keeps ranked non-stable coins with Binance perpetual markets", () => {
  const universe = buildCryptoUniverse(
    [
      createCandidate(5),
      createCandidate(2, { categories: ["Stablecoins"] }),
      createCandidate(1, {
        categories: ["cryptocurrencies", "layer-1"],
      }),
      createCandidate(4),
      createCandidate(3),
    ],
    [
      createMarket(1),
      createMarket(2),
      createMarket(3),
      createMarket(4),
    ],
    {
      candidateRankMax: 5,
      generatedAt: "2026-08-28T12:00:00Z",
      targetCount: 3,
    },
  )

  assert.equal(universe.generatedAt, "2026-08-28T12:00:00.000Z")
  assert.deepEqual(universe.selection, {
    exchange: "BINANCE",
    quoteSymbol: "USDT",
    instrumentType: "swap",
    typeSpecification: "perpetual",
  })
  assert.equal(universe.candidateCount, 5)
  assert.equal(universe.marketMatchedCandidateCount, 3)
  assert.equal(universe.excludedStablecoinCount, 1)
  assert.equal(universe.excludedCoverageCount, 0)
  assert.equal(universe.excludedMissingMarketCount, 1)
  assert.equal(universe.unselectedEligibleCount, 0)
  assert.deepEqual(universe.coins.map(coin => coin.rank), [1, 3, 4])
  assert.deepEqual(universe.coins[0].market, {
    tradingViewSymbol: "BINANCE:COIN1USDT.P",
    symbol: "COIN1USDT.P",
    baseSymbol: "COIN1",
    baseCurrencyId: "asset-1",
    quoteSymbol: "USDT",
    exchange: "BINANCE",
    price: 1,
    volume24hUsd: 1_000_000,
    instrumentType: "swap",
    typeSpecifications: ["crypto", "perpetual"],
  })
})

test("crypto universe filters active coverage exclusions before filling its target", () => {
  const universe = buildCryptoUniverse(
    [1, 2, 3, 4].map(rank => createCandidate(rank)),
    [1, 2, 3, 4].map(rank => createMarket(rank)),
    {
      candidateRankMax: 4,
      coverageExcludedBaseCurrencyIds: new Set(["asset-2"]),
      targetCount: 3,
    },
  )

  assert.equal(universe.excludedCoverageCount, 1)
  assert.deepEqual(universe.coins.map(coin => coin.rank), [1, 3, 4])
})

test("market selection keeps the most liquid matching perpetual per identity", () => {
  const selected = selectUniverseMarketsByBaseCurrencyId([
    createMarket(1, { volume24hUsd: 1_000 }),
    createMarket(1, { volume24hUsd: 2_000 }),
    createMarket(2, { exchange: "BYBIT" }),
    createMarket(3, { quoteSymbol: "USD" }),
    createMarket(4, { instrumentType: "spot" }),
    createMarket(5, { typeSpecifications: ["crypto"] }),
  ])

  assert.equal(selected.size, 1)
  assert.equal(selected.get("asset-1").volume24hUsd, 2_000)
})

test("crypto universe joins coins and markets only by baseCurrencyId", () => {
  assert.throws(
    () => buildCryptoUniverse(
      [createCandidate(1, { baseCurrencyId: "XTVCPEPE" })],
      [createMarket(1, {
        baseCurrencyId: "XTVC1000PEPE",
        baseSymbol: "1000PEPE",
      })],
      {
        candidateRankMax: 1,
        targetCount: 1,
      },
    ),
    /expected 1 eligible Binance USDT perpetual coins, found 0/,
  )
})

test("crypto universe rejects duplicate baseCurrencyId values", () => {
  assert.throws(
    () => buildCryptoUniverse(
      [
        createCandidate(1, { baseCurrencyId: "duplicate-id" }),
        createCandidate(2, { baseCurrencyId: "duplicate-id" }),
      ],
      [createMarket(1, { baseCurrencyId: "duplicate-id" })],
      {
        candidateRankMax: 2,
        targetCount: 1,
      },
    ),
    /duplicate baseCurrencyId: duplicate-id/,
  )
})

test("crypto universe requires the requested number of eligible markets", () => {
  assert.throws(
    () => buildCryptoUniverse(
      [createCandidate(1), createCandidate(2)],
      [createMarket(1)],
      {
        candidateRankMax: 2,
        targetCount: 2,
      },
    ),
    /expected 2 eligible Binance USDT perpetual coins, found 1/,
  )
})
