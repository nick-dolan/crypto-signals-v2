const DEFAULT_USER_AGENT = "crypto-signals/1.0"
const ERROR_DETAILS_MAX_LENGTH = 300

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

function createHeaders (headers, accept) {
  const requestHeaders = new Headers(headers)

  if (!requestHeaders.has("accept")) {
    requestHeaders.set("accept", accept)
  }

  if (!requestHeaders.has("user-agent")) {
    requestHeaders.set("user-agent", DEFAULT_USER_AGENT)
  }

  return Object.fromEntries(requestHeaders.entries())
}

function createTimeoutError (label, timeoutMs) {
  return new Error(`${label} request timed out after ${timeoutMs} ms`)
}

async function fetchTradingViewResponse (
  url,
  {
    controller,
    headers,
    label,
    requestOptions,
    timeoutMs,
  },
) {
  try {
    return await fetch(url, {
      ...requestOptions,
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

async function getResponseErrorDetails (
  response,
  {
    controller,
    label,
    timeoutMs,
  },
) {
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
    const payload = JSON.parse(responseText)
    const message = typeof payload?.message === "string"
      ? payload.message.trim()
      : ""

    if (message) {
      return `: ${message.slice(0, ERROR_DETAILS_MAX_LENGTH)}`
    }
  } catch {
    // The response is not JSON, so use its text as the error details.
  }

  return `: ${responseText.slice(0, ERROR_DETAILS_MAX_LENGTH)}`
}

async function readResponseBody (
  response,
  readBody,
  {
    bodyErrorMessage,
    controller,
    label,
    timeoutMs,
  },
) {
  try {
    return await readBody(response)
  } catch (error) {
    if (controller.signal.aborted) {
      throw createTimeoutError(label, timeoutMs)
    }

    throw new Error(bodyErrorMessage, { cause: error })
  }
}

async function requestTradingView (
  url,
  {
    accept,
    bodyErrorMessage,
    headers,
    label,
    readBody,
    requestOptions,
    timeoutMs,
  },
) {
  validateTimeout(timeoutMs)

  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs)
  const requestContext = {
    controller,
    label,
    timeoutMs,
  }

  try {
    const response = await fetchTradingViewResponse(url, {
      ...requestContext,
      headers: createHeaders(headers, accept),
      requestOptions,
    })

    if (!response.ok) {
      const details = await getResponseErrorDetails(response, requestContext)

      if (controller.signal.aborted) {
        throw createTimeoutError(label, timeoutMs)
      }

      throw new Error(
        `${label} request failed with HTTP ${response.status}${details}`,
      )
    }

    return await readResponseBody(response, readBody, {
      ...requestContext,
      bodyErrorMessage,
    })
  } finally {
    clearTimeout(timeoutId)
  }
}

export async function requestTradingViewJson (
  url,
  {
    headers,
    label,
    timeoutMs,
    ...requestOptions
  } = {},
) {
  const normalizedLabel = getRequiredString(label, "label")

  return requestTradingView(url, {
    accept: "application/json",
    bodyErrorMessage: `${normalizedLabel} returned invalid JSON`,
    headers,
    label: normalizedLabel,
    readBody: response => response.json(),
    requestOptions,
    timeoutMs,
  })
}

export async function requestTradingViewText (
  url,
  {
    headers,
    label,
    responseDescription = "text",
    timeoutMs,
    ...requestOptions
  } = {},
) {
  const normalizedLabel = getRequiredString(label, "label")
  const normalizedResponseDescription = getRequiredString(
    responseDescription,
    "responseDescription",
  )

  return requestTradingView(url, {
    accept: "text/plain",
    bodyErrorMessage: `${normalizedLabel} returned unreadable ${normalizedResponseDescription}`,
    headers,
    label: normalizedLabel,
    readBody: response => response.text(),
    requestOptions,
    timeoutMs,
  })
}
