import { isFinite } from "../../../helpers/utils.typed.js"
import { rollingMaximum, rollingMinimum } from "../../../scripts/rolling-statistics.js"
import { combineSeries, lag } from "../../../scripts/series.js"

function positiveAtrDistance (current, previous, atr) {
  return atr > 0 ? Math.max(current - previous, 0) / atr : null
}

function createEndedBase (index, squeezeDuration, high, low, atr24h) {
  const start = index - Math.min(squeezeDuration, 48)
  const baseHighValues = high.slice(start, index)
  const baseLowValues = low.slice(start, index)
  const baseAtr = atr24h[index - 1]

  if (
    !baseHighValues.every(isFinite)
    || !baseLowValues.every(isFinite)
    || !isFinite(baseAtr)
    || baseAtr <= 0
  ) {
    return null
  }

  const highValue = Math.max(...baseHighValues)
  const lowValue = Math.min(...baseLowValues)

  return {
    endedAt: index,
    duration: squeezeDuration,
    high: highValue,
    low: lowValue,
    midpoint: (highValue + lowValue) / 2,
    atr: baseAtr,
  }
}

function calculateEventMetrics ({ high, low, close, atr24h, squeezeAge }) {
  const preBreakoutSqueezeAge = Array(close.length).fill(null)
  const squeezeEndedHoursAgo = Array(close.length).fill(null)
  const breakoutAgeHours = Array(close.length).fill(null)
  const postBreakoutExtensionAtr = Array(close.length).fill(null)
  const extensionFromBaseAtr = Array(close.length).fill(null)
  let base = null
  let breakout = null

  for (const index of close.keys()) {
    const currentSqueezeAge = squeezeAge[index]
    const previousSqueezeAge = squeezeAge[index - 1]

    if (currentSqueezeAge === 4) {
      base = null
      breakout = null
    }

    if (
      currentSqueezeAge === 0
      && isFinite(previousSqueezeAge)
      && previousSqueezeAge >= 4
    ) {
      base = createEndedBase(
        index,
        previousSqueezeAge,
        high,
        low,
        atr24h,
      )
      breakout = null
    }

    if (base && index - base.endedAt > 168) {
      base = null
      breakout = null
    }

    if (
      base
      && !breakout
      && index - base.endedAt <= 4
      && isFinite(close[index])
    ) {
      const direction = close[index] > base.high
        ? 1
        : close[index] < base.low ? -1 : 0

      if (direction !== 0) {
        breakout = {
          happenedAt: index,
          direction,
          boundary: direction > 0 ? base.high : base.low,
        }
      }
    }

    if (base && isFinite(close[index])) {
      squeezeEndedHoursAgo[index] = index - base.endedAt
      extensionFromBaseAtr[index] = (
        Math.abs(close[index] - base.midpoint) / base.atr
      )
    }

    if (base && breakout && isFinite(close[index])) {
      preBreakoutSqueezeAge[index] = base.duration
      breakoutAgeHours[index] = index - breakout.happenedAt
      postBreakoutExtensionAtr[index] = Math.max(
        breakout.direction * (close[index] - breakout.boundary),
        0,
      ) / base.atr
    }
  }

  return {
    preBreakoutSqueezeAge,
    squeezeEndedHoursAgo,
    breakoutAgeHours,
    postBreakoutExtensionAtr,
    extensionFromBaseAtr,
  }
}

export function calculateMovementLifecycleMetrics ({
  high,
  low,
  close,
  atr24hPct,
  squeezeAge,
}) {
  combineSeries([high, low, close, atr24hPct, squeezeAge], () => 0)

  const atr24h = combineSeries(
    [atr24hPct, close],
    ([atrPercent, price]) => atrPercent * price,
  )
  const priorRunupAtr72h = combineSeries(
    [lag(close, 4), lag(close, 76), lag(atr24h, 76)],
    ([end, start, atr]) => positiveAtrDistance(end, start, atr),
  )
  const runup24h = combineSeries(
    [close, lag(close, 24), lag(atr24h, 24)],
    ([end, start, atr]) => positiveAtrDistance(end, start, atr),
  )
  const max24hRunupLast7dAtr = rollingMaximum(lag(runup24h, 4), 168)
  const sevenDayLow = rollingMinimum(low, 168)
  const sevenDayHigh = rollingMaximum(high, 168)
  const rangePosition7d = combineSeries(
    [close, sevenDayLow, sevenDayHigh],
    ([price, minimum, maximum]) => maximum === minimum
      ? 0.5
      : Math.min(Math.max((price - minimum) / (maximum - minimum), 0), 1),
  )
  const eventMetrics = calculateEventMetrics({
    high,
    low,
    close,
    atr24h,
    squeezeAge,
  })
  const freshQuietBreakout = close.map((_, index) => (
    [
      eventMetrics.preBreakoutSqueezeAge[index],
      eventMetrics.breakoutAgeHours[index],
      eventMetrics.postBreakoutExtensionAtr[index],
    ].every(isFinite)
    && eventMetrics.preBreakoutSqueezeAge[index] >= 12
    && eventMetrics.breakoutAgeHours[index] <= 4
    && eventMetrics.postBreakoutExtensionAtr[index] > 0
    && eventMetrics.postBreakoutExtensionAtr[index] <= 1.5
  ))
  const latePump = close.map((_, index) => {
    const evidenceCount = [
      priorRunupAtr72h[index] >= 3,
      max24hRunupLast7dAtr[index] >= 3,
      rangePosition7d[index] >= 0.85,
      eventMetrics.extensionFromBaseAtr[index] >= 2.5,
      isFinite(eventMetrics.breakoutAgeHours[index])
      && eventMetrics.breakoutAgeHours[index] >= 12,
    ].filter(Boolean).length

    return !freshQuietBreakout[index]
      && (priorRunupAtr72h[index] >= 3 || max24hRunupLast7dAtr[index] >= 3)
      && rangePosition7d[index] >= 0.85
      && evidenceCount >= 3
  })

  return {
    prior_runup_atr_72h: priorRunupAtr72h,
    max_24h_runup_last_7d_atr: max24hRunupLast7dAtr,
    range_position_7d: rangePosition7d,
    pre_breakout_squeeze_age: eventMetrics.preBreakoutSqueezeAge,
    squeeze_ended_hours_ago: eventMetrics.squeezeEndedHoursAgo,
    breakout_age_hours: eventMetrics.breakoutAgeHours,
    post_breakout_extension_atr: eventMetrics.postBreakoutExtensionAtr,
    extension_from_base_atr: eventMetrics.extensionFromBaseAtr,
    fresh_quiet_breakout: freshQuietBreakout,
    late_pump: latePump,
  }
}
