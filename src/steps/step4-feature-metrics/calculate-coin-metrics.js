import { calculateBreadthNarrativeMetrics } from "./metrics/breadth-narrative.js"
import { calculateDerivativesMetrics } from "./metrics/derivatives.js"
import { calculateDivergenceFlags } from "./metrics/divergence-flags.js"
import { calculateMovementLifecycleMetrics } from "./metrics/movement-lifecycle.js"
import { calculateRelativeStrengthMetrics } from "./metrics/relative-strength.js"
import { calculateSocialMetrics } from "./metrics/social.js"
import {
  calculateAtr24hPct,
  calculateVolatilityCompressionMetrics,
} from "./metrics/volatility-compression.js"
import { calculateVolumeOrderFlowMetrics } from "./metrics/volume-order-flow.js"

export function calculateCoinMetrics (
  coinSeries,
  coinListContext,
  baseCurrencyId,
) {
  const atr24hPct = calculateAtr24hPct(coinSeries)
  const volatilityCompression = calculateVolatilityCompressionMetrics({
    ...coinSeries,
    atr24hPct,
  })
  const movementLifecycle = calculateMovementLifecycleMetrics({
    ...coinSeries,
    atr24hPct,
    squeezeAge: volatilityCompression.squeeze_age_hours,
  })
  const volumeOrderFlow = calculateVolumeOrderFlowMetrics(coinSeries)
  const derivatives = calculateDerivativesMetrics({
    ...coinSeries,
    rv24OverRv7: volatilityCompression.rv_24h_over_rv_7d,
  })
  const social = coinSeries.socialStatus === "available"
    ? calculateSocialMetrics(coinSeries)
    : null
  const relativeStrength = calculateRelativeStrengthMetrics({
    coinClose: coinSeries.close,
    btcClose: coinListContext.btcClose,
    total3esClose: coinListContext.total3esClose,
  })
  const categoryContext = coinListContext.categoryContextsByCoin.get(baseCurrencyId)

  if (!categoryContext) {
    throw new Error(`${baseCurrencyId} is missing from the coin list context`)
  }

  const breadthNarrative = calculateBreadthNarrativeMetrics({ categoryContext })
  const divergences = calculateDivergenceFlags({
    close: coinSeries.close,
    btcClose: coinListContext.btcClose,
    volatilityCompression,
    movementLifecycle,
    volumeOrderFlow,
    derivatives,
    social,
    relativeStrength,
    breadthNarrative,
  })

  return {
    atr24hPct,
    categoryContext,
    peerContext: coinListContext.peerContextsByCoin?.get(baseCurrencyId) ?? null,
    featureSeries: {
      volatilityCompression,
      movementLifecycle,
      volumeOrderFlow,
      derivatives,
      social,
      relativeStrength,
      sustainedStrength: coinListContext.sustainedStrengthByCoin?.get(baseCurrencyId) ?? null,
      breadthNarrative,
      divergences,
    },
  }
}
