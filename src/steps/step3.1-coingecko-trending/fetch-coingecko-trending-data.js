import { sleep } from "radash"
import { requestCoinGeckoJson } from "../../api/coingecko/request.js"
import { isArray } from "../../helpers/utils.typed.js"
import { normalizeCoinGeckoTrending } from "./build-coingecko-trending-context.js"

export async function fetchCoinGeckoTrendingData ({
  request = requestCoinGeckoJson,
  pause = sleep,
  onProgress = () => {},
} = {}) {
  const [trending, futures] = await Promise.all([
    request("/search/trending"),
    request("/derivatives/exchanges/binance_futures", {
      searchParams: { include_tickers: "unexpired" },
    }),
  ])
  const { coins } = normalizeCoinGeckoTrending(trending)

  if (!isArray(futures?.tickers)) {
    throw new Error("CoinGecko Binance Futures response must contain a tickers array")
  }

  const coinCategories = []

  for (const coin of coins) {
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
    onProgress({ index: coinCategories.length, total: coins.length, coinId: coin.id })
  }

  return { trending, futures, coinCategories }
}
