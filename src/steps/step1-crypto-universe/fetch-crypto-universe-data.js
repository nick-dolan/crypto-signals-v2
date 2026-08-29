import { fetchTradingViewCoins } from "../../api/tradingview/coin-screener.js"
import { fetchTradingViewCryptoMarkets } from "../../api/tradingview/crypto-market-screener.js"
import {
  CRYPTO_UNIVERSE_CANDIDATE_RANK_MAX,
  CRYPTO_UNIVERSE_EXCHANGE,
  CRYPTO_UNIVERSE_INSTRUMENT_TYPE,
  CRYPTO_UNIVERSE_QUOTE_SYMBOL,
} from "./config.js"

export async function fetchCryptoUniverseData () {
  const candidates = await fetchTradingViewCoins({
    rankMax: CRYPTO_UNIVERSE_CANDIDATE_RANK_MAX,
  })

  const markets = await fetchTradingViewCryptoMarkets({
    baseCurrencyIds: candidates.map(candidate => candidate.baseCurrencyId),
    exchanges: [CRYPTO_UNIVERSE_EXCHANGE],
    instrumentTypes: [CRYPTO_UNIVERSE_INSTRUMENT_TYPE],
    quoteSymbols: [CRYPTO_UNIVERSE_QUOTE_SYMBOL],
  })

  return { candidates, markets }
}
