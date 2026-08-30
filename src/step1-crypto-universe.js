import {
  getActiveCoverageExclusionIds,
  getPermanentCoverageExclusionIds,
  readCoverageExclusions,
  readPermanentCoverageExclusions,
} from "./helpers/coverage-exclusions-helper.js"
import { writeTmpJson } from "./helpers/fs-helper.js"
import { runStep } from "./helpers/run-step-helper.js"
import { buildCryptoUniverse } from "./steps/step1-crypto-universe/build-crypto-universe.js"
import { fetchCryptoUniverseData } from "./steps/step1-crypto-universe/fetch-crypto-universe-data.js"

async function runCryptoUniverseStep () {
  const { candidates, markets } = await fetchCryptoUniverseData()
  const [coverageExclusions, permanentCoverageExclusions] = await Promise.all([
    readCoverageExclusions(),
    readPermanentCoverageExclusions(),
  ])
  const coverageExcludedBaseCurrencyIds = new Set([
    ...getActiveCoverageExclusionIds(coverageExclusions),
    ...getPermanentCoverageExclusionIds(permanentCoverageExclusions),
  ])
  const universe = buildCryptoUniverse(candidates, markets, {
    coverageExcludedBaseCurrencyIds,
  })
  const outputPath = await writeTmpJson("step1-crypto-universe.json", universe)

  console.log(`✓ Loaded ${universe.candidateCount} globally ranked coins`)
  console.log(`✓ Matched ${universe.marketMatchedCandidateCount} Binance USDT perpetual markets`)
  console.log(`✓ Saved ${universe.coinCount} candidate coins to ${outputPath}`)
  console.log(`✓ Excluded ${universe.excludedStablecoinCount} stablecoins`)
  console.log(`✓ Excluded ${universe.excludedCoverageCount} coins with unavailable data`)
  console.log(`✓ Excluded ${universe.excludedMissingMarketCount} coins without a matching market`)
}

await runStep("step1-crypto-universe.js", runCryptoUniverseStep)
