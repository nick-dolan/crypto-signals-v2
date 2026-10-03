import { isObject, isString } from "../../helpers/utils.typed.js"

export function readCoinSummary (value, label) {
  if (
    !isObject(value)
    || Object.keys(value).length !== 2
    || !Object.hasOwn(value, "observation")
    || !Object.hasOwn(value, "caveat")
  ) {
    throw new Error(`${label} must contain only observation and caveat`)
  }

  if (!isString(value.observation) || !value.observation.trim() || value.observation.length > 300) {
    throw new Error(`${label}.observation must be a non-empty string of at most 300 characters`)
  }

  if (value.caveat !== null && (
    !isString(value.caveat) || !value.caveat.trim() || value.caveat.length > 180
  )) {
    throw new Error(`${label}.caveat must be a non-empty string of at most 180 characters or null`)
  }

  return { observation: value.observation.trim(), caveat: value.caveat === null ? null : value.caveat.trim() }
}

export function formatCoinSummary ({ observation, caveat }) {
  return [observation, caveat].filter(Boolean).join(" ")
}
