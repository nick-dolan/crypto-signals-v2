import { isArray, isObject, isSafeInteger, isString } from "../../helpers/utils.typed.js"
import { buildHourlyChartData } from "../../helpers/hourly-chart-data-helper.js"

export function validatePatternShortlist (input) {
  if (!isObject(input) || !isArray(input.candidates) || input.candidateCount !== input.candidates.length) {
    throw new Error("Step 5 shortlist and matching candidateCount are required")
  }

  const asOf = isString(input.asOf) ? Date.parse(input.asOf) / 1_000 : NaN
  if (input.timeframe !== "1h" || !isSafeInteger(asOf) || asOf % 3_600 !== 0) {
    throw new Error("Pattern analysis requires a closed hourly snapshot (asOf, 1h)")
  }

  const symbols = input.candidates.map(({ coin } = {}) => {
    if (![coin?.symbol, coin?.baseCurrencyId, coin?.marketSymbol].every(value => isString(value) && value.trim())) {
      throw new Error("Pattern candidates require symbol, baseCurrencyId and marketSymbol")
    }
    return coin.symbol.toUpperCase()
  })
  if (new Set(symbols).size !== symbols.length) {
    throw new Error("Pattern candidates contain duplicate symbols")
  }
  return asOf
}

export function buildPatternData (coin, history, asOf) {
  const chart = buildHourlyChartData({ asOf, timeframe: "1h" }, { ...coin, history })
  return {
    schemaVersion: 1,
    coin: {
      symbol: coin.symbol,
      name: coin.name ?? coin.symbol,
      baseCurrencyId: coin.baseCurrencyId,
      marketSymbol: coin.marketSymbol,
    },
    asOf,
    timeframe: "1h",
    from: new Date(chart.points[0].time * 1_000).toISOString(),
    to: new Date(chart.closedAt * 1_000).toISOString(),
    timeConvention: "time: Unix seconds UTC, candle open; asOf: open of the last closed candle; to: exclusive end",
    coverage: chart.coverage,
    warnings: chart.warnings,
    candles: chart.points.map(({ time, candle, volume }) => ({
      time,
      open: candle?.open ?? null,
      high: candle?.high ?? null,
      low: candle?.low ?? null,
      close: candle?.close ?? null,
      volume,
    })),
  }
}
