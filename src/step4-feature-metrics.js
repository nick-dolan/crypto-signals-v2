import { writeTmpJson } from "./helpers/fs-helper.js"
import { runStep } from "./helpers/run-step-helper.js"
import { buildBaseSeries } from "./steps/step4-feature-metrics/build-base-series.js"
import { buildFeatureProfiles } from "./steps/step4-feature-metrics/build-feature-profiles.js"
import { buildUniverseContext } from "./steps/step4-feature-metrics/build-universe-context.js"
import { readFeatureInput } from "./steps/step4-feature-metrics/read-feature-input.js"

function logProgress (event) {
  const marker = event.status === "complete" ? "✓" : "✗"
  const details = event.status === "complete"
    ? ""
    : ` — ${event.unavailableMetrics.join(", ")}`

  console.log(
    `${marker} ${event.index}/${event.total} ${event.coin.symbol}${details}`,
  )
}

async function runFeatureMetricsStep () {
  const input = await readFeatureInput()
  const baseCoins = buildBaseSeries(input)
  const universeContext = buildUniverseContext(baseCoins, input.marketContext)
  const { profiles, rejected } = buildFeatureProfiles(
    baseCoins,
    universeContext,
    { onProgress: logProgress },
  )
  const output = {
    generatedAt: new Date().toISOString(),
    asOf: new Date(universeContext.times.at(-1) * 1_000).toISOString(),
    source: "tradingview",
    timeframe: "1h",
    marketContext: {
      breadth: universeContext.universeBreadth4h.at(-1),
      segmentRotation: universeContext.segmentRotation4h.at(-1),
      stablecapChange: universeContext.stablecapChange24h.at(-1),
    },
    coinCount: profiles.length,
    rejectedCoinCount: rejected.length,
    profiles,
    rejected,
  }
  const outputPath = await writeTmpJson("step4-feature-metrics.json", output)

  console.log(`✓ Saved ${profiles.length} feature profiles to ${outputPath}`)

  if (rejected.length > 0) {
    console.log(`✗ Skipped ${rejected.length} incomplete profiles`)
  }
}

await runStep("step4-feature-metrics.js", runFeatureMetricsStep)
