import { isArray, isFinite, isSafeInteger, isString } from "../../helpers/utils.typed.js"

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

function change (current, previous) {
  return isFinite(current) && isFinite(previous) && previous > 0 ? (current / previous - 1) * 100 : null
}

function buildChartData (report, coin, includeInterest) {
  const asOf = Date.parse(report.asOf) / 1_000
  if (report.timeframe !== "1h" || !isSafeInteger(asOf) || asOf % 3_600 !== 0) {
    throw new Error("Coin cards require a closed hourly report (asOf, 1h)")
  }

  const candles = indexHours(coin.history?.candles, asOf)
  const volumes = indexHours(coin.history?.volume, asOf)
  const interests = includeInterest ? indexHours(coin.history?.openInterest, asOf) : null
  // A complete hourly grid preserves gaps in both geometry and d3-shape paths.
  const points = Array.from({ length: 168 }, (_, index) => {
    const time = asOf - (167 - index) * 3_600
    const candle = candles.get(time)
    return {
      time,
      candle: validCandle(candle) ? candle : null,
      volume: nonnegativeValue(volumes.get(time)),
      ...(includeInterest ? { openInterest: nonnegativeValue(interests.get(time)) } : {}),
    }
  })
  const last = points.at(-1)
  const price = last.candle?.close ?? null
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

export function buildPatternChartData (report, coin) {
  return buildChartData(report, coin, false)
}

export function buildCoinCardData (report, coin) {
  const data = buildChartData(report, coin, true)
  const { price, points } = data
  return {
    ...data,
    growthObjective: isString(report.objective) && report.objective.startsWith("P(рост >"),
    demo: report.demo === true,
    change4hPct: change(price, points.at(-5).candle?.close),
    change24hPct: change(price, points.at(-25).candle?.close),
    oiChange4hPct: change(points.at(-1).openInterest, points.at(-5).openInterest),
    relativeVolume: isFinite(coin.features?.relVolume) && coin.features.relVolume >= 0 ? coin.features.relVolume : null,
  }
}
