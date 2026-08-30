import { combineSeries, consecutiveCount, ratioSeries } from "../../../scripts/series.js"
import { rollingMedian, rollingPercentileRank } from "../../../scripts/rolling-statistics.js"
import { averageTrueRange } from "../../../scripts/atr.js"
import { bollingerBandwidth } from "../../../scripts/bollinger-bandwidth.js"
import { realizedVolatility } from "../../../scripts/realized-volatility.js"

export function calculateAtr24hPct ({ high, low, close }) {
  return ratioSeries(averageTrueRange(high, low, close, 24), close)
}

export function calculateVolatilityCompressionMetrics ({
  high,
  low,
  close,
  atr24hPct = calculateAtr24hPct({ high, low, close }),
}) {
  const rv24OverRv7 = ratioSeries(
    realizedVolatility(close, 24),
    realizedVolatility(close, 168),
  )
  const bbBandwidthPct30d = rollingPercentileRank(
    bollingerBandwidth(close, 20, 2),
    720,
  )
  const atrPct90d = rollingPercentileRank(atr24hPct, 2_160)
  const normalizedHourlyRange = combineSeries(
    [high, low, close],
    ([highValue, lowValue, closeValue]) => (
      (highValue - lowValue) / closeValue
    ),
  )
  const rangeCompressionStreak = consecutiveCount(
    combineSeries(
      [normalizedHourlyRange, rollingMedian(normalizedHourlyRange, 720)],
      ([range, median]) => range <= median,
    ),
    compressed => compressed,
  )
  const squeezeAgeHours = consecutiveCount(
    combineSeries(
      [rv24OverRv7, bbBandwidthPct30d, atrPct90d],
      ([rvRatio, bbPercentile, atrPercentile]) => (
        rvRatio < 0.75 && bbPercentile <= 0.2 && atrPercentile <= 0.2
      ),
    ),
    squeezed => squeezed,
  )

  return {
    rv_24h_over_rv_7d: rv24OverRv7,
    bb_bandwidth_pct_30d: bbBandwidthPct30d,
    atr_pct_90d: atrPct90d,
    range_compression_streak: rangeCompressionStreak,
    squeeze_age_hours: squeezeAgeHours,
  }
}
