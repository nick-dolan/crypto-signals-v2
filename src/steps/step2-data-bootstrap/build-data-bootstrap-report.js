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

export function createDataBootstrapDescription () {
  return {
    timeframe: "1h",
    requestedHours: 2_400,
    requestRange: 2_401,
    dataDirectory: "tmp/step2-data-bootstrap",
    requireCompleteHourlyGrid: true,
    requiredHoursBySource: {
      ohlcv: 2_400,
      volumeDelta: 1_666,
      openInterest: 2_400,
      fundingRate: 2_400,
      liquidations: 2_400,
      longShortRatioAccounts: 2_400,
      topTradersLongShortPositions: 2_400,
      premium: 2_400,
      socialDominance: 2_400,
      interactions: 2_400,
      activeContributors: 2_400,
      createdPosts: 2_400,
    },
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

export function createDataBootstrapSummary ({
  generatedAt,
  source,
  selection,
  candidateCount,
  coinCount,
}) {
  return {
    generatedAt,
    source,
    selection,
    candidateCount,
    coinCount,
  }
}

export async function buildDataBootstrapReport (sourceUniverse) {
  const nowTimestamp = Number(process.env.PIPELINE_STARTED_AT) || Math.floor(Date.now() / 1_000)

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
