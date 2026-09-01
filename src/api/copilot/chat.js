import "dotenv/config"
import { homedir } from "node:os"
import path from "node:path"
import { CopilotClient } from "@github/copilot-sdk"
import { isArray, isString } from "../../helpers/utils.typed.js"

export function resolveCopilotModel (models, requestedModel, reasoningEffort) {
  if (!isArray(models)) {
    throw new Error("Copilot model list is unavailable")
  }

  const requested = isString(requestedModel) ? requestedModel.trim() : ""
  const selected = models.find(model => (
    model.id === requested || model.name === requested
  )) ?? models.find(model => (
    model.id.toLowerCase() === requested.toLowerCase()
    || model.name.toLowerCase() === requested.toLowerCase()
  ))

  if (!selected) {
    throw new Error(`Copilot model is unavailable for this account: ${requested}`)
  }

  if (selected.policy && selected.policy.state !== "enabled") {
    throw new Error(
      `Copilot model ${selected.name} is ${selected.policy.state} for this account`,
    )
  }

  if (reasoningEffort && !selected.capabilities?.supports?.reasoningEffort) {
    throw new Error(`Copilot model ${selected.name} does not support reasoning effort`)
  }

  if (
    reasoningEffort
    && isArray(selected.supportedReasoningEfforts)
    && !selected.supportedReasoningEfforts.includes(reasoningEffort)
  ) {
    throw new Error(
      `Copilot model ${selected.name} does not support reasoning effort ${reasoningEffort}`,
    )
  }

  return selected
}

async function sendCopilotRequest (
  systemPrompt,
  userMessage,
  { model, reasoningEffort, tools },
) {
  const client = new CopilotClient({
    mode: "empty",
    baseDirectory: process.env.COPILOT_HOME || path.join(homedir(), ".copilot"),
    logLevel: "error",
  })

  try {
    await client.start()

    const selectedModel = resolveCopilotModel(
      await client.listModels(),
      model,
      reasoningEffort,
    )
    const hasTools = tools.length > 0

    console.log(`Calling ${selectedModel.name} via GitHub Copilot SDK...`)

    const session = await client.createSession({
      clientName: "crypto-signals-v2",
      model: selectedModel.id,
      ...(reasoningEffort ? { reasoningEffort } : {}),
      ...(hasTools
        ? {
            tools,
            toolSearch: { enabled: false },
          }
        : {}),
      availableTools: tools.map(tool => `custom:${tool.name}`),
      enableConfigDiscovery: false,
      onPermissionRequest: () => ({
        kind: "reject",
        feedback: "Only explicitly registered read-only market tools are allowed.",
      }),
      systemMessage: {
        mode: "customize",
        sections: {
          identity: { action: "remove" },
          ...(hasTools ? {} : { tool_instructions: { action: "remove" } }),
          code_change_rules: { action: "remove" },
        },
        content: systemPrompt,
      },
      infiniteSessions: { enabled: false },
      memory: { enabled: false },
      enableSessionStore: false,
    })

    const response = await session.sendAndWait(
      { prompt: userMessage },
      10 * 60 * 1000,
    )
    const content = response?.data.content

    if (!isString(content) || !content.trim()) {
      throw new Error("Empty response from LLM")
    }

    return content
  } finally {
    await client.stop()
  }
}

export async function callCopilot (
  systemPrompt,
  userMessage,
  { model = "GPT-5.6 Sol", reasoningEffort = "medium" } = {},
) {
  return sendCopilotRequest(systemPrompt, userMessage, {
    model,
    reasoningEffort,
    tools: [],
  })
}

export async function callCopilotWithTools (
  systemPrompt,
  userMessage,
  {
    model = "GPT-5.6 Sol",
    reasoningEffort = "medium",
    tools = [],
  } = {},
) {
  return sendCopilotRequest(systemPrompt, userMessage, {
    model,
    reasoningEffort,
    tools,
  })
}
