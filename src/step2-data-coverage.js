import { connectTradingView, disconnectTradingView } from "./api/tradingview/client.js"
import { readTmpJson, writeTmpJson } from "./helpers/fs-helper.js"
import { buildCompleteCryptoUniverse } from "./steps/step2-data-coverage/build-complete-crypto-universe.js"
import { checkCoinDataCoverage } from "./steps/step2-data-coverage/check-coin-data-coverage.js"
import {
  DATA_COVERAGE_MAX_STALENESS_HOURS,
  DATA_COVERAGE_MIN_DENSE_VALUES,
  DATA_COVERAGE_PROBE_HOURS,
  DATA_COVERAGE_TARGET_COUNT,
} from "./steps/step2-data-coverage/config.js"
import { REQUIRED_STUDY_KEYS } from "./steps/step2-data-coverage/coverage-study-definitions.js"

const INPUT_FILENAME = "step1-crypto-universe.json"
const OUTPUT_FILENAME = "step2-complete-crypto-universe.json"

function getCandidateCoins (universe) {
  if (!universe || typeof universe !== "object" || !Array.isArray(universe.coins)) {
    throw new Error(`${INPUT_FILENAME} does not contain a coins array`)
  }

  return universe.coins
}

function logProgress (event) {
  if (event.status === "retrying") {
    console.log(
      `↻ #${event.coin.rank} ${event.coin.symbol}: retrying after ${event.result.reasonCodes.join(", ")}`,
    )
    return
  }

  if (event.status === "accepted") {
    console.log(
      `✓ #${event.coin.rank} ${event.coin.symbol} — ${event.market.tradingViewSymbol}`,
    )
    return
  }

  console.log(
    `✗ #${event.coin.rank} ${event.coin.symbol} — ${event.rejection.reasonCodes.join(", ")}`,
  )
}

async function runDataCoverageStep () {
  const sourceUniverse = await readTmpJson(INPUT_FILENAME)
  const candidates = getCandidateCoins(sourceUniverse)
  const nowTimestamp = Math.floor(Date.now() / 1000)

  console.log(`✓ Loaded ${candidates.length} ranked Binance USDT perpetual candidates`)

  await connectTradingView()

  try {
    const report = await buildCompleteCryptoUniverse(
      candidates,
      async (coin, market) => {
        const client = await connectTradingView()

        return checkCoinDataCoverage(
          client,
          coin,
          market,
          { nowTimestamp },
        )
      },
      {
        onProgress: logProgress,
        targetCount: DATA_COVERAGE_TARGET_COUNT,
      },
    )
    const output = {
      ...report,
      probe: {
        timeframe: "1h",
        hours: DATA_COVERAGE_PROBE_HOURS,
        minDenseValues: DATA_COVERAGE_MIN_DENSE_VALUES,
        maxStalenessHours: DATA_COVERAGE_MAX_STALENESS_HOURS,
        requiredStudies: REQUIRED_STUDY_KEYS,
        requiredMetadata: [
          "circulatingSupply",
          "marketCap",
          "fullyDilutedValuation",
        ],
        optionalMetadata: ["categories"],
      },
    }
    const outputPath = await writeTmpJson(OUTPUT_FILENAME, output)

    console.log(`✓ Saved ${output.coinCount}/${output.targetCoinCount} complete coins to ${outputPath}`)
    console.log(`✓ Rejected ${output.rejected.length} checked candidates`)
    console.log(`✓ Left ${output.uncheckedCandidateCount} candidates unchecked`)
  } finally {
    await disconnectTradingView()
  }
}

await runDataCoverageStep()
