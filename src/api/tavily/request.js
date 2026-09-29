import "dotenv/config"
import { isFinite, isObject } from "../../helpers/utils.typed.js"

export async function requestTavilyJson (endpoint, body, { timeoutMs = 30_000 } = {}) {
  if (!["/search", "/extract"].includes(endpoint)) {
    throw new Error("Tavily endpoint must be /search or /extract")
  }

  const label = `Tavily ${endpoint}`
  const apiKey = process.env.TAVILY_API_KEY?.trim()

  if (!apiKey) {
    throw new Error(`${label} API key is required`)
  }

  if (!isObject(body) || Object.getPrototypeOf(body) !== Object.prototype) {
    throw new Error(`${label} body must be a plain object`)
  }

  if (!isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error(`${label} timeoutMs must be a positive finite number`)
  }

  const apiKeys = [...new Set([apiKey, process.env.TAVILY_API_KEY_2?.trim()].filter(Boolean))]
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs)

  try {
    let response
    let text

    try {
      const payload = JSON.stringify(body)

      for (const key of apiKeys) {
        response = await fetch(`https://api.tavily.com${endpoint}`, {
          method: "POST",
          headers: {
            "accept": "application/json",
            "content-type": "application/json",
            "authorization": `Bearer ${key}`,
          },
          body: payload,
          redirect: "manual",
          signal: controller.signal,
        })

        // 432/433 exhaust usage credits; 429 is a rate limit, not a reason to rotate keys.
        if (![432, 433].includes(response.status) || key === apiKeys.at(-1)) {
          break
        }

        await response.body?.cancel()
      }

      if (response.ok) {
        text = await response.text()
      }
    } catch {
      throw new Error(`${label} ${controller.signal.aborted ? "request timed out" : "transport failure"}`)
    }

    if (!response.ok) {
      throw new Error(`${label} HTTP ${response.status}`)
    }

    try {
      return JSON.parse(text)
    } catch {
      throw new Error(`${label} invalid JSON`)
    }
  } finally {
    clearTimeout(timeoutId)
  }
}
