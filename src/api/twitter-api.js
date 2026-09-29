import "dotenv/config"
import { STATUS_CODES } from "node:http"
import { isFinite } from "../helpers/utils.typed.js"

export async function fetchTweetPage (query, cursor = "", { timeoutMs = 15_000 } = {}) {
  const apiKey = process.env.TWITTERAPI_IO_KEY?.trim()

  if (!apiKey) {
    throw new Error("Twitter API key is required")
  }

  if (!isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("Twitter timeoutMs must be a positive finite number")
  }
  const url = new URL("https://api.twitterapi.io/twitter/tweet/advanced_search")

  url.searchParams.set("query", query)
  url.searchParams.set("queryType", "Latest")
  url.searchParams.set("cursor", cursor)

  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs)

  try {
    let response
    let text

    try {
      response = await fetch(url.toString(), {
        headers: { "X-API-Key": apiKey },
        redirect: "manual",
        signal: controller.signal,
      })

      if (response.ok) {
        text = await response.text()
      }
    } catch {
      throw new Error(`Twitter ${controller.signal.aborted ? "request timed out" : "transport failure"}`)
    }

    if (!response.ok) {
      throw new Error(`Twitter API error: ${response.status} ${STATUS_CODES[response.status] ?? "HTTP error"}`)
    }

    try {
      return JSON.parse(text)
    } catch {
      throw new Error("Twitter invalid JSON")
    }
  } finally {
    clearTimeout(timeoutId)
  }
}
