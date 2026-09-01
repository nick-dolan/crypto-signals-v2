import { callCopilotWithTools } from "../../api/copilot/chat.js"
import { isString } from "../../helpers/utils.typed.js"
import { createCoinHistoryTool, validateAgentInputs } from "./create-coin-history-tool.js"
import {
  InvalidCopilotAnalysisError,
  parseAgentAnalysis,
} from "./parse-agent-analysis.js"

export async function analyzeCandidates (
  payload,
  shortlist,
  systemPrompt,
  {
    callAgent = callCopilotWithTools,
    readCoinData,
  } = {},
) {
  const { shortlistedCoins } = validateAgentInputs(payload, shortlist)

  if (shortlistedCoins.some(coin => (
    !isString(coin.marketSymbol) || !coin.marketSymbol
  ))) {
    throw new Error("Step 5 candidates do not define market symbols")
  }

  const marketSymbolBySymbol = new Map(
    shortlistedCoins.map(coin => [coin.symbol, coin.marketSymbol]),
  )
  const tools = payload.candidateCount > 0
    ? [createCoinHistoryTool(payload, shortlist, { readCoinData })]
    : []
  const content = await callAgent(systemPrompt, JSON.stringify(payload), {
    model: "GPT-5.6 Sol",
    reasoningEffort: "medium",
    tools,
  })

  try {
    const analysis = parseAgentAnalysis(content, payload)
    const assessmentBySymbol = new Map(
      analysis.assessments.map(assessment => [assessment.symbol, assessment]),
    )

    return {
      ...analysis,
      topCandidates: analysis.topCandidates.map(candidate => ({
        ...candidate,
        directionBias: assessmentBySymbol.get(candidate.symbol).directionBias,
        estimateConfidence: assessmentBySymbol.get(candidate.symbol).estimateConfidence,
        tradingViewUrl: `https://www.tradingview.com/chart/?symbol=${marketSymbolBySymbol.get(candidate.symbol)}`,
      })),
    }
  } catch (error) {
    if (error instanceof InvalidCopilotAnalysisError) {
      error.response = content
    }

    throw error
  }
}
