import "dotenv/config"
import { homedir } from "node:os"
import path from "node:path"
import { CopilotClient } from "@github/copilot-sdk"
import { isString } from "../../helpers/utils.typed.js"

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

    const hasTools = tools.length > 0

    console.log(`Calling ${model} via GitHub Copilot SDK...`)

    const session = await client.createSession({
      clientName: "crypto-signals-v2",
      model,
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
        feedback: "Only explicitly registered read-only tools are allowed.",
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
  { model, reasoningEffort } = {},
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
    model,
    reasoningEffort,
    tools = [],
  } = {},
) {
  return sendCopilotRequest(systemPrompt, userMessage, {
    model,
    reasoningEffort,
    tools,
  })
}
