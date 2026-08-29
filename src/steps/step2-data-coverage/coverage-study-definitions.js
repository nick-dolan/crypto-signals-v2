import { DERIVATIVE_INDICATOR_DEFINITIONS } from "../../api/tradingview/indicators/derivatives.js"
import { SOCIAL_INDICATOR_DEFINITIONS } from "../../api/tradingview/indicators/social.js"
import { VOLUME_INDICATOR_DEFINITIONS } from "../../api/tradingview/indicators/volume.js"

const REQUIRED_DERIVATIVE_KEYS = Object.freeze([
  "openInterest",
  "fundingRate",
  "liquidations",
  "longShortRatioAccounts",
  "topTradersLongShortPositions",
  "premium",
])

const REQUIRED_SOCIAL_KEYS = Object.freeze([
  "socialDominance",
  "interactions",
  "activeContributors",
  "createdPosts",
])

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
  ["volumeDelta"],
  "volume",
)
const REQUIRED_DERIVATIVE_DEFINITIONS = getDefinitionsByKey(
  DERIVATIVE_INDICATOR_DEFINITIONS,
  REQUIRED_DERIVATIVE_KEYS,
  "derivative",
)
const REQUIRED_SOCIAL_DEFINITIONS = getDefinitionsByKey(
  SOCIAL_INDICATOR_DEFINITIONS,
  REQUIRED_SOCIAL_KEYS,
  "social",
)

export const REQUIRED_STUDY_KEYS = Object.freeze([
  ...REQUIRED_VOLUME_DEFINITIONS,
  ...REQUIRED_DERIVATIVE_DEFINITIONS,
  ...REQUIRED_SOCIAL_DEFINITIONS,
].map(definition => definition.key))

export const SPARSE_STUDY_KEYS = Object.freeze(["liquidations"])

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
