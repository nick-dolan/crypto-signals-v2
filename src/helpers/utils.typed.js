export {
  isArray,
  isDate,
  isEmpty,
  isEqual,
  isFloat,
  isFunction,
  isInt,
  isNumber,
  isObject,
  isPrimitive,
  isPromise,
  isString,
  isSymbol,
} from "radash"

export function isBoolean (value) {
  return typeof value === "boolean"
}

export function isError (value) {
  return value instanceof Error
}

export function isFinite (value) {
  return Number.isFinite(value)
}

export function isNaN (value) {
  return Number.isNaN(value)
}

export function isSafeInteger (value) {
  return Number.isSafeInteger(value)
}

export function isSet (value) {
  return value instanceof Set
}

export function isURLSearchParams (value) {
  return value instanceof URLSearchParams
}
