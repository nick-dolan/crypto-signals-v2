import { redactSecrets, withErrorContext } from "../../helpers/error-helper.js"
import { isArray, isError, isNumber, isString } from "../../helpers/utils.typed.js"
import { getUnofficialCopilotSession } from "./auth.js"

function extractText (data) {
  const content = data.choices?.[0]?.message?.content

  if (isString(content) && content.trim()) {
    return content
  }

  if (isArray(content)) {
    const text = content
      .filter(part => part?.type === "text" && isString(part.text))
      .map(part => part.text)
      .join("")

    if (text.trim()) {
      return text
    }
  }

  throw new Error("Empty response from LLM")
}

export async function callUnofficialCopilot (
  systemPrompt,
  userMessage,
  { model, reasoningEffort } = {},
) {
  let session
  let signal
  let context = { operation: "auth" }
  let startedAt = Date.now()
  const redact = text => redactSecrets(session ? String(text).replaceAll(session.token, "[redacted]") : String(text))

  try {
    session = await getUnofficialCopilotSession()
    context = { operation: "prepare-request" }
    startedAt = Date.now()
    const url = `${session.baseUrl.replace(/\/$/, "")}/chat/completions`
    const body = JSON.stringify({
      model,
      ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userMessage },
      ],
    })

    console.log(`Calling ${model} via unofficial GitHub Copilot API...`)

    context = { operation: "chat-completions", timeoutMs: 10 * 60 * 1000 }
    startedAt = Date.now()
    signal = AbortSignal.timeout(context.timeoutMs)
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${session.token}`,
        "Editor-Version": "vscode/1.96.2",
        "User-Agent": "GitHubCopilotChat/0.26.7",
        "Openai-Intent": "conversation-edits",
      },
      body,
      signal,
    })
    context.status = response.status

    if (!response.ok) {
      const failure = new Error(`Unofficial Copilot API failed: HTTP ${response.status}`)
      const data = await response.json().catch((cause) => {
        failure.cause = cause
        return null
      })
      const detail = data?.error ?? data

      if (isString(detail?.message)) {
        failure.message += `: ${redact(detail.message)}`
      }

      throw withErrorContext(failure, {
        ...(isString(detail?.code) ? { code: redact(detail.code) } : {}),
        ...(isNumber(detail?.code) ? { code: detail.code } : {}),
        ...(isString(detail?.type) ? { type: redact(detail.type) } : {}),
      })
    }

    const data = await response.json()

    if (data.usage) {
      console.log(
        `  Tokens — prompt: ${data.usage.prompt_tokens}, completion: ${data.usage.completion_tokens}, total: ${data.usage.total_tokens}`,
      )
    }

    return extractText(data)
  } catch (error) {
    const failure = withErrorContext(error, {
      ...context,
      elapsedMs: Date.now() - startedAt,
      ...(signal?.aborted ? { type: "timeout" } : {}),
    })
    const seen = new Set()

    for (let cause = failure; isError(cause) && !seen.has(cause); cause = cause.cause) {
      seen.add(cause)
      const message = redact(cause.message)
      const stack = isString(cause.stack) ? redact(cause.stack) : cause.stack

      if (message !== cause.message) {
        Object.defineProperty(cause, "message", { value: message, configurable: true, writable: true })
      }

      if (stack !== cause.stack) {
        cause.stack = stack
      }
    }

    throw failure
  }
}
