import { isArray, isFinite, isSafeInteger } from "../../helpers/utils.typed.js"

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

export function buildCoinCardData (report, coin) {
  const asOf = Date.parse(report.asOf) / 1_000
  if (report.timeframe !== "1h" || !isSafeInteger(asOf) || asOf % 3_600 !== 0) {
    throw new Error("Coin cards require a closed hourly report (asOf, 1h)")
  }

  const candles = indexHours(coin.history?.candles, asOf)
  const volumes = indexHours(coin.history?.volume, asOf)
  const interests = indexHours(coin.history?.openInterest, asOf)
  // A complete hourly grid preserves gaps in both geometry and d3-shape paths.
  const points = Array.from({ length: 72 }, (_, index) => {
    const time = asOf - (71 - index) * 3_600
    const candle = candles.get(time)
    return {
      time,
      candle: validCandle(candle) ? candle : null,
      volume: nonnegativeValue(volumes.get(time)),
      openInterest: nonnegativeValue(interests.get(time)),
    }
  })
  const last = points.at(-1)
  const price = last.candle?.close ?? null
  const coverage = {
    candles: points.filter(point => point.candle).length,
    volume: points.filter(point => point.volume !== null).length,
    openInterest: points.filter(point => point.openInterest !== null).length,
  }
  const warnings = []
  if (Object.values(coverage).some(count => count < 72)) {
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
    demo: report.demo === true,
    asOf,
    // asOf labels the OPEN of the last closed candle, not its closing time.
    closedAt: asOf + 3_600,
    points,
    coverage,
    price,
    change4hPct: change(price, points.at(-5).candle?.close),
    change24hPct: change(price, points.at(-25).candle?.close),
    oiChange4hPct: change(last.openInterest, points.at(-5).openInterest),
    relativeVolume: isFinite(coin.features?.relVolume) && coin.features.relVolume >= 0 ? coin.features.relVolume : null,
    warnings,
  }
}
