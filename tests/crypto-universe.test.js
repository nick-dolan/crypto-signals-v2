import assert from "node:assert/strict"
import test from "node:test"
import { buildCryptoUniverse } from "../src/steps/step1-crypto-universe/build-crypto-universe.js"
import {
  CRYPTO_UNIVERSE_CANDIDATE_RANK_MAX,
  CRYPTO_UNIVERSE_TARGET_COUNT,
} from "../src/steps/step1-crypto-universe/config.js"

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

test("crypto universe uses the production collection defaults", () => {
  const candidates = Array.from(
    { length: CRYPTO_UNIVERSE_CANDIDATE_RANK_MAX },
    (_, index) => createCandidate(index + 1),
  )
  const universe = buildCryptoUniverse(candidates, {
    generatedAt: "2026-08-28T12:00:00Z",
  })

  assert.equal(CRYPTO_UNIVERSE_CANDIDATE_RANK_MAX, 300)
  assert.equal(CRYPTO_UNIVERSE_TARGET_COUNT, 250)
  assert.equal(universe.coinCount, 250)
  assert.equal(universe.coins.at(-1).rank, 250)
})

test("crypto universe excludes stablecoins and keeps rank order", () => {
  const universe = buildCryptoUniverse(
    [
      createCandidate(4),
      createCandidate(2, { categories: ["Stablecoins"] }),
      createCandidate(1, {
        categories: ["cryptocurrencies", "layer-1"],
      }),
      createCandidate(3),
    ],
    {
      candidateRankMax: 4,
      generatedAt: "2026-08-28T12:00:00Z",
      targetCount: 3,
    },
  )

  assert.deepEqual(universe, {
    generatedAt: "2026-08-28T12:00:00.000Z",
    source: "tradingview",
    coinCount: 3,
    excludedStablecoinCount: 1,
    coins: [
      {
        rank: 1,
        baseCurrencyId: "asset-1",
        symbol: "COIN1",
        name: "Coin 1",
        tradingViewSymbol: "CRYPTO:COIN1USD",
        categories: ["cryptocurrencies", "layer-1"],
        circulatingSupply: 1_000_000,
        marketCap: 10_000_000,
        fullyDilutedValuation: 12_000_000,
      },
      {
        rank: 3,
        baseCurrencyId: "asset-3",
        symbol: "COIN3",
        name: "Coin 3",
        tradingViewSymbol: "CRYPTO:COIN3USD",
        categories: [],
        circulatingSupply: 3_000_000,
        marketCap: 30_000_000,
        fullyDilutedValuation: 36_000_000,
      },
      {
        rank: 4,
        baseCurrencyId: "asset-4",
        symbol: "COIN4",
        name: "Coin 4",
        tradingViewSymbol: "CRYPTO:COIN4USD",
        categories: [],
        circulatingSupply: 4_000_000,
        marketCap: 40_000_000,
        fullyDilutedValuation: 48_000_000,
      },
    ],
  })
})

test("crypto universe rejects duplicate baseCurrencyId values", () => {
  assert.throws(
    () => buildCryptoUniverse(
      [
        createCandidate(1, { baseCurrencyId: "duplicate-id" }),
        createCandidate(2, { baseCurrencyId: "duplicate-id" }),
      ],
      {
        candidateRankMax: 2,
        targetCount: 1,
      },
    ),
    /duplicate baseCurrencyId: duplicate-id/,
  )
})

test("crypto universe requires the requested number of eligible coins", () => {
  assert.throws(
    () => buildCryptoUniverse(
      [
        createCandidate(1),
        createCandidate(2, { categories: ["stablecoins"] }),
      ],
      {
        candidateRankMax: 2,
        targetCount: 2,
      },
    ),
    /expected 2 eligible coins, found 1/,
  )
})
