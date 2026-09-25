import { indexBinanceMarkets } from "../../api/coingecko/index-binance-markets.js"
import { getRequiredString, toIsoTimestamp } from "../../helpers/normalization-helper.js"
import { isArray } from "../../helpers/utils.typed.js"

export function normalizeCoinGeckoTrending (trending) {
  if (!isArray(trending?.coins) || !isArray(trending?.categories)) {
    throw new Error("CoinGecko trending response must contain coins and categories arrays")
  }

  const coins = trending.coins.map(({ item }) => ({
    id: getRequiredString(item?.id, "CoinGecko trending coin id"),
    symbol: getRequiredString(item?.symbol, "CoinGecko trending coin symbol"),
    name: getRequiredString(item?.name, "CoinGecko trending coin name"),
  }))

  if (new Set(coins.map(coin => coin.id)).size !== coins.length) {
    throw new Error("CoinGecko trending response contains duplicate coin IDs")
  }

  return {
    coins,
    categories: trending.categories.map(category => ({
      id: category.id,
      slug: getRequiredString(category.slug, "CoinGecko trending category slug"),
      name: getRequiredString(category.name, "CoinGecko trending category name"),
    })),
  }
}

export function buildCoinGeckoTrendingContext (
  sourceUniverse,
  { trending, futures, coinCategories },
  { generatedAt = new Date().toISOString() } = {},
) {
  if (!isArray(sourceUniverse?.coins) || !isArray(coinCategories)) {
    throw new Error("CoinGecko context requires universe coins and coin categories arrays")
  }

  const normalized = normalizeCoinGeckoTrending(trending)
  const categoriesById = new Map(coinCategories.map(coin => [coin.id, coin.categories]))
  const trendingCoins = normalized.coins.map((coin) => {
    const categories = categoriesById.get(coin.id)

    if (!isArray(categories)) {
      throw new Error(`CoinGecko categories are missing for ${coin.id}`)
    }

    const names = categories.map(category => getRequiredString(
      category,
      `CoinGecko ${coin.id} category name`,
    ))
    const categoryNames = new Set(names.map(name => name.toLowerCase()))

    return {
      ...coin,
      categories: names,
      trendingCategories: normalized.categories
        .filter(category => categoryNames.has(category.name.toLowerCase()))
        .map(category => category.name),
    }
  })
  const trendingById = new Map(trendingCoins.map(coin => [coin.id, coin]))
  const { coinIdsByMarket, skippedMissingCoinIdCount } = indexBinanceMarkets(futures)
  const matches = sourceUniverse.coins.flatMap((coin) => {
    const marketSymbol = coin.market.tradingViewSymbol
    const trendingCoin = trendingById.get(coinIdsByMarket.get(marketSymbol))

    return trendingCoin
      ? [{
          baseCurrencyId: coin.baseCurrencyId,
          marketSymbol,
          coingecko: {
            id: trendingCoin.id,
            isTrending: true,
            trendingCategories: [...trendingCoin.trendingCategories],
          },
        }]
      : []
  })

  return {
    generatedAt: toIsoTimestamp(generatedAt, "generatedAt"),
    universeGeneratedAt: toIsoTimestamp(sourceUniverse.generatedAt, "universeGeneratedAt"),
    source: "coingecko",
    skippedMissingCoinIdCount,
    trendingCategories: normalized.categories,
    trendingCoins,
    matches,
  }
}
