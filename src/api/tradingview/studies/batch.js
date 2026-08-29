import { cluster, isObject, select } from "radash"
import { fetchTradingViewStudy } from "./study.js"

const DEFAULT_MAX_STUDIES_PER_CHART = 25
const DEFAULT_TIMEOUT_MS = 20_000
const DEFAULT_SETTLE_DELAY_MS = 50

function getRequiredString (value, name) {
  const normalizedValue = typeof value === "string" ? value.trim() : ""

  if (!normalizedValue) {
    throw new Error(`${name} is required`)
  }

  return normalizedValue
}

function getErrorMessage (error) {
  return error instanceof Error ? error.message : String(error)
}

function validatePositiveNumber (value, name) {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive number`)
  }

  return value
}

function validateNonNegativeNumber (value, name) {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a non-negative number`)
  }

  return value
}

function validatePositiveInteger (value, name) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`)
  }

  return value
}

function snapshotObject (value) {
  if (Array.isArray(value)) {
    return Object.freeze([...value])
  }

  if (isObject(value)) {
    return Object.freeze({ ...value })
  }

  return value
}

function normalizeRequests (requests) {
  if (!Array.isArray(requests)) {
    throw new Error("TradingView study requests must be an array")
  }

  const keys = new Set()

  return requests.map((request, index) => {
    if (!isObject(request)) {
      throw new Error(`TradingView study request at index ${index} must be an object`)
    }

    const key = getRequiredString(
      request.key,
      `TradingView study key at index ${index}`,
    )

    if (keys.has(key)) {
      throw new Error(`Duplicate TradingView study key ${key}`)
    }

    keys.add(key)

    return Object.freeze({
      ...request,
      key,
      inputs: snapshotObject(request.inputs),
      fields: snapshotObject(request.fields),
    })
  })
}

function normalizeOptions ({
  symbol,
  timeframe,
  range,
  to,
  window,
  timeframeSeconds,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  settleDelayMs = DEFAULT_SETTLE_DELAY_MS,
  maxStudiesPerChart = DEFAULT_MAX_STUDIES_PER_CHART,
} = {}) {
  if (range !== undefined) {
    validatePositiveInteger(range, "TradingView chart range")
  }

  if (to !== undefined && !Number.isFinite(to)) {
    throw new Error("TradingView chart to must be a finite timestamp")
  }

  return Object.freeze({
    symbol: getRequiredString(symbol, "TradingView chart symbol"),
    timeframe: getRequiredString(timeframe, "TradingView chart timeframe"),
    range,
    to,
    window: snapshotObject(window),
    timeframeSeconds,
    timeoutMs: validatePositiveNumber(
      timeoutMs,
      "TradingView chart timeoutMs",
    ),
    settleDelayMs: validateNonNegativeNumber(
      settleDelayMs,
      "TradingView study settleDelayMs",
    ),
    maxStudiesPerChart: validatePositiveInteger(
      maxStudiesPerChart,
      "maxStudiesPerChart",
    ),
  })
}

function formatChartError (messages) {
  return messages.map(getErrorMessage).join(" ")
}

function setChartMarket (
  chart,
  {
    symbol,
    timeframe,
    range,
    to,
    timeoutMs,
  },
) {
  return new Promise((resolve, reject) => {
    let settled = false
    let timeoutId = null

    const finish = (callback, value) => {
      if (settled) {
        return
      }

      settled = true
      clearTimeout(timeoutId)
      callback(value)
    }

    chart.onError((...messages) => {
      const details = formatChartError(messages)
      finish(
        reject,
        new Error(`TradingView chart error: ${details || "Unknown error"}`),
      )
    })
    chart.onSymbolLoaded(() => finish(resolve))

    timeoutId = setTimeout(() => {
      finish(
        reject,
        new Error(`TradingView symbol ${symbol} loading timed out`),
      )
    }, timeoutMs)

    try {
      chart.setMarket(symbol, {
        timeframe,
        ...(range === undefined ? {} : { range }),
        ...(to === undefined ? {} : { to }),
      })
    } catch (error) {
      finish(
        reject,
        new Error(
          `Failed to set TradingView symbol ${symbol}: ${getErrorMessage(error)}`,
          { cause: error },
        ),
      )
    }
  })
}

function formatStudyFailure (request, reason) {
  const label = request.name || request.key || request.id
  return `${label}: ${getErrorMessage(reason)}`
}

function createStudyOptions (options) {
  return {
    window: options.window,
    timeframeSeconds: options.timeframeSeconds,
    timeoutMs: options.timeoutMs,
    settleDelayMs: options.settleDelayMs,
  }
}

export function createTradingViewStudiesFetcher ({
  fetchStudy = fetchTradingViewStudy,
} = {}) {
  if (typeof fetchStudy !== "function") {
    throw new Error("fetchStudy must be a function")
  }

  async function fetchStudyGroup (client, requests, options) {
    const chart = new client.Session.Chart()

    try {
      await setChartMarket(chart, options)

      const settledResults = await Promise.allSettled(
        requests.map(request => fetchStudy(
          chart,
          request,
          createStudyOptions(options),
        )),
      )
      const failures = select(
        settledResults,
        (result, index) => ({
          request: requests[index],
          reason: result.reason,
        }),
        result => result.status === "rejected",
      )

      if (failures.length > 0) {
        throw new AggregateError(
          failures.map(failure => failure.reason),
          `Failed to load TradingView studies: ${failures
            .map(failure => formatStudyFailure(
              failure.request,
              failure.reason,
            ))
            .join("; ")}`,
        )
      }

      return Object.fromEntries(
        settledResults.map((result, index) => [
          requests[index].key,
          result.value,
        ]),
      )
    } finally {
      chart.delete()
    }
  }

  return async function fetchTradingViewStudies (
    client,
    requests,
    options = {},
  ) {
    const normalizedRequests = normalizeRequests(requests)

    if (normalizedRequests.length === 0) {
      return {}
    }

    if (!client?.Session?.Chart) {
      throw new Error("Connected TradingView client is required")
    }

    const normalizedOptions = normalizeOptions(options)
    const groups = cluster(
      normalizedRequests,
      normalizedOptions.maxStudiesPerChart,
    )
    const resultEntries = []

    for (const group of groups) {
      resultEntries.push(
        ...Object.entries(
          await fetchStudyGroup(client, group, normalizedOptions),
        ),
      )
    }

    return Object.fromEntries(resultEntries)
  }
}

export const fetchTradingViewStudies = createTradingViewStudiesFetcher()
