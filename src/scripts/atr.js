import { combineSeries, lag } from "./series.js"
import { rollingMean } from "./rolling-statistics.js"

export function trueRange (high, low, close) {
  return combineSeries(
    [high, low, lag(close, 1)],
    ([currentHigh, currentLow, previousClose]) => Math.max(
      currentHigh - currentLow,
      Math.abs(currentHigh - previousClose),
      Math.abs(currentLow - previousClose),
    ),
  )
}

export function averageTrueRange (high, low, close, length) {
  return rollingMean(trueRange(high, low, close), length)
}
