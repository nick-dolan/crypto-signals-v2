import { isFinite } from "../../../helpers/utils.typed.js"
import { rollingBeta, rollingCorrelation, rollingZScore } from "../../../scripts/rolling-statistics.js"
import { logReturns, simpleReturns } from "../../../scripts/returns.js"

function combine (left, right, calculate) {
  return left.map((value, index) => (
    isFinite(value) && isFinite(right[index])
      ? calculate(value, right[index])
      : null
  ))
}

export function calculateRelativeStrengthMetrics ({
  coinClose,
  btcClose,
  total3esClose,
}) {
  const coinLogReturns1h = logReturns(coinClose)
  const btcLogReturns1h = logReturns(btcClose)
  const betaBtc7d = rollingBeta(coinLogReturns1h, btcLogReturns1h, 168)
  const correlation24h = rollingCorrelation(
    coinLogReturns1h,
    btcLogReturns1h,
    24,
  )
  const correlation7d = rollingCorrelation(
    coinLogReturns1h,
    btcLogReturns1h,
    168,
  )
  const residualLogReturn4h = combine(
    logReturns(coinClose, 4),
    combine(betaBtc7d, logReturns(btcClose, 4), (beta, value) => beta * value),
    (coinReturn, expectedReturn) => coinReturn - expectedReturn,
  )

  return {
    beta_btc_7d: betaBtc7d,
    corr_btc_24h: correlation24h,
    corr_btc_change_24h_vs_7d: combine(
      correlation24h,
      correlation7d,
      (short, long) => short - long,
    ),
    residual_log_return_4h: residualLogReturn4h,
    residual_z_30d: rollingZScore(residualLogReturn4h, 720),
    rs_vs_total3es_12h: combine(
      simpleReturns(coinClose, 12),
      simpleReturns(total3esClose, 12),
      (coinReturn, marketReturn) => coinReturn - marketReturn,
    ),
  }
}
