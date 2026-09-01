import { isDate, isNaN, isNumber, isPrimitive, isSafeInteger, isString } from "./utils.typed.js"

export function parseInteger (value, name) {
  const parsedValue = isNumber(value)
    ? value
    : isPrimitive(value) && isString(value) && value.trim()
      ? Number(value)
      : Number.NaN

  if (!isSafeInteger(parsedValue)) {
    throw new Error(`${name} must be an integer`)
  }

  return parsedValue
}

export function getRequiredString (value, name) {
  const normalizedValue = isPrimitive(value) && isString(value) ? value.trim() : ""

  if (!normalizedValue) {
    throw new Error(`${name} is required`)
  }

  return normalizedValue
}

export function toIsoTimestamp (value, name) {
  const date = isDate(value)
    ? value
    : isPrimitive(value) && isString(value) && value.trim()
      ? new Date(value)
      : new Date(Number.NaN)

  if (isNaN(date.getTime())) {
    throw new Error(`${name} must be a valid timestamp`)
  }

  return date.toISOString()
}
