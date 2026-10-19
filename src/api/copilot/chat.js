import "dotenv/config"
import { homedir } from "node:os"
import path from "node:path"
import { CopilotClient } from "@github/copilot-sdk"
import { withErrorContext } from "../../helpers/error-helper.js"
import { isArray, isFinite, isString } from "../../helpers/utils.typed.js"

async function sendCopilotRequest (
  systemPrompt,
  userMessage,
  { model, reasoningEffort, tools, attachments },
) {
  let client
  let failure
  let content
  let context = { operation: "client-init" }
  let startedAt = Date.now()

  try {
    client = new CopilotClient({
      mode: "empty",
      baseDirectory: process.env.COPILOT_HOME || path.join(homedir(), ".copilot"),
      logLevel: "error",
    })

    context = { operation: "start" }
    startedAt = Date.now()
    await client.start()

    context = { operation: "create-session" }
    startedAt = Date.now()
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

    session.on("session.error", (event) => {
      if (!event.agentId) {
        context = {
          ...context,
          ...(isString(event.data.errorCode) ? { code: event.data.errorCode } : {}),
          ...(isString(event.data.errorType) ? { type: event.data.errorType } : {}),
          ...(isFinite(event.data.statusCode) ? { status: event.data.statusCode } : {}),
          ...(isString(event.data.providerCallId) ? { providerCallId: event.data.providerCallId } : {}),
          ...(isString(event.data.serviceRequestId) ? { serviceRequestId: event.data.serviceRequestId } : {}),
        }
      }
    })

    context = { operation: "send-and-wait", timeoutMs: 10 * 60 * 1000 }
    startedAt = Date.now()
    const response = await session.sendAndWait(
      { prompt: userMessage, ...(attachments.length > 0 ? { attachments } : {}) },
      context.timeoutMs,
    )
    content = response?.data.content

    if (!isString(content) || !content.trim()) {
      throw new Error("Empty response from LLM")
    }
  } catch (error) {
    failure = withErrorContext(error, {
      ...context,
      elapsedMs: Date.now() - startedAt,
      ...(isString(error?.message) && /^Timeout after \d+ms waiting for session\.idle$/.test(error.message)
        ? { type: "timeout" }
        : {}),
    })
  }

  if (client) {
    const startedAt = Date.now()

    try {
      const errors = await client.stop()

      if (isArray(errors) && errors.length > 0) {
        throw new AggregateError(errors, "Copilot SDK cleanup failed", { cause: errors[0] })
      }
    } catch (error) {
      const cleanupError = withErrorContext(error, { operation: "stop", elapsedMs: Date.now() - startedAt })

      if (failure) {
        failure.cleanupErrors = [...(failure.cleanupErrors ?? []), cleanupError]
      } else {
        failure = cleanupError
      }
    }
  }

  if (failure) {
    throw failure
  }

  return content
}

export async function callCopilot (
  systemPrompt,
  userMessage,
  { model, reasoningEffort, attachments = [] } = {},
) {
  return sendCopilotRequest(systemPrompt, userMessage, {
    model,
    reasoningEffort,
    tools: [],
    attachments,
  })
}

export async function callCopilotWithTools (
  systemPrompt,
  userMessage,
  {
    model,
    reasoningEffort,
    tools = [],
    attachments = [],
  } = {},
) {
  return sendCopilotRequest(systemPrompt, userMessage, {
    model,
    reasoningEffort,
    tools,
    attachments,
  })
}
