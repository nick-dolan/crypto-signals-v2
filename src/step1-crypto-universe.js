import { writeTmpJson } from "./helpers/fs-helper.js"
import { buildCryptoUniverse } from "./steps/step1-crypto-universe/build-crypto-universe.js"
import { fetchCryptoUniverseData } from "./steps/step1-crypto-universe/fetch-crypto-universe-data.js"

async function runCryptoUniverseStep () {
  const { candidates, markets } = await fetchCryptoUniverseData()
  const universe = buildCryptoUniverse(candidates, markets)
  const outputPath = await writeTmpJson("step1-crypto-universe.json", universe)

  console.log(`✓ Loaded ${universe.candidateCount} globally ranked coins`)
  console.log(`✓ Matched ${universe.marketMatchedCandidateCount} Binance USDT perpetual markets`)
  console.log(`✓ Saved ${universe.coinCount} candidate coins to ${outputPath}`)
  console.log(`✓ Excluded ${universe.excludedStablecoinCount} stablecoins`)
  console.log(`✓ Excluded ${universe.excludedMissingMarketCount} coins without a matching market`)
}

await runCryptoUniverseStep()
