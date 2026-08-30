import { fetchTradingViewCoins } from "../../api/tradingview/coin-screener.js"
import { fetchTradingViewCryptoMarkets } from "../../api/tradingview/crypto-market-screener.js"

export async function fetchCryptoUniverseData () {
  const candidates = await fetchTradingViewCoins({ rankMax: 500 })

  const markets = await fetchTradingViewCryptoMarkets({
    baseCurrencyIds: candidates.map(candidate => candidate.baseCurrencyId),
    exchanges: ["BINANCE"],
    instrumentTypes: ["swap"],
    quoteSymbols: ["USDT"],
  })

  return { candidates, markets }
}
