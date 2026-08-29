export const ALTERNATIVE_ME_API_URL = "https://api.alternative.me/"

const DEFAULT_TIMEOUT_MS = 15_000
const DEFAULT_USER_AGENT = "crypto-signals/1.0"
const ERROR_DETAILS_MAX_LENGTH = 300
const ALTERNATIVE_ME_API_ORIGIN = new URL(ALTERNATIVE_ME_API_URL).origin

function getRequiredString (value, name) {
  const normalizedValue = typeof value === "string" ? value.trim() : ""

  if (!normalizedValue) {
    throw new Error(`${name} is required`)
  }

  return normalizedValue
}

function validateTimeout (timeoutMs) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("timeoutMs must be a positive number")
  }
}

function getErrorMessage (error) {
  return error instanceof Error ? error.message : "Unknown error"
}

function createHeaders (headers) {
  const requestHeaders = new Headers(headers)

  if (!requestHeaders.has("accept")) {
    requestHeaders.set("accept", "application/json")
  }

  if (!requestHeaders.has("user-agent")) {
    requestHeaders.set("user-agent", DEFAULT_USER_AGENT)
  }

  return Object.fromEntries(requestHeaders.entries())
}

function appendSearchParam (url, key, value) {
  if (value === undefined || value === null) {
    return
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      appendSearchParam(url, key, item)
    }
    return
  }

  url.searchParams.append(key, String(value))
}

function appendSearchParams (url, searchParams) {
  if (searchParams === undefined) {
    return
  }

  if (searchParams instanceof URLSearchParams) {
    for (const [key, value] of searchParams) {
      url.searchParams.append(key, value)
    }
    return
  }

  if (!searchParams || typeof searchParams !== "object" || Array.isArray(searchParams)) {
    throw new Error("searchParams must be an object or URLSearchParams")
  }

  for (const [key, value] of Object.entries(searchParams)) {
    appendSearchParam(url, key, value)
  }
}

function createAlternativeMeUrl (endpoint, searchParams) {
  const normalizedEndpoint = getRequiredString(
    endpoint,
    "Alternative.me endpoint",
  )

  if (
    normalizedEndpoint.startsWith("//")
    || /^[a-z][a-z\d+.-]*:/i.test(normalizedEndpoint)
  ) {
    throw new Error("Alternative.me endpoint must be relative")
  }

  const url = new URL(
    normalizedEndpoint.replace(/^\/+/, ""),
    ALTERNATIVE_ME_API_URL,
  )

  if (url.origin !== ALTERNATIVE_ME_API_ORIGIN) {
    throw new Error("Alternative.me endpoint must use the Alternative.me API origin")
  }

  appendSearchParams(url, searchParams)

  return url
}

function createTimeoutError (label, timeoutMs) {
  return new Error(`${label} request timed out after ${timeoutMs} ms`)
}

function normalizeErrorDetails (value) {
  if (typeof value === "string") {
    return value.trim().slice(0, ERROR_DETAILS_MAX_LENGTH)
  }

  if (value === undefined || value === null || value === false) {
    return ""
  }

  if (typeof value?.message === "string") {
    return value.message.trim().slice(0, ERROR_DETAILS_MAX_LENGTH)
  }

  try {
    return JSON.stringify(value).slice(0, ERROR_DETAILS_MAX_LENGTH)
  } catch {
    return String(value).slice(0, ERROR_DETAILS_MAX_LENGTH)
  }
}

function getPayloadErrorDetails (payload) {
  return normalizeErrorDetails(
    payload?.metadata?.error ?? payload?.error ?? payload?.message,
  )
}

async function getResponseErrorDetails (response, controller, label, timeoutMs) {
  let responseText

  try {
    responseText = (await response.text()).trim()
  } catch {
    if (controller.signal.aborted) {
      throw createTimeoutError(label, timeoutMs)
    }

    return ""
  }

  if (!responseText) {
    return ""
  }

  try {
    const payloadDetails = getPayloadErrorDetails(JSON.parse(responseText))

    if (payloadDetails) {
      return `: ${payloadDetails}`
    }
  } catch {
    // The response is not JSON, so use its text as the error details.
  }

  return `: ${responseText.slice(0, ERROR_DETAILS_MAX_LENGTH)}`
}

async function fetchAlternativeMeResponse (
  url,
  {
    controller,
    headers,
    label,
    timeoutMs,
  },
) {
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

export async function requestAlternativeMeJson (
  endpoint,
  {
    headers,
    searchParams,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  } = {},
) {
  validateTimeout(timeoutMs)

  const url = createAlternativeMeUrl(endpoint, searchParams)
  const label = `Alternative.me ${url.pathname}`
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const response = await fetchAlternativeMeResponse(url, {
      controller,
      headers: createHeaders(headers),
      label,
      timeoutMs,
    })

    if (!response.ok) {
      const details = await getResponseErrorDetails(
        response,
        controller,
        label,
        timeoutMs,
      )

      throw new Error(
        `${label} request failed with HTTP ${response.status}${details}`,
      )
    }

    const payload = await readJsonResponse(
      response,
      controller,
      label,
      timeoutMs,
    )
    const apiErrorDetails = getPayloadErrorDetails(payload)

    if (apiErrorDetails) {
      throw new Error(`${label} API error: ${apiErrorDetails}`)
    }

    return payload
  } finally {
    clearTimeout(timeoutId)
  }
}
