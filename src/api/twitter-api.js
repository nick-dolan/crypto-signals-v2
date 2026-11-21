import "dotenv/config"
import { STATUS_CODES } from "node:http"
import { createRequestRateLimiter, RequestCooldownError } from "../helpers/request-rate-limiter.js"
import { isFinite, isString } from "../helpers/utils.typed.js"

const defaultRequestLimiter = createRequestRateLimiter()

function retryAfterDelay (value) {
  if (!isString(value)) {
    return undefined
  }
  let text = value.trim()
  if (/^\d+$/.test(text)) {
    return Number(text) * 1_000
  }

  const obsolete = /^(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday), (\d{2})-([A-Z][a-z]{2})-(\d{2}) (\d{2}:\d{2}:\d{2}) GMT$/.exec(text)
  if (obsolete) {
    const [, weekday, day, month, shortYear, time] = obsolete
    const cutoff = new Date(Date.now())
    cutoff.setUTCFullYear(cutoff.getUTCFullYear() + 50)
    let year = Math.floor(cutoff.getUTCFullYear() / 100) * 100 + Number(shortYear)
    const format = year => `${weekday.slice(0, 3)}, ${day} ${month} ${year} ${time} GMT`
    // HTTP dates with two-digit years cannot be more than 50 years ahead.
    if (Date.parse(format(year)) > cutoff.getTime()) {
      year -= 100
    }
    text = format(year)
  }

  text = text.replace(/^([A-Z][a-z]{2}) ([A-Z][a-z]{2}) ( \d|\d{2}) (\d{2}:\d{2}:\d{2}) (\d{4})$/, (_, weekday, month, day, time, year) => (
    `${weekday}, ${day.trim().padStart(2, "0")} ${month} ${year} ${time} GMT`
  ))
  const timestamp = /^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(text) ? Date.parse(text) : NaN
  return isFinite(timestamp) && new Date(timestamp).toUTCString() === text ? Math.max(0, timestamp - Date.now()) : undefined
}

export async function fetchTweetPage (query, cursor = "", { timeoutMs = 60_000, requestLimiter = defaultRequestLimiter } = {}) {
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

  let transientRetries = 0
  let rateLimitRetries = 0

  try {
    for (;;) {
      const result = await requestLimiter.run(async () => {
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
            if (controller.signal.aborted && transientRetries < 1) {
              transientRetries += 1
              requestLimiter.pause(1_000)
              return { retry: true }
            }
            throw new Error(`Twitter ${controller.signal.aborted ? "request timed out" : "transport failure"}`)
          }

          if (!response.ok) {
            try {
              await response.body?.cancel()
            } catch {
              controller.abort()
            }

            if (response.status === 429) {
              const delayMs = retryAfterDelay(response.headers?.get("retry-after")) ?? 1_000 * 2 ** rateLimitRetries
              requestLimiter.pause(delayMs)
              if (rateLimitRetries < 2 && delayMs <= 60_000) {
                rateLimitRetries += 1
                return { retry: true }
              }
            }
            if ([502, 503, 504].includes(response.status) && transientRetries < 1) {
              transientRetries += 1
              requestLimiter.pause(1_000)
              return { retry: true }
            }
            throw new Error(`Twitter API error: ${response.status} ${STATUS_CODES[response.status] ?? "HTTP error"}`)
          }

          try {
            return { page: JSON.parse(text) }
          } catch {
            throw new Error("Twitter invalid JSON")
          }
        } finally {
          clearTimeout(timeoutId)
        }
      })

      if (!result.retry) {
        return result.page
      }
    }
  } catch (error) {
    if (error instanceof RequestCooldownError) {
      // eslint-disable-next-line preserve-caught-error -- Never expose limiter internals in API errors.
      throw new Error("Twitter API error: 429 Too Many Requests")
    }
    throw error
  }
}
