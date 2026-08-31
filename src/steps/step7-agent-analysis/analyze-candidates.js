import { callCopilotWithTools } from "../../api/copilot/chat.js"
import { createCoinHistoryTool, validateAgentInputs } from "./create-coin-history-tool.js"
import { parseAgentAnalysis } from "./parse-agent-analysis.js"

export async function analyzeCandidates (
  payload,
  shortlist,
  systemPrompt,
  {
    callAgent = callCopilotWithTools,
    readCoinData,
  } = {},
) {
  validateAgentInputs(payload, shortlist)

  const tools = payload.candidateCount > 0
    ? [createCoinHistoryTool(payload, shortlist, { readCoinData })]
    : []
  const content = await callAgent(systemPrompt, JSON.stringify(payload), {
    model: "GPT-5.6 Sol",
    reasoningEffort: "medium",
    tools,
  })

  return parseAgentAnalysis(content, payload)
}
