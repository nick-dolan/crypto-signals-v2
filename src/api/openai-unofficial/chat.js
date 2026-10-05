import { randomUUID } from "node:crypto"
import { isArray, isString } from "../../helpers/utils.typed.js"
import { getUnofficialOpenAISession } from "./auth.js"

function parseEvent (frame) {
  const data = frame.split(/\r\n|\r|\n/)
    .filter(line => line.startsWith("data:"))
    .map(line => line.slice(5).replace(/^ /, ""))
    .join("\n")
    .trim()

  if (!data) {
    return null
  }

  if (data === "[DONE]") {
    return { type: "stream.done" }
  }

  try {
    return JSON.parse(data)
  } catch {
    throw new Error("OpenAI returned an invalid SSE event")
  }
}

async function* readEvents (response) {
  if (!response.body) {
    throw new Error("OpenAI returned no response body")
  }

  let buffer = ""

  for await (const chunk of response.body.pipeThrough(new TextDecoderStream())) {
    buffer += chunk

    while (true) {
      // A CR at a chunk boundary may be the first half of CRLF, not a blank line.
      const deferCr = buffer.endsWith("\r") && !buffer.endsWith("\r\r") && !buffer.endsWith("\n\r")
      const boundary = /(?:\r\n|\r(?!\n)|\n)(?:\r\n|\r(?!\n)|\n)/.exec(deferCr ? buffer.slice(0, -1) : buffer)

      if (!boundary) {
        break
      }

      const event = parseEvent(buffer.slice(0, boundary.index))
      buffer = buffer.slice(boundary.index + boundary[0].length)

      if (event) {
        yield event
      }
    }
  }

  const event = parseEvent(buffer)

  if (event) {
    yield event
  }
}

function extractText (response) {
  const output = isArray(response?.output) ? response.output : []

  return output.flatMap(item => isArray(item?.content) ? item.content : [])
    .filter(part => part?.type === "output_text" && isString(part.text))
    .map(part => part.text)
    .join("")
}

function eventError (event) {
  const detail = event.error?.message ?? event.response?.error?.message
    ?? event.message ?? event.response?.incomplete_details?.reason

  return new Error(`OpenAI response failed: ${isString(detail) ? detail : event.type}`)
}

async function collectResponse (response) {
  let text = ""

  for await (const event of readEvents(response)) {
    if (event.type === "stream.done") {
      break
    }

    if (event.type === "response.output_text.delta" && isString(event.delta)) {
      text += event.delta
    }

    if (["error", "response.failed", "response.incomplete", "response.refusal.done"].includes(event.type)) {
      throw eventError(event)
    }

    if (event.type === "response.completed" || event.type === "response.done") {
      if (event.response?.status && event.response.status !== "completed") {
        throw eventError(event)
      }

      text = extractText(event.response) || text

      if (!text.trim()) {
        throw new Error("Empty response from OpenAI")
      }

      const usage = event.response?.usage

      if (usage) {
        console.log(`  Tokens — input: ${usage.input_tokens}, output: ${usage.output_tokens}, total: ${usage.total_tokens}`)
      }

      return text
    }
  }

  throw new Error("OpenAI response stream ended before completion")
}

export async function callUnofficialOpenAI (
  systemPrompt,
  userMessage,
  { model, reasoningEffort, tools = [] } = {},
) {
  if (tools.length > 0) {
    throw new Error("openai-unofficial does not support tools")
  }

  if (!isString(model) || !model.trim()) {
    throw new Error("OpenAI model must be a nonempty string")
  }

  if (!isString(systemPrompt) || !isString(userMessage) || !userMessage.trim()) {
    throw new Error("OpenAI prompts must be strings with a nonempty user message")
  }

  if (reasoningEffort != null && (!isString(reasoningEffort) || !reasoningEffort.trim())) {
    throw new Error("OpenAI reasoningEffort must be a nonempty string or null")
  }

  let session = await getUnofficialOpenAISession()
  const requestId = randomUUID()
  const signal = AbortSignal.timeout(10 * 60 * 1000)
  const body = JSON.stringify({
    model,
    instructions: systemPrompt || "You are a helpful assistant.",
    input: [{ role: "user", content: [{ type: "input_text", text: userMessage }] }],
    ...(reasoningEffort ? { reasoning: { effort: reasoningEffort } } : {}),
    stream: true,
    store: false,
  })
  const request = () => fetch("https://chatgpt.com/backend-api/codex/responses", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${session.token}`,
      "ChatGPT-Account-ID": session.accountId,
      "Content-Type": "application/json",
      "Accept": "text/event-stream",
      "OpenAI-Beta": "responses=experimental",
      "User-Agent": "crypto-signals-v2",
      "originator": "crypto-signals-v2",
      "session_id": requestId,
      "x-client-request-id": requestId,
    },
    body,
    signal,
  })

  console.log(`Calling ${model} via unofficial OpenAI subscription API...`)

  let response = await request()

  if (response.status === 401) {
    await response.body?.cancel()
    session = await getUnofficialOpenAISession({ rejectedToken: session.token })
    response = await request()
  }

  try {
    if (!response.ok) {
      const data = await response.json().catch(() => null)
      const message = isString(data?.error?.message) ? `: ${data.error.message}` : ""
      throw new Error(`Unofficial OpenAI API failed: HTTP ${response.status}${message}`)
    }

    return await collectResponse(response)
  } catch (error) {
    const message = isString(error?.message) ? error.message : String(error)
    const redacted = message.replaceAll(session.token, "[redacted]")
      .replaceAll(session.refreshToken, "[redacted]")
    throw redacted === message ? error : new Error(redacted)
  }
}
