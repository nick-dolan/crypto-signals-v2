import { combineSeries, difference, mapSeries, ratioSeries } from "../../../scripts/series.js"
import { rollingPercentileRank, rollingSum, rollingZScore } from "../../../scripts/rolling-statistics.js"
import { simpleReturns } from "../../../scripts/returns.js"

export function calculateDerivativesMetrics ({
  close,
  openInterest,
  fundingRate,
  premium,
  longLiquidations,
  shortLiquidations,
  longShortRatioAccounts,
  topTradersLong,
  topTradersShort,
  rv24OverRv7,
}) {
  const oiChange1h = simpleReturns(openInterest, 1)
  const oiChange4h = simpleReturns(openInterest, 4)
  const oiChange12h = simpleReturns(openInterest, 12)
  const oiChange4hZ30d = rollingZScore(oiChange4h, 720)
  const longLiquidations4h = mapSeries(rollingSum(
    mapSeries(longLiquidations, value => Math.abs(value)),
    4,
  ), value => Math.max(0, value))
  const shortLiquidations4h = mapSeries(rollingSum(
    mapSeries(shortLiquidations, value => Math.abs(value)),
    4,
  ), value => Math.max(0, value))
  const liquidationTotal4h = combineSeries(
    [longLiquidations4h, shortLiquidations4h],
    ([longTotal, shortTotal]) => longTotal + shortTotal,
  )

  return {
    oi_change_1h: oiChange1h,
    oi_change_4h: oiChange4h,
    oi_change_12h: oiChange12h,
    oi_acceleration_4h: difference(oiChange4h, 4),
    oi_change_4h_z_30d: oiChange4hZ30d,
    oi_up_while_rv_down: combineSeries(
      [oiChange12h, rv24OverRv7],
      ([oiChange, rvRatio]) => oiChange > 0 && rvRatio < 1,
    ),
    funding_percentile_90d: rollingPercentileRank(fundingRate, 2_160),
    funding_minus_oi_z_4h: combineSeries(
      [rollingZScore(difference(fundingRate, 4), 720), oiChange4hZ30d],
      ([fundingChangeZScore, oiChangeZScore]) => (
        fundingChangeZScore - oiChangeZScore
      ),
    ),
    premium_z_30d: rollingZScore(ratioSeries(premium, close), 720),
    liquidations_4h_over_oi: ratioSeries(liquidationTotal4h, openInterest),
    liq_imbalance_4h: combineSeries(
      [longLiquidations4h, shortLiquidations4h],
      ([longTotal, shortTotal]) => (
        longTotal + shortTotal === 0
          ? 0
          : (longTotal - shortTotal) / (longTotal + shortTotal)
      ),
    ),
    crowd_vs_top_traders: combineSeries(
      [longShortRatioAccounts, topTradersLong, topTradersShort],
      ([accountRatio, topLong, topShort]) => {
        const crowdDenominator = accountRatio + 1
        const topDenominator = Math.abs(topLong) + Math.abs(topShort)

        if (crowdDenominator === 0 || topDenominator === 0) {
          return null
        }

        return (accountRatio - 1) / crowdDenominator
          - (Math.abs(topLong) - Math.abs(topShort)) / topDenominator
      },
    ),
  }
}
