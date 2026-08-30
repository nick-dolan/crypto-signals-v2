import { connectTradingView, disconnectTradingView } from "./api/tradingview/client.js"
import { writeTmpJson } from "./helpers/fs-helper.js"
import { runStep } from "./helpers/run-step-helper.js"
import { fetchMarketContext } from "./steps/step3-market-context/fetch-market-context.js"

async function runMarketContextStep () {
  try {
    const client = await connectTradingView()
    const marketContext = await fetchMarketContext(client)
    const outputPath = await writeTmpJson(
      "step3-market-context.json",
      marketContext,
    )

    console.log(`✓ Saved ${Object.keys(marketContext.series).length} market context series to ${outputPath}`)
  } finally {
    await disconnectTradingView()
  }
}

await runStep("step3-market-context.js", runMarketContextStep)
