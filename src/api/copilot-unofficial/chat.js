import { isArray, isString } from "../../helpers/utils.typed.js"
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
  { model = "gemini-3.7-flash", reasoningEffort = "medium" } = {},
) {
  const session = await getUnofficialCopilotSession()
  const url = `${session.baseUrl.replace(/\/$/, "")}/chat/completions`

  console.log(`Calling ${model} via unofficial GitHub Copilot API...`)

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${session.token}`,
      "Editor-Version": "vscode/1.96.2",
      "User-Agent": "GitHubCopilotChat/0.26.7",
      "Openai-Intent": "conversation-edits",
    },
    body: JSON.stringify({
      model,
      ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userMessage },
      ],
    }),
    signal: AbortSignal.timeout(10 * 60 * 1000),
  })

  if (!response.ok) {
    const body = await response.text().catch(() => "")
    throw new Error(`Unofficial Copilot API failed: HTTP ${response.status}\n${body}`)
  }

  const data = await response.json()

  if (data.usage) {
    console.log(
      `  Tokens — prompt: ${data.usage.prompt_tokens}, completion: ${data.usage.completion_tokens}, total: ${data.usage.total_tokens}`,
    )
  }

  return extractText(data)
}
