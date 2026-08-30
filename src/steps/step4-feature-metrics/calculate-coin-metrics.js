import { calculateBreadthNarrativeMetrics } from "./metrics/breadth-narrative.js"
import { calculateDerivativesMetrics } from "./metrics/derivatives.js"
import { calculateDivergenceFlags } from "./metrics/divergence-flags.js"
import { calculateRelativeStrengthMetrics } from "./metrics/relative-strength.js"
import { calculateSocialMetrics } from "./metrics/social.js"
import { calculateVolatilityCompressionMetrics } from "./metrics/volatility-compression.js"
import { calculateVolumeOrderFlowMetrics } from "./metrics/volume-order-flow.js"

export function calculateCoinMetrics (
  coinSeries,
  universeContext,
  baseCurrencyId,
) {
  const volatilityCompression = calculateVolatilityCompressionMetrics(coinSeries)
  const volumeOrderFlow = calculateVolumeOrderFlowMetrics(coinSeries)
  const derivatives = calculateDerivativesMetrics({
    ...coinSeries,
    rv24OverRv7: volatilityCompression.rv_24h_over_rv_7d,
  })
  const social = calculateSocialMetrics(coinSeries)
  const relativeStrength = calculateRelativeStrengthMetrics({
    coinClose: coinSeries.close,
    btcClose: universeContext.btcClose,
    total3esClose: universeContext.total3esClose,
  })
  const categoryContext = universeContext.categoryContextsByCoin.get(baseCurrencyId)

  if (!categoryContext) {
    throw new Error(`${baseCurrencyId} is missing from the universe context`)
  }

  const breadthNarrative = calculateBreadthNarrativeMetrics({
    universeBreadth4h: universeContext.universeBreadth4h,
    segmentRotation4h: universeContext.segmentRotation4h,
    stableCap: universeContext.stableCap,
    categoryContext,
  })
  const divergences = calculateDivergenceFlags({
    close: coinSeries.close,
    btcClose: universeContext.btcClose,
    openInterest: coinSeries.openInterest,
    volatilityCompression,
    volumeOrderFlow,
    derivatives,
    social,
    relativeStrength,
    breadthNarrative,
  })

  return {
    categoryContext,
    featureSeries: {
      volatilityCompression,
      volumeOrderFlow,
      derivatives,
      social,
      relativeStrength,
      breadthNarrative,
      divergences,
    },
  }
}
