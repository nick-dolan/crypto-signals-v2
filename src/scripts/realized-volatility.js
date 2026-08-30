import { rollingStandardDeviation } from "./rolling-statistics.js"
import { logReturns } from "./returns.js"

export function realizedVolatility (close, length) {
  return rollingStandardDeviation(logReturns(close), length)
}
