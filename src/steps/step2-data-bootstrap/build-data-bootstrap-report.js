import {
  DATA_BOOTSTRAP_HISTORY_HOURS,
  DATA_COVERAGE_HISTORY_MIN_RATIO,
  DATA_COVERAGE_HISTORY_REQUIREMENTS,
  DATA_COVERAGE_MAX_STALENESS_HOURS,
  DATA_COVERAGE_MIN_DENSE_VALUES,
  DATA_COVERAGE_OPTIONAL_METADATA,
  DATA_COVERAGE_PROBE_HOURS,
  DATA_COVERAGE_REQUIRED_METADATA,
  DATA_COVERAGE_REQUIRED_STUDY_KEYS,
  DATA_COVERAGE_TIMEFRAME_LABEL,
  DATA_COVERAGE_UNAVAILABLE_CONFIRMATION_ATTEMPTS,
} from "./config.js"
import { connectTradingView, disconnectTradingView } from "../../api/tradingview/client.js"
import { buildCompleteCryptoUniverse } from "./build-complete-crypto-universe.js"
import { checkCoinDataCoverage } from "./check-coin-data-coverage.js"
import { getMinimumHistoryValues } from "./data-coverage-helpers.js"

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

function describeHistoryRequirements () {
  return Object.fromEntries(Object.entries(DATA_COVERAGE_HISTORY_REQUIREMENTS)
    .map(([key, hours]) => [key, {
      hours,
      minValues: getMinimumHistoryValues(
        hours,
        DATA_COVERAGE_HISTORY_MIN_RATIO,
      ),
    }]))
}

export function createDataBootstrapDescription () {
  return {
    timeframe: DATA_COVERAGE_TIMEFRAME_LABEL,
    requestedHours: DATA_BOOTSTRAP_HISTORY_HOURS,
    recentCoverage: {
      hours: DATA_COVERAGE_PROBE_HOURS,
      minDenseValues: DATA_COVERAGE_MIN_DENSE_VALUES,
      maxStalenessHours: DATA_COVERAGE_MAX_STALENESS_HOURS,
    },
    historyRequirements: describeHistoryRequirements(),
    unavailableMetricConfirmationAttempts: DATA_COVERAGE_UNAVAILABLE_CONFIRMATION_ATTEMPTS,
    requiredStudies: [...DATA_COVERAGE_REQUIRED_STUDY_KEYS],
    requiredMetadata: DATA_COVERAGE_REQUIRED_METADATA.map(({ field }) => field),
    optionalMetadata: [...DATA_COVERAGE_OPTIONAL_METADATA],
  }
}

export async function buildDataBootstrapReport (sourceUniverse) {
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
      bootstrap: createDataBootstrapDescription(),
    }
  } finally {
    await disconnectTradingView()
  }
}
