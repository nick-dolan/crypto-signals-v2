import { readTmpJson, writeTmpJson } from "./helpers/fs-helper.js"
import { runStep } from "./helpers/run-step-helper.js"
import { buildCoinGeckoTrendingContext } from "./steps/step3.1-coingecko-trending/build-coingecko-trending-context.js"
import { fetchCoinGeckoTrendingData } from "./steps/step3.1-coingecko-trending/fetch-coingecko-trending-data.js"

async function runCoinGeckoTrendingStep () {
  const sourceUniverse = await readTmpJson("step1-crypto-universe.json")
  const data = await fetchCoinGeckoTrendingData({
    onProgress: ({ index, total, coinId }) => {
      console.log(`✓ Loaded CoinGecko categories ${index}/${total}: ${coinId}`)
    },
  })
  const context = buildCoinGeckoTrendingContext(sourceUniverse, data)
  const outputPath = await writeTmpJson("step3.1-coingecko-trending.json", context)

  console.log(`✓ Loaded ${context.trendingCoins.length} trending coins and ${context.trendingCategories.length} trending categories`)
  console.log(`✓ Matched ${context.matches.length} trending coins with TradingView candidates`)
  console.log(`✓ Skipped ${context.skippedMissingCoinIdCount} Binance USDT perpetual markets without coin_id`)
  console.log(`✓ Saved CoinGecko context to ${outputPath}`)
}

await runStep("step3.1-coingecko-trending.js", runCoinGeckoTrendingStep)
