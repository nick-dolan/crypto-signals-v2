import assert from "node:assert/strict"
import test from "node:test"

import {
  isArray,
  isBoolean,
  isDate,
  isEmpty,
  isEqual,
  isError,
  isFinite,
  isFloat,
  isFunction,
  isInt,
  isNaN,
  isNumber,
  isObject,
  isPrimitive,
  isPromise,
  isSafeInteger,
  isSet,
  isString,
  isSymbol,
  isURLSearchParams,
} from "../src/helpers/utils.typed.js"

test("re-exports every Radash typed utility", () => {
  assert.equal(isArray([]), true)
  assert.equal(isDate(new Date()), true)
  assert.equal(isEmpty({}), true)
  assert.equal(isEqual({ value: 1 }, { value: 1 }), true)
  assert.equal(isFloat(1.5), true)
  assert.equal(isFunction(() => {}), true)
  assert.equal(isInt(1), true)
  assert.equal(isNumber(1.5), true)
  assert.equal(isObject({}), true)
  assert.equal(isObject(null), false)
  assert.equal(isObject([]), false)
  assert.equal(isPrimitive(null), true)
  assert.equal(isPromise(Promise.resolve()), true)
  assert.equal(isString("value"), true)
  assert.equal(isSymbol(Symbol("value")), true)
})

test("provides strict project type checks missing from Radash", () => {
  assert.equal(isBoolean(false), true)
  assert.equal(isBoolean(0), false)
  assert.equal(isError(new Error("failure")), true)
  assert.equal(isError("failure"), false)
  assert.equal(isFinite(1.5), true)
  assert.equal(isFinite(Infinity), false)
  assert.equal(isFinite("1.5"), false)
  assert.equal(isNaN(Number.NaN), true)
  assert.equal(isNaN("NaN"), false)
  assert.equal(isSafeInteger(Number.MAX_SAFE_INTEGER), true)
  assert.equal(isSafeInteger(Number.MAX_SAFE_INTEGER + 1), false)
  assert.equal(isSet(new Set()), true)
  assert.equal(isSet([]), false)
  assert.equal(isURLSearchParams(new URLSearchParams()), true)
  assert.equal(isURLSearchParams({}), false)
})
