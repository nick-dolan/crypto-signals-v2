import { updateCoverageExclusions } from "./helpers/coverage-exclusions-helper.js"
import {
  readTmpJson,
  resetTmpSubdirectory,
  writeTmpJson,
} from "./helpers/fs-helper.js"
import { runStep } from "./helpers/run-step-helper.js"
import {
  buildDataBootstrapReport,
  createDataBootstrapSummary,
} from "./steps/step2-data-bootstrap/build-data-bootstrap-report.js"

async function runDataBootstrapStep () {
  const sourceUniverse = await readTmpJson("step1-crypto-universe.json")

  const dataDirectoryPath = await resetTmpSubdirectory("step2-data-bootstrap")
  const report = await buildDataBootstrapReport(sourceUniverse)
  const checkedCoins = [...report.coins, ...report.rejected]
  const excludedCoins = report.rejected
    .filter(coin => coin.confirmedUnavailableMetrics.length > 0)
    .map(coin => ({
      ...coin,
      unavailableMetrics: coin.confirmedUnavailableMetrics,
    }))
  await updateCoverageExclusions({
    checkedBaseCurrencyIds: checkedCoins.map(coin => coin.baseCurrencyId),
    excludedCoins,
  })
  const output = createDataBootstrapSummary(report)
  const outputPath = await writeTmpJson("step2-data-bootstrap.json", output)

  console.log(`✓ Saved ${output.coinCount} complete coins to ${outputPath}`)
  console.log(`✓ Saved fetched hourly data under ${dataDirectoryPath}`)
  console.log(`✓ Rejected ${report.rejected.length} candidates`)
  console.log(`✓ Recorded ${excludedCoins.length} unavailable coins in coverage exclusions`)
}

await runStep("step2-data-bootstrap.js", runDataBootstrapStep)
