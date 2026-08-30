import { calculateBreadthNarrativeMetrics } from "./metrics/breadth-narrative.js"
import { calculateDerivativesMetrics } from "./metrics/derivatives.js"
import { calculateDivergenceFlags } from "./metrics/divergence-flags.js"
import { calculateRelativeStrengthMetrics } from "./metrics/relative-strength.js"
import { calculateSocialMetrics } from "./metrics/social.js"
import {
  calculateAtr24hPct,
  calculateVolatilityCompressionMetrics,
} from "./metrics/volatility-compression.js"
import { calculateVolumeOrderFlowMetrics } from "./metrics/volume-order-flow.js"

export function calculateCoinMetrics (
  coinSeries,
  universeContext,
  baseCurrencyId,
) {
  const atr24hPct = calculateAtr24hPct(coinSeries)
  const volatilityCompression = calculateVolatilityCompressionMetrics({
    ...coinSeries,
    atr24hPct,
  })
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

  const breadthNarrative = calculateBreadthNarrativeMetrics({ categoryContext })
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
    atr24hPct,
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
