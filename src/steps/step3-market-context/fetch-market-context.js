import { fetchTradingViewChartPeriods } from "../../api/tradingview/chart-candles.js"
import { getClosedHourlyBoundary } from "../../helpers/hourly-time-helper.js"

function normalizeMarketContextPeriods (symbol, periods, nowTimestamp, requestedHours) {
  const { latestClosedTime } = getClosedHourlyBoundary(nowTimestamp)
  const earliestTime = latestClosedTime - (requestedHours - 1) * 3_600

  const normalizedPeriods = (Array.isArray(periods) ? periods : [])
    .filter(period => (
      Number.isFinite(period?.time)
      && period.time >= earliestTime
      && period.time <= latestClosedTime
    ))
    .sort((first, second) => first.time - second.time)

  const complete = normalizedPeriods.length === requestedHours
    && normalizedPeriods.every((period, index) => (
      period.time === earliestTime + index * 3_600
      && ["open", "max", "min", "close"].every(
        field => Number.isFinite(period[field]),
      )
    ))

  if (!complete) {
    throw new Error(
      `${symbol} does not contain a complete ${requestedHours}-hour history`,
    )
  }

  return normalizedPeriods
}

export function createMarketContextFetcher ({
  fetchChartPeriods = fetchTradingViewChartPeriods,
} = {}) {
  if (typeof fetchChartPeriods !== "function") {
    throw new Error("fetchChartPeriods must be a function")
  }

  return async function fetchMarketContext (
    client,
    {
      nowTimestamp = Number(process.env.PIPELINE_STARTED_AT)
        || Math.floor(Date.now() / 1_000),
      requestedHours = 100 * 24,
      settleDelayMs = 500,
      timeoutMs = 45_000,
    } = {},
  ) {
    if (!Number.isFinite(nowTimestamp)) {
      throw new Error("nowTimestamp must be finite")
    }

    if (!Number.isSafeInteger(requestedHours) || requestedHours <= 0) {
      throw new Error("requestedHours must be a positive integer")
    }

    const { requestTo } = getClosedHourlyBoundary(nowTimestamp)
    const series = await Promise.all([
      ["total", "CRYPTOCAP:TOTAL"],
      ["totales", "CRYPTOCAP:TOTALES"],
      ["total2es", "CRYPTOCAP:TOTAL2ES"],
      ["total3es", "CRYPTOCAP:TOTAL3ES"],
    ].map(async ([key, symbol]) => {
      const periods = await fetchChartPeriods(client, {
        range: requestedHours + 1,
        settleDelayMs,
        symbol,
        timeframe: "60",
        timeoutMs,
        to: requestTo,
      })

      return [key, {
        symbol,
        periods: normalizeMarketContextPeriods(
          symbol,
          periods,
          nowTimestamp,
          requestedHours,
        ),
      }]
    }))

    return {
      collectedAt: new Date(nowTimestamp * 1_000).toISOString(),
      source: "tradingview",
      timeframe: "1h",
      requestedHours,
      series: Object.fromEntries(series),
    }
  }
}

export const fetchMarketContext = createMarketContextFetcher()
