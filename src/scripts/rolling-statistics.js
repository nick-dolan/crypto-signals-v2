function validateSeries (source, name) {
  if (!Array.isArray(source)) {
    throw new Error(`${name} must be an array`)
  }

  for (const [index, value] of source.entries()) {
    if (value !== null && !Number.isFinite(value)) {
      throw new Error(`${name} at index ${index} must be a finite number or null`)
    }
  }
}

function validateWindow (window) {
  if (!Number.isInteger(window) || window <= 0) {
    throw new Error("window must be a positive integer")
  }
}

function median (values) {
  const sorted = [...values].sort((first, second) => first - second)
  const middle = Math.floor(sorted.length / 2)

  return sorted.length % 2 === 0
    ? sorted[middle - 1] / 2 + sorted[middle] / 2
    : sorted[middle]
}

function rollingValues (source, window, calculate) {
  validateSeries(source, "Source")
  validateWindow(window)

  return source.map((_, index) => {
    if (index < window - 1) {
      return null
    }

    const values = source.slice(index - window + 1, index + 1)

    if (!values.every(Number.isFinite)) {
      return null
    }

    const result = calculate(values)
    return Number.isFinite(result) ? result : null
  })
}

function rollingMoments (source, window) {
  validateSeries(source, "Source")
  validateWindow(window)

  let total = 0
  let totalSquares = 0
  let missing = 0

  return source.map((value, index) => {
    if (Number.isFinite(value)) {
      total += value
      totalSquares += value ** 2
    } else {
      missing += 1
    }

    if (index >= window) {
      const expired = source[index - window]

      if (Number.isFinite(expired)) {
        total -= expired
        totalSquares -= expired ** 2
      } else {
        missing -= 1
      }
    }

    if (index < window - 1 || missing > 0) {
      return null
    }

    let average = total / window
    let variance = Math.max(0, totalSquares / window - average ** 2)

    if (variance < 1e-14) {
      const values = source.slice(index - window + 1, index + 1)
      total = values.reduce((sum, current) => sum + current, 0)
      totalSquares = values.reduce((sum, current) => sum + current ** 2, 0)
      average = total / window
      variance = values.reduce(
        (sum, current) => sum + (current - average) ** 2,
        0,
      ) / window
    }

    return { total, average, variance }
  })
}

function rollingPairMoments (first, second, window) {
  validateSeries(first, "First source")
  validateSeries(second, "Second source")
  validateWindow(window)

  if (first.length !== second.length) {
    throw new Error("Sources must have equal lengths")
  }

  let firstTotal = 0
  let secondTotal = 0
  let firstSquares = 0
  let secondSquares = 0
  let products = 0
  let missing = 0

  return first.map((firstValue, index) => {
    const secondValue = second[index]

    if (Number.isFinite(firstValue) && Number.isFinite(secondValue)) {
      firstTotal += firstValue
      secondTotal += secondValue
      firstSquares += firstValue ** 2
      secondSquares += secondValue ** 2
      products += firstValue * secondValue
    } else {
      missing += 1
    }

    if (index >= window) {
      const expiredFirst = first[index - window]
      const expiredSecond = second[index - window]

      if (Number.isFinite(expiredFirst) && Number.isFinite(expiredSecond)) {
        firstTotal -= expiredFirst
        secondTotal -= expiredSecond
        firstSquares -= expiredFirst ** 2
        secondSquares -= expiredSecond ** 2
        products -= expiredFirst * expiredSecond
      } else {
        missing -= 1
      }
    }

    if (index < window - 1 || missing > 0) {
      return null
    }

    const firstMean = firstTotal / window
    const secondMean = secondTotal / window

    return {
      covariance: products / window - firstMean * secondMean,
      firstVariance: Math.max(0, firstSquares / window - firstMean ** 2),
      secondVariance: Math.max(0, secondSquares / window - secondMean ** 2),
    }
  })
}

export function rollingSum (source, window) {
  return rollingMoments(source, window).map(moment => moment?.total ?? null)
}

export function rollingMean (source, window) {
  return rollingMoments(source, window).map(moment => moment?.average ?? null)
}

export function rollingMedian (source, window) {
  return rollingValues(source, window, median)
}

export function rollingStandardDeviation (source, window) {
  return rollingMoments(source, window).map(moment => (
    moment ? Math.sqrt(moment.variance) : null
  ))
}

export function rollingZScore (source, window) {
  return rollingMoments(source, window).map((moment, index) => {
    if (!moment) {
      return null
    }

    const standardDeviation = Math.sqrt(moment.variance)
    return standardDeviation === 0
      ? 0
      : (source[index] - moment.average) / standardDeviation
  })
}

export function rollingPercentileRank (source, window) {
  return rollingValues(source, window, (values) => {
    const current = values.at(-1)
    const less = values.filter(value => value < current).length
    const equal = values.filter(value => value === current).length

    return (less + equal / 2) / window
  })
}

export function rollingMinimum (source, window) {
  return rollingValues(source, window, values => Math.min(...values))
}

export function rollingMaximum (source, window) {
  return rollingValues(source, window, values => Math.max(...values))
}

export function rollingCorrelation (first, second, window) {
  return rollingPairMoments(first, second, window).map((moment) => {
    if (!moment || moment.firstVariance === 0 || moment.secondVariance === 0) {
      return null
    }

    return moment.covariance
      / Math.sqrt(moment.firstVariance * moment.secondVariance)
  })
}

export function rollingBeta (dependent, independent, window) {
  return rollingPairMoments(dependent, independent, window).map(moment => (
    !moment || moment.secondVariance === 0
      ? null
      : moment.covariance / moment.secondVariance
  ))
}
