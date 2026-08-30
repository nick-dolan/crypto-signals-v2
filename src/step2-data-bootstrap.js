import path from "node:path"

import { updateCoverageExclusions } from "./helpers/coverage-exclusions-helper.js"
import {
  readTmpJson,
  resetTmpSubdirectory,
  writeTmpJson,
} from "./helpers/fs-helper.js"
import { buildDataBootstrapReport } from "./steps/step2-data-bootstrap/build-data-bootstrap-report.js"
import {
  DATA_BOOTSTRAP_REPORT_FILENAME,
  DATA_BOOTSTRAP_TMP_DIRECTORY,
} from "./steps/step2-data-bootstrap/config.js"

async function runDataBootstrapStep () {
  const sourceUniverse = await readTmpJson("step1-crypto-universe.json")

  const dataDirectoryPath = await resetTmpSubdirectory(
    DATA_BOOTSTRAP_TMP_DIRECTORY,
  )
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
  const outputPath = await writeTmpJson(DATA_BOOTSTRAP_REPORT_FILENAME, output)

  console.log(`✓ Saved ${output.coinCount}/${output.targetCoinCount} complete coins to ${outputPath}`)
  console.log(`✓ Saved fetched hourly data under ${dataDirectoryPath}`)
  console.log(`✓ Rejected ${output.rejected.length} checked candidates`)
  console.log(`✓ Recorded ${excludedCoins.length} unavailable coins in coverage exclusions`)
  console.log(`✓ Left ${output.uncheckedCandidateCount} candidates unchecked`)
}

await runDataBootstrapStep()
