import { isObject } from "../../helpers/utils.typed.js"

export function normalizeTradingViewChartPeriods (candles) {
  return candles
    .filter(isObject)
    .map(({ time, open, high, low, close, volume }) => ({
      time,
      open,
      max: high,
      min: low,
      close,
      volume: Math.round(volume * 100) / 100,
    }))
    .sort((first, second) => first.time - second.time)
}
