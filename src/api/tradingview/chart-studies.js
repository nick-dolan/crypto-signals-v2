import { fetchTradingViewStudy } from "./studies/index.js"

const DEFAULT_TIMEOUT_MS = 45_000
const DEFAULT_CHART_SETTLE_DELAY_MS = 500
const DEFAULT_STUDY_SETTLE_DELAY_MS = 250

function getRequiredString (value, name) {
  const normalizedValue = typeof value === "string" ? value.trim() : ""

  if (!normalizedValue) {
    throw new Error(`${name} is required`)
  }

  return normalizedValue
}

function validatePositiveInteger (value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`)
  }
}

function validatePositiveNumber (value, name) {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive number`)
  }
}

function validateNonNegativeNumber (value, name) {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a non-negative number`)
  }
}

function getErrorMessage (error) {
  return error instanceof Error ? error.message : String(error)
}

function normalizeRequests (requests) {
  if (!Array.isArray(requests) || requests.length === 0) {
    throw new Error("TradingView study requests must be a non-empty array")
  }

  const keys = new Set()

  return requests.map((request, index) => {
    if (!request || typeof request !== "object" || Array.isArray(request)) {
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
      inputs: request.inputs === undefined
        ? undefined
        : Object.freeze({ ...request.inputs }),
      fields: request.fields === undefined
        ? undefined
        : Object.freeze({ ...request.fields }),
    })
  })
}

function normalizeOptions ({
  range,
  settleDelayMs = DEFAULT_CHART_SETTLE_DELAY_MS,
  studySettleDelayMs = DEFAULT_STUDY_SETTLE_DELAY_MS,
  symbol,
  timeframe,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  to,
} = {}) {
  validatePositiveInteger(range, "TradingView chart range")
  validatePositiveNumber(timeoutMs, "TradingView chart timeoutMs")
  validateNonNegativeNumber(
    settleDelayMs,
    "TradingView chart settleDelayMs",
  )
  validateNonNegativeNumber(
    studySettleDelayMs,
    "TradingView study settleDelayMs",
  )

  if (to !== undefined) {
    validatePositiveInteger(to, "TradingView chart to")
  }

  return Object.freeze({
    range,
    settleDelayMs,
    studySettleDelayMs,
    symbol: getRequiredString(symbol, "TradingView chart symbol"),
    timeframe: getRequiredString(timeframe, "TradingView chart timeframe"),
    timeoutMs,
    to,
  })
}

function waitForChart (chart, options) {
  return new Promise((resolve, reject) => {
    let availablePeriodCount = 0
    let settled = false
    let settleTimeoutId = null
    let symbolLoaded = false
    let timeoutId = null

    const finish = (callback, value) => {
      if (settled) {
        return
      }

      settled = true
      clearTimeout(settleTimeoutId)
      clearTimeout(timeoutId)
      callback(value)
    }

    const resolveAfterUpdates = () => {
      if (!symbolLoaded || availablePeriodCount === 0) {
        return
      }

      clearTimeout(settleTimeoutId)
      settleTimeoutId = setTimeout(
        () => finish(resolve),
        options.settleDelayMs,
      )
    }

    chart.onError((...messages) => {
      const details = messages.map(getErrorMessage).join(" ")
      finish(
        reject,
        new Error(
          `TradingView chart ${options.symbol} error: ${details || "Unknown error"}`,
        ),
      )
    })
    chart.onSymbolLoaded(() => {
      symbolLoaded = true
      resolveAfterUpdates()
    })
    chart.onUpdate((changes) => {
      if (!Array.isArray(changes) || !changes.includes("$prices")) {
        return
      }

      availablePeriodCount = chart.periods.length
      resolveAfterUpdates()
    })

    timeoutId = setTimeout(() => {
      finish(
        reject,
        new Error(
          `TradingView chart ${options.symbol} timed out after ${options.timeoutMs} ms with ${availablePeriodCount} periods`,
        ),
      )
    }, options.timeoutMs)

    try {
      chart.setMarket(options.symbol, {
        timeframe: options.timeframe,
        range: options.range,
        ...(options.to === undefined ? {} : { to: options.to }),
      })
    } catch (error) {
      finish(
        reject,
        new Error(
          `Failed to set TradingView chart ${options.symbol}: ${getErrorMessage(error)}`,
          { cause: error },
        ),
      )
    }
  })
}

function normalizeChartPeriods (periods) {
  return periods
    .filter(period => period && typeof period === "object")
    .map(period => ({ ...period }))
    .sort((first, second) => first.time - second.time)
}

function getChartInfo (infos) {
  return Object.freeze({
    fullName: typeof infos?.full_name === "string" ? infos.full_name : null,
    exchange: typeof infos?.exchange === "string" ? infos.exchange : null,
    baseCurrencyId: typeof infos?.base_currency_id === "string"
      ? infos.base_currency_id
      : null,
    quoteCurrency: typeof infos?.currency_code === "string"
      ? infos.currency_code
      : null,
    instrumentType: typeof infos?.type === "string" ? infos.type : null,
    typeSpecifications: Array.isArray(infos?.typespecs)
      ? Object.freeze([...infos.typespecs])
      : Object.freeze([]),
  })
}

export function createTradingViewChartStudiesFetcher ({
  fetchStudy = fetchTradingViewStudy,
} = {}) {
  if (typeof fetchStudy !== "function") {
    throw new Error("fetchStudy must be a function")
  }

  return async function fetchChartStudies (
    client,
    requests,
    options = {},
  ) {
    if (!client?.Session?.Chart) {
      throw new Error("Connected TradingView client is required")
    }

    const normalizedRequests = normalizeRequests(requests)
    const normalizedOptions = normalizeOptions(options)
    const chart = new client.Session.Chart()

    try {
      await waitForChart(chart, normalizedOptions)

      const settledStudies = await Promise.allSettled(
        normalizedRequests.map(request => fetchStudy(
          chart,
          request,
          {
            timeoutMs: normalizedOptions.timeoutMs,
            settleDelayMs: normalizedOptions.studySettleDelayMs,
          },
        )),
      )

      return {
        chart: {
          info: getChartInfo(chart.infos),
          periods: normalizeChartPeriods(chart.periods),
        },
        studies: Object.fromEntries(
          settledStudies.map((result, index) => [
            normalizedRequests[index].key,
            result,
          ]),
        ),
      }
    } finally {
      chart.delete()
    }
  }
}

export const fetchTradingViewChartStudies = createTradingViewChartStudiesFetcher()
