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
  return Object.fromEntries(Object.entries({
    ohlcv: 90 * 24,
    volumeDelta: 30 * 24,
    openInterest: 30 * 24,
    fundingRate: 90 * 24,
    premium: 30 * 24,
    socialDominance: 30 * 24,
    interactions: 30 * 24,
    activeContributors: 30 * 24,
    createdPosts: 30 * 24,
  }).map(([key, hours]) => [key, {
    hours,
    minValues: getMinimumHistoryValues(hours, 120 / 168),
  }]))
}

export function createDataBootstrapDescription () {
  return {
    timeframe: "1h",
    requestedHours: 100 * 24,
    dataDirectory: "tmp/step2-data-bootstrap",
    recentCoverage: {
      hours: 168,
      minDenseValues: 120,
      maxStalenessHours: 24,
    },
    historyRequirements: describeHistoryRequirements(),
    unavailableMetricConfirmationAttempts: 2,
    requiredStudies: [
      "volumeDelta",
      "openInterest",
      "fundingRate",
      "liquidations",
      "longShortRatioAccounts",
      "topTradersLongShortPositions",
      "premium",
      "socialDominance",
      "interactions",
      "activeContributors",
      "createdPosts",
    ],
    requiredMetadata: [
      "circulatingSupply",
      "marketCap",
      "fullyDilutedValuation",
    ],
    optionalMetadata: ["categories"],
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
