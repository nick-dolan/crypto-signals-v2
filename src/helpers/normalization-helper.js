export function parseInteger (value, name) {
  const parsedValue = typeof value === "number"
    ? value
    : typeof value === "string" && value.trim()
      ? Number(value)
      : Number.NaN

  if (!Number.isSafeInteger(parsedValue)) {
    throw new Error(`${name} must be an integer`)
  }

  return parsedValue
}

export function getRequiredString (value, name) {
  const normalizedValue = typeof value === "string" ? value.trim() : ""

  if (!normalizedValue) {
    throw new Error(`${name} is required`)
  }

  return normalizedValue
}

export function toIsoTimestamp (value, name) {
  const date = value instanceof Date
    ? value
    : typeof value === "string" && value.trim()
      ? new Date(value)
      : new Date(Number.NaN)

  if (Number.isNaN(date.getTime())) {
    throw new Error(`${name} must be a valid timestamp`)
  }

  return date.toISOString()
}
