import { readTmpJson, writeTmpJson } from "./helpers/fs-helper.js"
import { runStep } from "./helpers/run-step-helper.js"
import { buildPreliminaryShortlist } from "./steps/step5-preliminary-filter/build-preliminary-shortlist.js"

async function runPreliminaryFilterStep () {
  const featureMetrics = await readTmpJson("step4-feature-metrics.json")
  const shortlist = buildPreliminaryShortlist(featureMetrics.profiles)

  if (featureMetrics.coinCount !== shortlist.universeCoinCount) {
    throw new Error(
      `Step 4 declares ${featureMetrics.coinCount} profiles but contains ${shortlist.universeCoinCount}`,
    )
  }

  const output = {
    generatedAt: new Date().toISOString(),
    featuresGeneratedAt: featureMetrics.generatedAt,
    asOf: featureMetrics.asOf,
    source: featureMetrics.source,
    timeframe: featureMetrics.timeframe,
    marketContext: featureMetrics.marketContext,
    ...shortlist,
  }
  const outputPath = await writeTmpJson("step5-preliminary-filter.json", output)

  console.log(
    `✓ Selected ${output.candidateCount} of ${output.universeCoinCount} feature profiles`,
  )
  console.log(`✓ Saved preliminary shortlist to ${outputPath}`)
}

await runStep("step5-preliminary-filter.js", runPreliminaryFilterStep)
