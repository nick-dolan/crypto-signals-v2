function validateNumericSeries (source, name) {
  if (!Array.isArray(source)) {
    throw new Error(`${name} must be an array`)
  }

  for (const [index, value] of source.entries()) {
    if (value !== null && !Number.isFinite(value)) {
      throw new Error(`${name} at index ${index} must be a finite number or null`)
    }
  }
}

function validateCountSeries (source) {
  if (!Array.isArray(source)) {
    throw new Error("Source must be an array")
  }

  for (const [index, value] of source.entries()) {
    if (
      value !== null
      && typeof value !== "boolean"
      && !Number.isFinite(value)
    ) {
      throw new Error(
        `Source at index ${index} must be a finite number, boolean, or null`,
      )
    }
  }
}

function validatePositiveInteger (value, name) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`)
  }
}

function finiteOrNull (value) {
  return Number.isFinite(value) ? value : null
}

export function mapSeries (source, mapper) {
  validateNumericSeries(source, "Source")

  return source.map((value, index) => (
    Number.isFinite(value) ? mapper(value, index) : null
  ))
}

export function combineSeries (sources, mapper) {
  if (!Array.isArray(sources) || sources.length === 0) {
    throw new Error("Sources must be a non-empty array of arrays")
  }

  for (const [index, source] of sources.entries()) {
    validateNumericSeries(source, `Source ${index}`)
  }

  if (sources.some(source => source.length !== sources[0].length)) {
    throw new Error("Sources must have equal lengths")
  }

  return sources[0].map((_, index) => {
    const values = sources.map(source => source[index])

    return values.every(Number.isFinite) ? mapper(values, index) : null
  })
}

export function lag (source, offset) {
  validateNumericSeries(source, "Source")
  validatePositiveInteger(offset, "offset")

  return source.map((_, index) => (
    index < offset ? null : source[index - offset]
  ))
}

export function difference (source, offset = 1) {
  return combineSeries(
    [source, lag(source, offset)],
    ([current, previous]) => finiteOrNull(current - previous),
  )
}

export function ratioSeries (numerator, denominator) {
  return combineSeries([numerator, denominator], ([top, bottom]) => (
    bottom === 0 ? null : finiteOrNull(top / bottom)
  ))
}

export function cumulativeSum (source) {
  let total = 0

  return mapSeries(source, (value) => {
    total += value
    return finiteOrNull(total)
  })
}

export function consecutiveCount (source, predicate) {
  validateCountSeries(source)

  let streak = 0

  return source.map((value, index) => {
    if (value === null) {
      streak = 0
      return null
    }

    streak = predicate(value, index) ? streak + 1 : 0
    return streak
  })
}
