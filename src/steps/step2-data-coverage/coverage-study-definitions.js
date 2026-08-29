import { DERIVATIVE_INDICATOR_DEFINITIONS } from "../../api/tradingview/indicators/derivatives.js"
import { SOCIAL_INDICATOR_DEFINITIONS } from "../../api/tradingview/indicators/social.js"
import { VOLUME_INDICATOR_DEFINITIONS } from "../../api/tradingview/indicators/volume.js"
import { DATA_COVERAGE_REQUIRED_STUDIES } from "./config.js"

function getDefinitionsByKey (definitions, requiredKeys, group) {
  const definitionsByKey = new Map(
    definitions.map(definition => [definition.key, definition]),
  )

  return requiredKeys.map((key) => {
    const definition = definitionsByKey.get(key)

    if (!definition) {
      throw new Error(`Required ${group} indicator definition ${key} is missing`)
    }

    return definition
  })
}

const REQUIRED_VOLUME_DEFINITIONS = getDefinitionsByKey(
  VOLUME_INDICATOR_DEFINITIONS,
  DATA_COVERAGE_REQUIRED_STUDIES.volume,
  "volume",
)
const REQUIRED_DERIVATIVE_DEFINITIONS = getDefinitionsByKey(
  DERIVATIVE_INDICATOR_DEFINITIONS,
  DATA_COVERAGE_REQUIRED_STUDIES.derivatives,
  "derivative",
)
const REQUIRED_SOCIAL_DEFINITIONS = getDefinitionsByKey(
  SOCIAL_INDICATOR_DEFINITIONS,
  DATA_COVERAGE_REQUIRED_STUDIES.social,
  "social",
)

export const REQUIRED_STUDY_KEYS = Object.freeze([
  ...REQUIRED_VOLUME_DEFINITIONS,
  ...REQUIRED_DERIVATIVE_DEFINITIONS,
  ...REQUIRED_SOCIAL_DEFINITIONS,
].map(definition => definition.key))

function toCoverageRequest (definition, inputs) {
  return Object.freeze({
    ...definition,
    ...(inputs === undefined ? {} : { inputs: Object.freeze(inputs) }),
    allowMissingValues: true,
  })
}

export function createCoverageStudyRequests (tradingViewSymbol) {
  const normalizedSymbol = typeof tradingViewSymbol === "string"
    ? tradingViewSymbol.trim()
    : ""

  if (!normalizedSymbol) {
    throw new Error("Coin tradingViewSymbol is required")
  }

  return Object.freeze([
    ...REQUIRED_VOLUME_DEFINITIONS.map(definition => (
      toCoverageRequest(definition)
    )),
    ...REQUIRED_DERIVATIVE_DEFINITIONS.map(definition => (
      toCoverageRequest(definition)
    )),
    ...REQUIRED_SOCIAL_DEFINITIONS.map(definition => (
      toCoverageRequest(definition, {
        ...definition.inputs,
        in_0: normalizedSymbol,
      })
    )),
  ])
}
