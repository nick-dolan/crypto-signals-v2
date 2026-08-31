import "dotenv/config"
import { homedir } from "node:os"
import path from "node:path"
import { CopilotClient } from "@github/copilot-sdk"

export async function callCopilot (
  systemPrompt,
  userMessage,
  { model = "claude-sonnet-4.6", reasoningEffort = null } = {},
) {
  const client = new CopilotClient({
    mode: "empty",
    baseDirectory: process.env.COPILOT_HOME || path.join(homedir(), ".copilot"),
    logLevel: "error",
  })

  try {
    await client.start()

    console.log(`Calling ${model} via GitHub Copilot SDK...`)

    const session = await client.createSession({
      clientName: "crypto-signals-v2",
      model,
      ...(reasoningEffort ? { reasoningEffort } : {}),
      availableTools: [],
      onPermissionRequest: () => ({
        kind: "reject",
        feedback: "Tool use is disabled for market analysis.",
      }),
      systemMessage: {
        mode: "customize",
        sections: {
          identity: { action: "remove" },
          tool_instructions: { action: "remove" },
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

    if (typeof content !== "string" || !content.trim()) {
      throw new Error("Empty response from LLM")
    }

    return content
  } finally {
    await client.stop()
  }
}
