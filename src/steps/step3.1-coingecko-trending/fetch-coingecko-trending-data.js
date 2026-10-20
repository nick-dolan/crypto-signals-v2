import { sleep } from "radash"
import { indexBinanceMarkets } from "../../api/coingecko/index-binance-markets.js"
import { requestCoinGeckoJson } from "../../api/coingecko/request.js"
import { isArray } from "../../helpers/utils.typed.js"
import { normalizeCoinGeckoTrending, selectCoinGeckoTrendingCoins } from "./build-coingecko-trending-context.js"

export async function fetchCoinGeckoTrendingData ({
  sourceCoinList,
  request = requestCoinGeckoJson,
  pause = sleep,
  onProgress = () => {},
} = {}) {
  if (!isArray(sourceCoinList?.coins)) {
    throw new Error("CoinGecko fetcher requires a coin list array")
  }

  const [trending, futures] = await Promise.all([
    request("/search/trending"),
    request("/derivatives/exchanges/binance_futures", {
      searchParams: { include_tickers: "unexpired" },
    }),
  ])
  const { coins } = normalizeCoinGeckoTrending(trending)

  const { coinIdsByMarket } = indexBinanceMarkets(futures)
  const matchedCoins = selectCoinGeckoTrendingCoins(sourceCoinList, coins, coinIdsByMarket)
  const coinCategories = []

  for (const coin of matchedCoins) {
    // Space out coin-detail requests to respect CoinGecko's public rate limits.
    await pause(2_000)
    const details = await request(`/coins/${encodeURIComponent(coin.id)}`, {
      searchParams: {
        localization: false,
        tickers: false,
        market_data: false,
        community_data: false,
        developer_data: false,
        sparkline: false,
      },
    })

    if (details?.id !== coin.id || !isArray(details.categories)) {
      throw new Error(`CoinGecko ${coin.id} response must contain its ID and categories array`)
    }

    coinCategories.push({ id: coin.id, categories: details.categories })
    onProgress({ index: coinCategories.length, total: matchedCoins.length, coinId: coin.id })
  }

  return { trending, futures, coinCategories }
}
