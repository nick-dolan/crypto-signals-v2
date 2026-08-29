import { fetchTradingViewCoins } from "./api/tradingview/coin-screener.js"
import { fetchTradingViewCryptoMarkets } from "./api/tradingview/crypto-market-screener.js"
import { writeTmpJson } from "./helpers/fs-helper.js"
import { buildCryptoUniverse } from "./steps/step1-crypto-universe/build-crypto-universe.js"
import {
  CRYPTO_UNIVERSE_CANDIDATE_RANK_MAX,
  CRYPTO_UNIVERSE_EXCHANGE,
  CRYPTO_UNIVERSE_INSTRUMENT_TYPE,
  CRYPTO_UNIVERSE_QUOTE_SYMBOL,
} from "./steps/step1-crypto-universe/config.js"

async function runCryptoUniverseStep () {
  const candidates = await fetchTradingViewCoins({
    rankMax: CRYPTO_UNIVERSE_CANDIDATE_RANK_MAX,
  })
  const markets = await fetchTradingViewCryptoMarkets({
    baseCurrencyIds: candidates.map(candidate => candidate.baseCurrencyId),
    exchanges: [CRYPTO_UNIVERSE_EXCHANGE],
    instrumentTypes: [CRYPTO_UNIVERSE_INSTRUMENT_TYPE],
    quoteSymbols: [CRYPTO_UNIVERSE_QUOTE_SYMBOL],
  })
  const universe = buildCryptoUniverse(candidates, markets)
  const outputPath = await writeTmpJson("step1-crypto-universe.json", universe)

  console.log(`✓ Loaded ${universe.candidateCount} globally ranked coins`)
  console.log(`✓ Matched ${universe.marketMatchedCandidateCount} Binance USDT perpetual markets`)
  console.log(`✓ Saved ${universe.coinCount} candidate coins to ${outputPath}`)
  console.log(`✓ Excluded ${universe.excludedStablecoinCount} stablecoins`)
  console.log(`✓ Excluded ${universe.excludedMissingMarketCount} coins without a matching market`)
}

await runCryptoUniverseStep()
