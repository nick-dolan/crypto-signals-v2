import { DERIVATIVE_INDICATOR_DEFINITIONS } from "../../api/tradingview/indicators/derivatives.js"
import { SOCIAL_INDICATOR_DEFINITIONS } from "../../api/tradingview/indicators/social.js"
import { VOLUME_INDICATOR_DEFINITIONS } from "../../api/tradingview/indicators/volume.js"
import { isString } from "../../helpers/utils.typed.js"

function getRequiredStudyDefinitions () {
  const definitionsByKey = new Map([
    ...VOLUME_INDICATOR_DEFINITIONS,
    ...DERIVATIVE_INDICATOR_DEFINITIONS,
    ...SOCIAL_INDICATOR_DEFINITIONS,
  ].map(definition => [definition.key, definition]))

  return Object.freeze([
    "volumeDelta",
    "openInterest",
    "fundingRate",
    "liquidations",
    "longShortRatioAccounts",
    "topTradersLongShortPositions",
    "premium",
    "socialDominance",
    "interactions",
    "activeContributors",
    "createdPosts",
  ].map((key) => {
    const definition = definitionsByKey.get(key)

    if (!definition) {
      throw new Error(`Required indicator definition ${key} is missing`)
    }

    return definition
  }))
}

function toCoverageRequest (definition, tradingViewSymbol) {
  return Object.freeze({
    ...definition,
    ...(definition.group === "social"
      ? {
          inputs: Object.freeze({
            ...definition.inputs,
            in_0: tradingViewSymbol,
          }),
        }
      : {}),
    allowMissingValues: true,
  })
}

export function createCoverageStudyRequests (tradingViewSymbol) {
  const normalizedSymbol = isString(tradingViewSymbol)
    ? tradingViewSymbol.trim()
    : ""

  if (!normalizedSymbol) {
    throw new Error("Coin tradingViewSymbol is required")
  }

  return Object.freeze(getRequiredStudyDefinitions().map(
    definition => toCoverageRequest(definition, normalizedSymbol),
  ))
}
