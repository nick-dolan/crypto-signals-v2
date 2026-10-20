import {
  getActiveCoverageExclusionIds,
  getPermanentCoverageExclusionIds,
  readCoverageExclusions,
  readPermanentCoverageExclusions,
} from "./helpers/coverage-exclusions-helper.js"
import { writeTmpJson } from "./helpers/fs-helper.js"
import { runStep } from "./helpers/run-step-helper.js"
import { buildCoinList } from "./steps/step1-coin-list/build-coin-list.js"
import { fetchCoinListData } from "./steps/step1-coin-list/fetch-coin-list-data.js"

async function runCoinListStep () {
  const { candidates, markets } = await fetchCoinListData()
  const [coverageExclusions, permanentCoverageExclusions] = await Promise.all([
    readCoverageExclusions(),
    readPermanentCoverageExclusions(),
  ])
  const coverageExcludedBaseCurrencyIds = new Set([
    ...getActiveCoverageExclusionIds(coverageExclusions),
    ...getPermanentCoverageExclusionIds(permanentCoverageExclusions),
  ])
  const coinList = buildCoinList(candidates, markets, {
    coverageExcludedBaseCurrencyIds,
  })
  const outputPath = await writeTmpJson("step1-coin-list.json", coinList)

  console.log(`✓ Loaded ${coinList.candidateCount} globally ranked coins`)
  console.log(`✓ Matched ${coinList.marketMatchedCandidateCount} Binance USDT perpetual markets`)
  console.log(`✓ Saved ${coinList.coinCount} candidate coins to ${outputPath}`)
  console.log(`✓ Excluded ${coinList.excludedStablecoinCount} stablecoins`)
  console.log(`✓ Excluded ${coinList.excludedCoverageCount} coins with unavailable data`)
  console.log(`✓ Excluded ${coinList.excludedMissingMarketCount} coins without a matching market`)
}

await runStep("step1-coin-list.js", runCoinListStep)
