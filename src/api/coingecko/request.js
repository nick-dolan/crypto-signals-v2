import "dotenv/config"
import { sleep } from "radash"
import { isArray, isError, isFinite, isObject, isString, isURLSearchParams } from "../../helpers/utils.typed.js"

function createUrl (endpoint, searchParams) {
  const path = isString(endpoint) ? endpoint.trim() : ""

  if (!path) {
    throw new Error("CoinGecko endpoint is required")
  }

  if (/^[a-z][a-z\d+.-]*:|^\/\/|\\/i.test(path)) {
    throw new Error("CoinGecko endpoint must be relative")
  }

  const url = new URL(path.replace(/^\//, ""), "https://api.coingecko.com/api/v3/")

  if (url.origin !== "https://api.coingecko.com" || !url.pathname.startsWith("/api/v3/")) {
    throw new Error("CoinGecko endpoint must stay within /api/v3/")
  }

  if (searchParams !== undefined && !isObject(searchParams) && !isURLSearchParams(searchParams)) {
    throw new Error("searchParams must be an object or URLSearchParams")
  }

  const entries = isURLSearchParams(searchParams) ? searchParams : Object.entries(searchParams ?? {})

  for (const [key, value] of entries) {
    for (const item of isArray(value) ? value : [value]) {
      if (item !== undefined && item !== null) {
        url.searchParams.append(key, item)
      }
    }
  }

  return url
}

export async function requestCoinGeckoJson (endpoint, { searchParams, timeoutMs = 20_000 } = {}) {
  const url = createUrl(endpoint, searchParams)

  if (!isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("timeoutMs must be a positive number")
  }

  const headers = { accept: "application/json" }
  const apiKey = process.env.COINGECKO_API_KEY?.trim()

  if (apiKey) {
    headers["x-cg-demo-api-key"] = apiKey
  }

  const label = `CoinGecko ${url.pathname}`

  for (let attempt = 1; ; attempt += 1) {
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs)

    try {
      const response = await fetch(url, {
        method: "GET",
        headers,
        redirect: "manual",
        signal: controller.signal,
      })
      const body = await response.text()

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`)
      }

      return JSON.parse(body)
    } catch (error) {
      if (controller.signal.aborted) {
        if (attempt === 3) {
          throw new Error(`${label} request timed out after ${timeoutMs} ms`, { cause: error })
        }
        console.warn(`⚠ ${label} request timed out after ${timeoutMs} ms; retrying in 2000 ms (attempt ${attempt + 1}/3)`)
      } else {
        if (error instanceof SyntaxError) {
          throw new Error(`${label} returned invalid JSON`, { cause: error })
        }

        throw new Error(`${label} request failed: ${isError(error) ? error.message : "Unknown error"}`, {
          cause: error,
        })
      }
    } finally {
      clearTimeout(timeoutId)
    }

    await sleep(2_000)
  }
}
