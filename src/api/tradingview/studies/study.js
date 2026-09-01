import {
  isArray,
  isBoolean,
  isError,
  isFinite,
  isFunction,
  isInt,
  isObject,
  isString,
} from "../../../helpers/utils.typed.js"
import { createTradingViewIndicatorInstance } from "./resolver.js"

function getRequiredString (value, name) {
  const normalizedValue = isString(value) ? value.trim() : ""

  if (!normalizedValue) {
    throw new Error(`${name} is required`)
  }

  return normalizedValue
}

function getErrorMessage (error) {
  if (isError(error)) {
    return error.message
  }

  if (isString(error)) {
    return error
  }

  if (error === undefined || error === null) {
    return ""
  }

  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}

function validatePositiveNumber (value, name) {
  if (!isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive number`)
  }

  return value
}

function validateNonNegativeNumber (value, name) {
  if (!isFinite(value) || value < 0) {
    throw new Error(`${name} must be a non-negative number`)
  }

  return value
}

function normalizeInputOverrides (inputs) {
  if (inputs === undefined) {
    return Object.freeze({})
  }

  if (!isObject(inputs)) {
    throw new Error("TradingView study inputs must be an object")
  }

  return Object.freeze({ ...inputs })
}

function normalizeFields (fields) {
  if (fields === undefined) {
    return null
  }

  if (!isObject(fields) || Object.keys(fields).length === 0) {
    throw new Error("TradingView study fields must be a non-empty object")
  }

  const fieldNames = new Set()
  const normalizedFields = []

  for (const [field, plot] of Object.entries(fields)) {
    const normalizedField = getRequiredString(field, "TradingView study field")
    const normalizedPlot = getRequiredString(
      plot,
      `TradingView study plot for ${normalizedField}`,
    )

    if (normalizedField === "time") {
      throw new Error("TradingView study field time is reserved")
    }

    if (fieldNames.has(normalizedField)) {
      throw new Error(`Duplicate TradingView study field ${normalizedField}`)
    }

    fieldNames.add(normalizedField)
    normalizedFields.push([normalizedField, normalizedPlot])
  }

  return Object.freeze(Object.fromEntries(normalizedFields))
}

function normalizeStudyRequest (request) {
  if (!isObject(request)) {
    throw new Error("TradingView study request must be an object")
  }

  if (
    request.allowMissingValues !== undefined
    && !isBoolean(request.allowMissingValues)
  ) {
    throw new Error("allowMissingValues must be a boolean")
  }

  const normalizedRequest = {
    key: getRequiredString(request.key, "TradingView study key"),
    id: getRequiredString(request.id, "TradingView study id"),
    version: request.version === undefined
      ? "last"
      : getRequiredString(request.version, "TradingView study version"),
    inputs: normalizeInputOverrides(request.inputs),
    fields: normalizeFields(request.fields),
    allowMissingValues: Boolean(request.allowMissingValues),
  }

  if (request.group !== undefined) {
    normalizedRequest.group = getRequiredString(
      request.group,
      "TradingView study group",
    )
  }

  if (request.name !== undefined) {
    normalizedRequest.name = getRequiredString(
      request.name,
      "TradingView study name",
    )
  }

  return Object.freeze(normalizedRequest)
}

function normalizeWindow (window, timeframeSeconds) {
  if (window === undefined && timeframeSeconds === undefined) {
    return null
  }

  if (!isObject(window)) {
    throw new Error("TradingView study window must be an object")
  }

  if (
    !isFinite(window.start)
    || !isFinite(window.end)
    || window.end <= window.start
  ) {
    throw new Error("TradingView study window must have valid start and end timestamps")
  }

  validatePositiveNumber(
    timeframeSeconds,
    "TradingView study timeframeSeconds",
  )

  const expectedPeriods = (window.end - window.start) / timeframeSeconds

  if (!isInt(expectedPeriods)) {
    throw new Error(
      "TradingView study window must be divisible by timeframeSeconds",
    )
  }

  return Object.freeze({
    start: window.start,
    end: window.end,
    timeframeSeconds,
    expectedPeriods,
  })
}

function normalizeStudyOptions ({
  window,
  timeframeSeconds,
  timeoutMs = 20_000,
  settleDelayMs = 50,
} = {}) {
  return Object.freeze({
    window: normalizeWindow(window, timeframeSeconds),
    timeoutMs: validatePositiveNumber(
      timeoutMs,
      "TradingView study timeoutMs",
    ),
    settleDelayMs: validateNonNegativeNumber(
      settleDelayMs,
      "TradingView study settleDelayMs",
    ),
  })
}

function getSourcePeriodCount (periods, window) {
  if (!window) {
    return periods.length
  }

  return periods.filter(period => (
    isFinite(period?.$time)
    && period.$time >= window.start
    && period.$time < window.end
  )).length
}

function waitForStudy (
  study,
  label,
  {
    window,
    timeoutMs,
    settleDelayMs,
  },
) {
  return new Promise((resolve, reject) => {
    let availablePeriods = 0
    let hasPlotUpdate = false
    let ready = false
    let settled = false
    let settleTimeoutId = null
    let timeoutId = null

    const finish = (callback, value) => {
      if (settled) {
        return
      }

      settled = true
      clearTimeout(settleTimeoutId)
      clearTimeout(timeoutId)
      callback(value)
    }

    const resolveAfterUpdates = () => {
      if (!ready || !hasPlotUpdate) {
        return
      }

      clearTimeout(settleTimeoutId)
      settleTimeoutId = setTimeout(() => {
        finish(resolve, study.periods)
      }, settleDelayMs)
    }

    study.onError((...messages) => {
      const details = messages.map(getErrorMessage).filter(Boolean).join(" ")
      finish(
        reject,
        new Error(`TradingView ${label} error: ${details || "Unknown error"}`),
      )
    })

    study.onUpdate((changes) => {
      if (!isArray(changes) || !changes.includes("plots")) {
        return
      }

      hasPlotUpdate = true
      availablePeriods = getSourcePeriodCount(study.periods, window)
      resolveAfterUpdates()
    })

    study.onReady(() => {
      ready = true
      resolveAfterUpdates()
    })

    timeoutId = setTimeout(() => {
      finish(
        reject,
        new Error(
          `TradingView ${label} request timed out: received ${availablePeriods} source periods`,
        ),
      )
    }, timeoutMs)
  })
}

function getObservedPlotNames (sourcePeriods) {
  const plotNames = new Set()

  for (const period of sourcePeriods) {
    if (!isObject(period)) {
      continue
    }

    for (const key of Object.keys(period)) {
      if (key !== "$time") {
        plotNames.add(key)
      }
    }
  }

  return plotNames
}

function getAvailablePlotNames (metadata, sourcePeriods) {
  const plotNames = new Set(
    Object.values(metadata.plots).filter(
      plot => isString(plot) && plot.trim(),
    ),
  )

  for (const plot of getObservedPlotNames(sourcePeriods)) {
    plotNames.add(plot)
  }

  return plotNames
}

function getFieldMap (request, metadata, sourcePeriods) {
  const availablePlots = getAvailablePlotNames(metadata, sourcePeriods)

  if (request.fields) {
    const unknownPlots = [...new Set(Object.values(request.fields))]
      .filter(plot => !availablePlots.has(plot))

    if (unknownPlots.length > 0) {
      throw new Error(
        `${request.name || metadata.name}: unknown plots ${unknownPlots.join(", ")}`,
      )
    }

    return request.fields
  }

  if (availablePlots.size === 0) {
    throw new Error(
      `${request.name || metadata.name} does not expose time-series plots`,
    )
  }

  if (availablePlots.has("time")) {
    throw new Error(
      `${request.name || metadata.name}: plot time conflicts with the period timestamp; provide a fields alias`,
    )
  }

  return Object.freeze(Object.fromEntries(
    [...availablePlots].map(plot => [plot, plot]),
  ))
}

function normalizePlotValue (value) {
  if (
    !isFinite(value)
    || Math.abs(value) >= 1e100
  ) {
    return null
  }

  return value
}

function normalizePeriods (sourcePeriods, fieldMap, window) {
  const validSourcePeriods = []
  const seenTimes = new Set()
  let duplicatePeriodCount = 0
  let invalidTimestampCount = 0

  for (const period of sourcePeriods) {
    const time = period?.$time

    if (!isFinite(time)) {
      invalidTimestampCount += 1
      continue
    }

    if (window && (time < window.start || time >= window.end)) {
      continue
    }

    if (seenTimes.has(time)) {
      duplicatePeriodCount += 1
    }

    seenTimes.add(time)
    validSourcePeriods.push(period)
  }

  const sourcesByTime = new Map(
    validSourcePeriods.map(period => [period.$time, period]),
  )
  const periodSources = window
    ? Array.from(
        { length: window.expectedPeriods },
        (_, index) => {
          const time = window.start + index * window.timeframeSeconds

          return { time, source: sourcesByTime.get(time) }
        },
      )
    : validSourcePeriods.map(source => ({
        time: source.$time,
        source,
      }))
  const periods = periodSources.map(({ time, source }) => ({
    time,
    ...Object.fromEntries(
      Object.entries(fieldMap).map(([field, plot]) => [
        field,
        normalizePlotValue(source?.[plot]),
      ]),
    ),
  })).sort((first, second) => first.time - second.time)

  return {
    periods,
    sourcePeriodCount: validSourcePeriods.length,
    duplicatePeriodCount,
    invalidTimestampCount,
  }
}

function getCoverage (
  periods,
  fields,
  sourcePeriodCount,
  duplicatePeriodCount,
  invalidTimestampCount,
) {
  let completePeriods = 0
  let partialPeriods = 0
  let missingPeriods = 0

  for (const period of periods) {
    const availableValues = fields.filter(
      field => isFinite(period[field]),
    ).length

    if (availableValues === fields.length) {
      completePeriods += 1
    } else if (availableValues === 0) {
      missingPeriods += 1
    } else {
      partialPeriods += 1
    }
  }

  return Object.freeze({
    periodCount: periods.length,
    sourcePeriodCount,
    completePeriods,
    partialPeriods,
    missingPeriods,
    duplicatePeriodCount,
    invalidTimestampCount,
  })
}

function validatePeriods (periods, coverage, request, label) {
  if (periods.length === 0 && coverage.invalidTimestampCount === 0) {
    throw new Error(`${label}: no periods received`)
  }

  if (
    request.fields
    && !request.allowMissingValues
    && coverage.completePeriods !== coverage.periodCount
  ) {
    throw new Error(
      `${label}: ${coverage.completePeriods}/${coverage.periodCount} periods are complete`,
    )
  }
}

function createPublicRequest (request) {
  const publicRequest = {
    key: request.key,
    id: request.id,
    version: request.version,
    inputs: request.inputs,
    allowMissingValues: request.allowMissingValues,
  }

  if (request.group) {
    publicRequest.group = request.group
  }

  if (request.name) {
    publicRequest.name = request.name
  }

  if (request.fields) {
    publicRequest.fields = request.fields
  }

  return Object.freeze(publicRequest)
}

export function createTradingViewStudyFetcher ({
  createIndicator = createTradingViewIndicatorInstance,
} = {}) {
  if (!isFunction(createIndicator)) {
    throw new Error("createIndicator must be a function")
  }

  return async function fetchTradingViewStudy (
    chart,
    request,
    options = {},
  ) {
    if (!chart?.Study) {
      throw new Error("TradingView chart with Study support is required")
    }

    const normalizedRequest = normalizeStudyRequest(request)
    const normalizedOptions = normalizeStudyOptions(options)
    const { indicator, metadata } = await createIndicator(normalizedRequest)
    const label = normalizedRequest.name || metadata.name || normalizedRequest.key
    const study = new chart.Study(indicator)

    try {
      const sourcePeriods = await waitForStudy(
        study,
        label,
        normalizedOptions,
      )
      const fieldMap = getFieldMap(
        normalizedRequest,
        metadata,
        sourcePeriods,
      )
      const normalized = normalizePeriods(
        sourcePeriods,
        fieldMap,
        normalizedOptions.window,
      )
      const fields = Object.keys(fieldMap)
      const coverage = getCoverage(
        normalized.periods,
        fields,
        normalized.sourcePeriodCount,
        normalized.duplicatePeriodCount,
        normalized.invalidTimestampCount,
      )

      validatePeriods(
        normalized.periods,
        coverage,
        normalizedRequest,
        label,
      )

      return {
        request: createPublicRequest(normalizedRequest),
        indicator: metadata,
        fields: Object.freeze({ ...fieldMap }),
        periods: normalized.periods,
        coverage,
      }
    } finally {
      study.remove()
    }
  }
}

export const fetchTradingViewStudy = createTradingViewStudyFetcher()
