import TradingView from "@mathieuc/tradingview"
import { isObject } from "radash"
import { getTradingViewIndicator } from "../client.js"

const DEFAULT_INDICATOR_VERSION = "last"

function getRequiredString (value, name) {
  const normalizedValue = typeof value === "string" ? value.trim() : ""

  if (!normalizedValue) {
    throw new Error(`${name} is required`)
  }

  return normalizedValue
}

function getErrorMessage (error) {
  return error instanceof Error ? error.message : String(error)
}

function cloneIndicatorInput (input) {
  if (!isObject(input)) {
    return input
  }

  return {
    ...input,
    ...(Array.isArray(input.options) ? { options: [...input.options] } : {}),
  }
}

function cloneIndicatorInputs (inputs) {
  if (!isObject(inputs)) {
    return {}
  }

  return Object.fromEntries(
    Object.entries(inputs).map(([key, input]) => [
      key,
      cloneIndicatorInput(input),
    ]),
  )
}

function freezeIndicatorInputs (inputs) {
  const frozenInputs = Object.fromEntries(
    Object.entries(cloneIndicatorInputs(inputs)).map(([key, input]) => {
      if (!isObject(input)) {
        return [key, input]
      }

      if (Array.isArray(input.options)) {
        Object.freeze(input.options)
      }

      return [key, Object.freeze(input)]
    }),
  )

  return Object.freeze(frozenInputs)
}

function normalizeInputOverrides (inputs) {
  if (inputs === undefined) {
    return {}
  }

  if (!isObject(inputs)) {
    throw new Error("TradingView indicator inputs must be an object")
  }

  return { ...inputs }
}

function normalizeIndicatorRequest (request) {
  if (!isObject(request)) {
    throw new Error("TradingView indicator request must be an object")
  }

  return {
    id: getRequiredString(request.id, "TradingView indicator id"),
    version: request.version === undefined
      ? DEFAULT_INDICATOR_VERSION
      : getRequiredString(request.version, "TradingView indicator version"),
    inputs: normalizeInputOverrides(request.inputs),
  }
}

function createIndicatorTemplate (indicator, requestedId, requestedVersion) {
  if (!indicator) {
    throw new Error("TradingView returned an empty indicator")
  }

  const id = getRequiredString(
    indicator.pineId || requestedId,
    "Resolved TradingView indicator id",
  )
  const version = getRequiredString(
    indicator.pineVersion || requestedVersion,
    "Resolved TradingView indicator version",
  )
  const script = typeof indicator.script === "string" ? indicator.script : ""

  if (!script.trim()) {
    throw new Error(`TradingView indicator ${id} script is required`)
  }

  const name = typeof indicator.description === "string"
    && indicator.description.trim()
    ? indicator.description.trim()
    : id
  const shortName = typeof indicator.shortDescription === "string"
    && indicator.shortDescription.trim()
    ? indicator.shortDescription.trim()
    : name

  return Object.freeze({
    requestedId,
    requestedVersion,
    id,
    version,
    name,
    shortName,
    type: indicator.type,
    inputs: freezeIndicatorInputs(indicator.inputs),
    plots: Object.freeze({ ...indicator.plots }),
    script,
  })
}

function createIndicatorOptions (template) {
  return {
    pineId: template.id,
    pineVersion: template.version,
    description: template.name,
    shortDescription: template.shortName,
    inputs: cloneIndicatorInputs(template.inputs),
    plots: { ...template.plots },
    script: template.script,
  }
}

function createPublicMetadata (template, indicatorInputs = template.inputs) {
  return Object.freeze({
    requestedId: template.requestedId,
    requestedVersion: template.requestedVersion,
    id: template.id,
    version: template.version,
    name: template.name,
    shortName: template.shortName,
    type: template.type,
    inputs: freezeIndicatorInputs(indicatorInputs),
    plots: Object.freeze({ ...template.plots }),
  })
}

export function createTradingViewIndicatorResolver ({
  loadIndicator = getTradingViewIndicator,
  PineIndicator = TradingView.PineIndicator,
} = {}) {
  if (typeof loadIndicator !== "function") {
    throw new Error("loadIndicator must be a function")
  }

  if (typeof PineIndicator !== "function") {
    throw new Error("PineIndicator must be a constructor")
  }

  const templatePromises = new Map()

  async function getTemplate (id, version) {
    const cacheKey = `${id}\u0000${version}`
    let templatePromise = templatePromises.get(cacheKey)

    if (!templatePromise) {
      templatePromise = Promise.resolve()
        .then(() => loadIndicator(id, version))
        .then(indicator => createIndicatorTemplate(indicator, id, version))
      templatePromises.set(cacheKey, templatePromise)
    }

    try {
      return await templatePromise
    } catch (error) {
      if (templatePromises.get(cacheKey) === templatePromise) {
        templatePromises.delete(cacheKey)
      }

      throw new Error(
        `Failed to resolve TradingView indicator ${id}@${version}: ${getErrorMessage(error)}`,
        { cause: error },
      )
    }
  }

  async function resolve (id, version = DEFAULT_INDICATOR_VERSION) {
    const normalizedId = getRequiredString(id, "TradingView indicator id")
    const normalizedVersion = getRequiredString(
      version,
      "TradingView indicator version",
    )
    const template = await getTemplate(normalizedId, normalizedVersion)

    return createPublicMetadata(template)
  }

  async function create (request) {
    const normalizedRequest = normalizeIndicatorRequest(request)
    const template = await getTemplate(
      normalizedRequest.id,
      normalizedRequest.version,
    )
    const indicator = new PineIndicator(createIndicatorOptions(template))

    if (template.type && indicator.type !== template.type) {
      indicator.setType(template.type)
    }

    for (const [key, value] of Object.entries(normalizedRequest.inputs)) {
      try {
        indicator.setOption(key, value)
      } catch (error) {
        throw new Error(
          `Invalid input ${key} for TradingView indicator ${template.id}: ${getErrorMessage(error)}`,
          { cause: error },
        )
      }
    }

    return {
      indicator,
      metadata: createPublicMetadata(template, indicator.inputs),
    }
  }

  function clear () {
    templatePromises.clear()
  }

  return Object.freeze({
    resolve,
    create,
    clear,
  })
}

export const tradingViewIndicatorResolver = createTradingViewIndicatorResolver()

export function resolveTradingViewIndicator (id, version) {
  return tradingViewIndicatorResolver.resolve(id, version)
}

export function createTradingViewIndicatorInstance (request) {
  return tradingViewIndicatorResolver.create(request)
}

export function clearTradingViewIndicatorCache () {
  tradingViewIndicatorResolver.clear()
}
