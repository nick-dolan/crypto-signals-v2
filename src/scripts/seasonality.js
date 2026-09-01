import { isFinite, isInt } from "../helpers/utils.typed.js"
import { mapSeries } from "./series.js"

function validatePositiveInteger (value, name) {
  if (!isInt(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`)
  }
}

function median (values) {
  const sorted = [...values].sort((first, second) => first - second)
  const middle = Math.floor(sorted.length / 2)

  return sorted.length % 2 === 0
    ? sorted[middle - 1] / 2 + sorted[middle] / 2
    : sorted[middle]
}

export function relativeToSeasonalMedian (
  source,
  seasonLength,
  observations,
) {
  validatePositiveInteger(seasonLength, "seasonLength")
  validatePositiveInteger(observations, "observations")

  return mapSeries(source, (current, index) => {
    if (index < seasonLength * observations) {
      return null
    }

    const baseline = Array.from(
      { length: observations },
      (_, observation) => source[index - seasonLength * (observation + 1)],
    )

    if (!baseline.every(isFinite)) {
      return null
    }

    const seasonalMedian = median(baseline)
    const relative = current / seasonalMedian

    return seasonalMedian === 0 || !isFinite(relative)
      ? null
      : relative
  })
}
