import { combineSeries } from "./series.js"
import {
  rollingMean,
  rollingStandardDeviation,
} from "./rolling-statistics.js"

export function bollingerBandwidth (
  source,
  length = 20,
  standardDeviations = 2,
) {
  if (!Number.isFinite(standardDeviations) || standardDeviations < 0) {
    throw new Error("standardDeviations must be a non-negative finite number")
  }

  return combineSeries(
    [
      rollingMean(source, length),
      rollingStandardDeviation(source, length),
    ],
    ([average, standardDeviation]) => (
      average === 0
        ? null
        : 2 * standardDeviations * standardDeviation / average
    ),
  )
}
