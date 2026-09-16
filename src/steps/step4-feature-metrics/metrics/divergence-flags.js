import { isArray, isFinite } from "../../../helpers/utils.typed.js"
import { rollingZScore } from "../../../scripts/rolling-statistics.js"
import { simpleReturns } from "../../../scripts/returns.js"

function calculateFlag (length, required, condition) {
  return Array.from({ length }, (_, index) => {
    const values = required.map(series => series?.[index])
    return values.every(isFinite) ? condition(...values) : null
  })
}

export function calculateDivergenceFlags ({
  close,
  btcClose,
  volatilityCompression = {},
  movementLifecycle = {},
  volumeOrderFlow = {},
  derivatives = {},
  social = {},
  relativeStrength = {},
  breadthNarrative = {},
}) {
  const length = close.length
  const nulls = () => Array(length).fill(null)
  const return4hZ = rollingZScore(simpleReturns(close, 4), 720)
  const btcReturn4hZ = isArray(btcClose)
    ? rollingZScore(simpleReturns(btcClose, 4), 720)
    : nulls()

  const categoryMomentum = breadthNarrative.category_momentum_4h
  const categoryMomentumZ = isArray(categoryMomentum)
    ? rollingZScore(categoryMomentum, 720)
    : nulls()

  return {
    coiling: calculateFlag(length, [
      volatilityCompression.squeeze_age_hours,
      derivatives.oi_change_4h,
      volumeOrderFlow.volume_acceleration_3h,
    ], (squeezeAge, oiChange, volumeAcceleration) => (
      squeezeAge >= 4 && oiChange > 0 && volumeAcceleration > 0
    )),
    attention_ahead: calculateFlag(
      length,
      [social?.social_minus_price_z_3h],
      socialMinusPriceZ => socialMinusPriceZ > 1,
    ),
    unconfirmed_move: calculateFlag(length, [
      return4hZ,
      volumeOrderFlow.volume_z_30d,
      derivatives.oi_change_4h_z_30d,
    ], (returnZ, volumeZ, oiChangeZ) => (
      Math.abs(returnZ) > 1.5
      && volumeZ < 0.5
      && Math.abs(oiChangeZ) < 0.5
    )),
    exhausted_hype: calculateFlag(length, [
      social?.social_dominance_z_30d,
      social?.interactions_z_30d,
      social?.interactions_acceleration_3h,
      return4hZ,
    ], (socialDominanceZ, interactionsZ, interactionsAcceleration, returnZ) => (
      Math.max(socialDominanceZ, interactionsZ) > 1.5
      && interactionsAcceleration < 0
      && Math.abs(returnZ) < 0.5
    )),
    laggard: calculateFlag(length, [
      categoryMomentumZ,
      categoryMomentum,
      breadthNarrative.category_breadth,
      breadthNarrative.coin_leads_category,
    ], (momentumZ, momentum, breadth, coinLead) => (
      Math.abs(momentumZ) > 1
      && breadth >= 0.6
      && Math.sign(momentum) * coinLead < 0
    )),
    resilient: calculateFlag(length, [
      btcReturn4hZ,
      relativeStrength.residual_z_30d,
    ], (btcReturnZ, residualZ) => btcReturnZ < -1 && residualZ > 0.5),
    squeeze_fuel: calculateFlag(length, [
      derivatives.funding_rate,
      derivatives.funding_percentile_90d,
      derivatives.oi_level_percentile_90d,
      derivatives.crowd_vs_top_traders,
    ], (fundingRate, fundingPercentile, oiLevelPercentile, crowdPositioning) => (
      oiLevelPercentile >= 0.8
      && (
        (fundingRate < 0 && fundingPercentile <= 0.05 && crowdPositioning < -0.15)
        || (fundingRate > 0 && fundingPercentile >= 0.95 && crowdPositioning > 0.15)
      )
    )),
    range_pressure_up: calculateFlag(length, [
      movementLifecycle.distance_to_previous_high_atr,
      volumeOrderFlow.rel_volume_at_time,
      volumeOrderFlow.vd_net_4h_over_volume,
    ], (distance, relativeVolume, delta) => (
      distance >= 0 && distance <= 0.5 && relativeVolume >= 1.5 && delta >= 0.1
    )),
    range_pressure_down: calculateFlag(length, [
      movementLifecycle.distance_to_previous_low_atr,
      volumeOrderFlow.rel_volume_at_time,
      volumeOrderFlow.vd_net_4h_over_volume,
    ], (distance, relativeVolume, delta) => (
      distance >= 0 && distance <= 0.5 && relativeVolume >= 1.5 && delta <= -0.1
    )),
    short_squeeze_setup: calculateFlag(length, [
      derivatives.funding_rate,
      derivatives.funding_percentile_90d,
      derivatives.oi_level_percentile_90d,
      derivatives.oi_change_4h,
      volumeOrderFlow.vd_net_4h_over_volume,
    ], (fundingRate, fundingPercentile, oiLevelPercentile, oiChange, delta) => (
      fundingRate < 0
      && fundingPercentile <= 0.05
      && oiLevelPercentile >= 0.8
      && oiChange > 0
      && delta >= 0.1
    )),
    long_squeeze_setup: calculateFlag(length, [
      derivatives.funding_rate,
      derivatives.funding_percentile_90d,
      derivatives.oi_level_percentile_90d,
      derivatives.oi_change_4h,
      volumeOrderFlow.vd_net_4h_over_volume,
    ], (fundingRate, fundingPercentile, oiLevelPercentile, oiChange, delta) => (
      fundingRate > 0
      && fundingPercentile >= 0.95
      && oiLevelPercentile >= 0.8
      && oiChange > 0
      && delta <= -0.1
    )),
  }
}
