import { getRequiredString } from "../../helpers/normalization-helper.js"
import { isArray, isString } from "../../helpers/utils.typed.js"

export function indexBinanceMarkets (futures) {
  if (!isArray(futures?.tickers)) {
    throw new Error("CoinGecko Binance Futures response must contain a tickers array")
  }

  const coinIdsByMarket = new Map()
  let skippedMissingCoinIdCount = 0

  for (const ticker of futures.tickers) {
    if (ticker?.target !== "USDT" || ticker?.contract_type !== "perpetual") {
      continue
    }

    if (!isString(ticker.coin_id) || !ticker.coin_id.trim()) {
      skippedMissingCoinIdCount += 1
      continue
    }

    const coinId = ticker.coin_id.trim()
    const symbol = getRequiredString(ticker.symbol, "CoinGecko Binance Futures symbol")
    const marketSymbol = `BINANCE:${symbol}.P`
    const previousId = coinIdsByMarket.get(marketSymbol)

    if (previousId && previousId !== coinId) {
      throw new Error(`CoinGecko Binance market ${marketSymbol} has conflicting coin IDs`)
    }

    coinIdsByMarket.set(marketSymbol, coinId)
  }

  return { coinIdsByMarket, skippedMissingCoinIdCount }
}
