import path from "node:path"

import { updateCoverageExclusions } from "./helpers/coverage-exclusions-helper.js"
import { readTmpJson, writeTmpJson } from "./helpers/fs-helper.js"
import { buildDataBootstrapReport } from "./steps/step2-data-bootstrap/build-data-bootstrap-report.js"

async function runDataBootstrapStep () {
  const sourceUniverse = await readTmpJson("step1-crypto-universe.json")
  const report = await buildDataBootstrapReport(sourceUniverse)
  const checkedCoins = [...report.coins, ...report.rejected]
  const excludedCoins = report.rejected
    .filter(coin => coin.confirmedUnavailableMetrics.length > 0)
    .map(coin => ({
      ...coin,
      unavailableMetrics: coin.confirmedUnavailableMetrics,
    }))
  const exclusionUpdate = await updateCoverageExclusions({
    checkedBaseCurrencyIds: checkedCoins.map(coin => coin.baseCurrencyId),
    excludedCoins,
  })
  const output = {
    ...report,
    coverageExclusions: {
      file: path.relative(process.cwd(), exclusionUpdate.filePath),
      excludedNowCount: exclusionUpdate.excludedNowCount,
      activeCount: exclusionUpdate.activeCount,
    },
  }
  const outputPath = await writeTmpJson("step2-data-bootstrap.json", output)

  console.log(`✓ Saved ${output.coinCount}/${output.targetCoinCount} complete coins with hourly history to ${outputPath}`)
  console.log(`✓ Rejected ${output.rejected.length} checked candidates`)
  console.log(`✓ Recorded ${excludedCoins.length} unavailable coins in coverage exclusions`)
  console.log(`✓ Left ${output.uncheckedCandidateCount} candidates unchecked`)
}

await runDataBootstrapStep()
