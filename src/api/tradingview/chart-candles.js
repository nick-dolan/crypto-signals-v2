function getRequiredString (value, name) {
  const normalizedValue = typeof value === "string" ? value.trim() : ""

  if (!normalizedValue) {
    throw new Error(`${name} is required`)
  }

  return normalizedValue
}

function validatePositiveInteger (value, name) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`)
  }

  return value
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

function formatChartError (messages) {
  const details = messages
    .map(message => message instanceof Error ? message.message : String(message))
    .join(" ")

  return details || "Unknown error"
}

function normalizeOptions ({
  range,
  settleDelayMs = 500,
  symbol,
  timeframe,
  timeoutMs = 45_000,
  to,
} = {}) {
  if (to !== undefined) {
    validatePositiveInteger(to, "TradingView chart to")
  }

  return Object.freeze({
    range: validatePositiveInteger(range, "TradingView chart range"),
    settleDelayMs: validateNonNegativeNumber(
      settleDelayMs,
      "TradingView chart settleDelayMs",
    ),
    symbol: getRequiredString(symbol, "TradingView chart symbol"),
    timeframe: getRequiredString(timeframe, "TradingView chart timeframe"),
    timeoutMs: validatePositiveNumber(
      timeoutMs,
      "TradingView chart timeoutMs",
    ),
    to,
  })
}

export async function fetchTradingViewChartPeriods (client, options = {}) {
  if (!client?.Session?.Chart) {
    throw new Error("Connected TradingView client is required")
  }

  const {
    range,
    settleDelayMs,
    symbol,
    timeframe,
    timeoutMs,
    to,
  } = normalizeOptions(options)
  const chart = new client.Session.Chart()

  try {
    return await new Promise((resolve, reject) => {
      let availablePeriodCount = 0
      let settled = false
      let settleTimeoutId = null
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

      chart.onError((...messages) => {
        finish(
          reject,
          new Error(
            `TradingView chart ${symbol} error: ${formatChartError(messages)}`,
          ),
        )
      })

      chart.onUpdate((changes) => {
        if (!Array.isArray(changes) || !changes.includes("$prices")) {
          return
        }

        availablePeriodCount = chart.periods.length
        clearTimeout(settleTimeoutId)
        settleTimeoutId = setTimeout(() => {
          finish(resolve, [...chart.periods])
        }, settleDelayMs)
      })

      timeoutId = setTimeout(() => {
        finish(
          reject,
          new Error(
            `TradingView chart ${symbol} timed out after ${timeoutMs} ms with ${availablePeriodCount} periods`,
          ),
        )
      }, timeoutMs)

      try {
        chart.setMarket(symbol, {
          timeframe,
          range,
          ...(to === undefined ? {} : { to }),
        })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)

        finish(
          reject,
          new Error(`Failed to set TradingView chart ${symbol}: ${message}`, {
            cause: error,
          }),
        )
      }
    })
  } finally {
    chart.delete()
  }
}
