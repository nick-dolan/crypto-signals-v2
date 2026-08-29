import {
  DATA_COVERAGE_MAX_STALENESS_HOURS,
  DATA_COVERAGE_MIN_DENSE_VALUES,
  DATA_COVERAGE_OPTIONAL_METADATA,
  DATA_COVERAGE_PROBE_HOURS,
  DATA_COVERAGE_REQUIRED_METADATA,
  DATA_COVERAGE_REQUIRED_STUDY_KEYS,
  DATA_COVERAGE_TIMEFRAME_LABEL,
} from "./config.js"
import { connectTradingView, disconnectTradingView } from "../../api/tradingview/client.js"
import { buildCompleteCryptoUniverse } from "./build-complete-crypto-universe.js"
import { checkCoinDataCoverage } from "./check-coin-data-coverage.js"

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

export function createDataCoverageProbeDescription () {
  return {
    timeframe: DATA_COVERAGE_TIMEFRAME_LABEL,
    hours: DATA_COVERAGE_PROBE_HOURS,
    minDenseValues: DATA_COVERAGE_MIN_DENSE_VALUES,
    maxStalenessHours: DATA_COVERAGE_MAX_STALENESS_HOURS,
    requiredStudies: [...DATA_COVERAGE_REQUIRED_STUDY_KEYS],
    requiredMetadata: DATA_COVERAGE_REQUIRED_METADATA.map(({ field }) => field),
    optionalMetadata: [...DATA_COVERAGE_OPTIONAL_METADATA],
  }
}

export async function buildDataCoverageReport (sourceUniverse) {
  const nowTimestamp = Math.floor(Date.now() / 1000)

  try {
    const report = await buildCompleteCryptoUniverse(
      sourceUniverse,
      async (coin) => {
        const client = await connectTradingView()

        return checkCoinDataCoverage(client, coin, { nowTimestamp })
      },
      { onProgress: logProgress },
    )

    return {
      ...report,
      probe: createDataCoverageProbeDescription(),
    }
  } finally {
    await disconnectTradingView()
  }
}
