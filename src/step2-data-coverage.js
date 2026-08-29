import { readTmpJson, writeTmpJson } from "./helpers/fs-helper.js"
import { buildDataCoverageReport } from "./steps/step2-data-coverage/build-data-coverage-report.js"

async function runDataCoverageStep () {
  const sourceUniverse = await readTmpJson("step1-crypto-universe.json")
  const output = await buildDataCoverageReport(sourceUniverse)
  const outputPath = await writeTmpJson("step2-complete-crypto-universe.json", output)

  console.log(`✓ Saved ${output.coinCount}/${output.targetCoinCount} complete coins to ${outputPath}`)
  console.log(`✓ Rejected ${output.rejected.length} checked candidates`)
  console.log(`✓ Left ${output.uncheckedCandidateCount} candidates unchecked`)
}

await runDataCoverageStep()
