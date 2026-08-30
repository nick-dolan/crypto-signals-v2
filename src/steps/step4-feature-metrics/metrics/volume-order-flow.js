import { combineSeries, mapSeries, ratioSeries } from "../../../scripts/series.js"
import { rollingSum, rollingZScore } from "../../../scripts/rolling-statistics.js"
import { simpleReturns } from "../../../scripts/returns.js"
import { relativeToSeasonalMedian } from "../../../scripts/seasonality.js"

export function calculateVolumeOrderFlowMetrics ({ close, volume, volumeDelta }) {
  const volumeUsd = combineSeries(
    [volume, close],
    ([volumeValue, closeValue]) => volumeValue * closeValue,
  )
  const volumeAcceleration3h = simpleReturns(rollingSum(volumeUsd, 3), 3)
  const volumeDeltaShare12h = ratioSeries(
    rollingSum(volumeDelta, 12),
    rollingSum(volume, 12),
  )
  const cvdDivergence12h = combineSeries(
    [
      rollingZScore(volumeDeltaShare12h, 720),
      rollingZScore(simpleReturns(close, 12), 720),
    ],
    ([volumeDeltaZScore, priceReturnZScore]) => (
      volumeDeltaZScore - priceReturnZScore
    ),
  )

  return {
    volume_z_30d: rollingZScore(
      mapSeries(volumeUsd, value => Math.log1p(value)),
      720,
    ),
    volume_acceleration_3h: volumeAcceleration3h,
    rel_volume_at_time: relativeToSeasonalMedian(volumeUsd, 24, 30),
    vd_net_4h_over_volume: ratioSeries(
      rollingSum(volumeDelta, 4),
      rollingSum(volume, 4),
    ),
    cvd_divergence_12h: cvdDivergence12h,
  }
}
