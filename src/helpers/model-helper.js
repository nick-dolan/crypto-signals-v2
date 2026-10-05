import modelsInUse from "../../models-in-use.json" with { type: "json" }
import { callCopilotWithTools } from "../api/copilot/chat.js"
import { callUnofficialCopilot } from "../api/copilot-unofficial/chat.js"
import { isObject, isString } from "./utils.typed.js"

export function getModelSettings (task, registry = modelsInUse) {
  const entry = registry?.[task]
  const label = `models-in-use.json task "${task}"`

  if (!isObject(entry)) {
    throw new Error(`${label}: missing or invalid settings object`)
  }

  const { provider, model, reasoningEffort } = entry

  if (!["copilot-sdk", "copilot-unofficial"].includes(provider)) {
    throw new Error(`${label}: provider must be "copilot-sdk" or "copilot-unofficial"`)
  }

  if (!isString(model) || !model.trim()) {
    throw new Error(`${label}: model must be a nonempty string`)
  }

  if (reasoningEffort !== null && (!isString(reasoningEffort) || !reasoningEffort.trim())) {
    throw new Error(`${label}: reasoningEffort must be a nonempty string or null`)
  }

  return { provider, model, reasoningEffort }
}

export async function callModel (
  systemPrompt,
  userMessage,
  { provider, model, reasoningEffort, tools = [] } = {},
  { callSdk = callCopilotWithTools, callUnofficial = callUnofficialCopilot } = {},
) {
  if (provider === "copilot-sdk") {
    return callSdk(systemPrompt, userMessage, { model, reasoningEffort, tools })
  }

  if (provider === "copilot-unofficial") {
    if (tools.length > 0) {
      throw new Error("copilot-unofficial does not support tools; use copilot-sdk")
    }

    return callUnofficial(systemPrompt, userMessage, { model, reasoningEffort })
  }

  throw new Error(`Unknown model provider: ${provider}`)
}
