import { isArray, isFinite, isSafeInteger } from "./utils.typed.js"

function indexHours (items, asOf) {
  return new Map((isArray(items) ? items : [])
    .filter(item => isSafeInteger(item?.time) && item.time % 3_600 === 0 && item.time <= asOf)
    .map(item => [item.time, item]))
}

function validCandle (candle) {
  return candle && [candle.open, candle.high, candle.low, candle.close].every(value => isFinite(value) && value > 0)
    && candle.low <= Math.min(candle.open, candle.close)
    && candle.high >= Math.max(candle.open, candle.close)
}

function nonnegativeValue (point) {
  return isFinite(point?.value) && point.value >= 0 ? point.value : null
}

export function buildHourlyChartData (report, coin, { hours = 168, includeInterest = false } = {}) {
  const asOf = Date.parse(report.asOf) / 1_000
  if (report.timeframe !== "1h" || !isSafeInteger(asOf) || asOf % 3_600 !== 0) {
    throw new Error("Charts require a closed hourly report (asOf, 1h)")
  }
  if (!isSafeInteger(hours) || hours < 1) {
    throw new Error("Chart hours must be a positive integer")
  }

  const candles = indexHours(coin.history?.candles, asOf)
  const volumes = indexHours(coin.history?.volume, asOf)
  const interests = includeInterest ? indexHours(coin.history?.openInterest, asOf) : null
  // A complete hourly grid preserves gaps without moving the remaining observations.
  const points = Array.from({ length: hours }, (_, index) => {
    const time = asOf - (hours - 1 - index) * 3_600
    const candle = candles.get(time)
    return {
      time,
      candle: validCandle(candle) ? candle : null,
      volume: nonnegativeValue(volumes.get(time)),
      ...(includeInterest ? { openInterest: nonnegativeValue(interests.get(time)) } : {}),
    }
  })
  const price = points.at(-1).candle?.close ?? null
  const coverage = {
    candles: points.filter(point => point.candle).length,
    volume: points.filter(point => point.volume !== null).length,
    ...(includeInterest ? { openInterest: points.filter(point => point.openInterest !== null).length } : {}),
  }
  const warnings = []
  if (Object.values(coverage).some(count => count < points.length)) {
    warnings.push("Есть пропуски; недостающие значения не восстановлены.")
  }
  if (price === null) {
    warnings.push("Цена на срезе недоступна.")
  }
  if (coin.history?.warning) {
    warnings.push(coin.history.warning)
  }

  return {
    coin,
    asOf,
    // asOf labels the OPEN of the last closed candle, not its closing time.
    closedAt: asOf + 3_600,
    points,
    coverage,
    price,
    warnings,
  }
}
