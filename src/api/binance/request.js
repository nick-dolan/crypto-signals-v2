import {
  isError,
  isFinite,
  isObject,
  isString,
  isURLSearchParams,
} from "../../helpers/utils.typed.js"

export class BinanceRequestError extends Error {
  constructor (message, { code, retryAfter, status } = {}) {
    super(message)
    this.name = "BinanceRequestError"
    this.code = code
    this.retryAfter = retryAfter
    this.status = status
  }
}

function getRequiredString (value, name) {
  const normalizedValue = isString(value) ? value.trim() : ""

  if (!normalizedValue) {
    throw new Error(`${name} is required`)
  }

  return normalizedValue
}

function validateTimeout (timeoutMs) {
  if (!isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("timeoutMs must be a positive number")
  }
}

function normalizeApiKey (apiKey) {
  if (apiKey === undefined) {
    return undefined
  }

  const normalizedApiKey = isString(apiKey) ? apiKey.trim() : ""

  if (!normalizedApiKey) {
    throw new Error("apiKey must be a non-empty string")
  }

  return normalizedApiKey
}

function appendSearchParams (url, searchParams) {
  if (searchParams === undefined) {
    return
  }

  if (isURLSearchParams(searchParams)) {
    for (const [key, value] of searchParams) {
      url.searchParams.append(key, value)
    }
    return
  }

  if (!isObject(searchParams)) {
    throw new Error("searchParams must be an object or URLSearchParams")
  }

  for (const [key, value] of Object.entries(searchParams)) {
    if (value !== undefined && value !== null) {
      url.searchParams.append(key, String(value))
    }
  }
}

function createBinanceUrl (endpoint, searchParams) {
  const normalizedEndpoint = getRequiredString(endpoint, "Binance endpoint")

  if (
    normalizedEndpoint.startsWith("//")
    || /^[a-z][a-z\d+.-]*:/i.test(normalizedEndpoint)
  ) {
    throw new Error("Binance endpoint must be relative")
  }

  const url = new URL(
    normalizedEndpoint.replace(/^\/+/, ""),
    "https://fapi.binance.com/",
  )

  appendSearchParams(url, searchParams)

  return url
}

function createHeaders (apiKey) {
  const headers = {
    "accept": "application/json",
    "user-agent": "crypto-signals/1.0",
  }

  if (apiKey) {
    headers["X-MBX-APIKEY"] = apiKey
  }

  return headers
}

function getErrorMessage (error) {
  return isError(error) ? error.message : "Unknown error"
}

function createTimeoutError (label, timeoutMs) {
  return new Error(`${label} request timed out after ${timeoutMs} ms`)
}

function getBinanceError (payload) {
  const code = isFinite(payload?.code) ? payload.code : undefined
  const message = isString(payload?.msg) ? payload.msg.trim() : ""

  return { code, message }
}

async function readErrorResponse (response, controller, label, timeoutMs) {
  let responseText

  try {
    responseText = (await response.text()).trim()
  } catch {
    if (controller.signal.aborted) {
      throw createTimeoutError(label, timeoutMs)
    }

    return { code: undefined, details: "" }
  }

  if (!responseText) {
    return { code: undefined, details: "" }
  }

  try {
    const { code, message } = getBinanceError(JSON.parse(responseText))

    if (message) {
      const codeDetails = code === undefined ? "" : ` ${code}`

      return {
        code,
        details: `: Binance error${codeDetails}: ${message.slice(0, 300)}`,
      }
    }
  } catch {
    // The response is not JSON, so use its text as the error details.
  }

  return {
    code: undefined,
    details: `: ${responseText.slice(0, 300)}`,
  }
}

async function fetchBinanceResponse (url, { controller, headers, label, timeoutMs }) {
  try {
    return await fetch(url, {
      method: "GET",
      headers,
      signal: controller.signal,
    })
  } catch (error) {
    if (controller.signal.aborted) {
      throw createTimeoutError(label, timeoutMs)
    }

    throw new Error(`${label} request failed: ${getErrorMessage(error)}`, {
      cause: error,
    })
  }
}

async function readJsonResponse (response, controller, label, timeoutMs) {
  try {
    return await response.json()
  } catch (error) {
    if (controller.signal.aborted) {
      throw createTimeoutError(label, timeoutMs)
    }

    throw new Error(`${label} returned invalid JSON`, { cause: error })
  }
}

export async function requestBinanceFuturesJson (
  endpoint,
  {
    apiKey,
    searchParams,
    timeoutMs = 15_000,
  } = {},
) {
  validateTimeout(timeoutMs)

  const url = createBinanceUrl(endpoint, searchParams)
  const label = `Binance ${url.pathname}`
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const response = await fetchBinanceResponse(url, {
      controller,
      headers: createHeaders(normalizeApiKey(apiKey)),
      label,
      timeoutMs,
    })

    if (!response.ok) {
      const { code, details } = await readErrorResponse(
        response,
        controller,
        label,
        timeoutMs,
      )

      throw new BinanceRequestError(
        `${label} request failed with HTTP ${response.status}${details}`,
        {
          code,
          retryAfter: response.headers.get("retry-after") || undefined,
          status: response.status,
        },
      )
    }

    const payload = await readJsonResponse(
      response,
      controller,
      label,
      timeoutMs,
    )
    const { code, message } = getBinanceError(payload)

    if (code !== undefined && code < 0 && message) {
      throw new BinanceRequestError(
        `${label} API error ${code}: ${message.slice(0, 300)}`,
        { code, status: response.status },
      )
    }

    return payload
  } finally {
    clearTimeout(timeoutId)
  }
}
