import { isFinite } from "../../../helpers/utils.typed.js"

function priceReturnAt (close) {
  const invalid = [0]

  for (const value of close) {
    invalid.push(invalid.at(-1) + Number(!isFinite(value) || value <= 0))
  }

  return (end, hours) => {
    const start = end - hours

    if (start < 0 || invalid[end + 1] !== invalid[start]) {
      return null
    }

    const change = close[end] / close[start] - 1
    return isFinite(change) ? change : null
  }
}

function peerRank (returns, index) {
  const peers = returns.filter((_, peerIndex) => peerIndex !== index)
  return peers.reduce((sum, peer) => (
    sum + (Math.abs(returns[index] - peer) <= 1e-12 ? 0.5 : Number(returns[index] > peer))
  ), 0) / peers.length
}

function compareToPeers (returns, marketReturn, includeRank = false) {
  const comparisons = Array(returns.length).fill(null)

  if (returns.length < 4 || !returns.every(isFinite)) {
    return comparisons
  }

  const sorted = returns.map((value, index) => ({ value, index }))
    .sort((left, right) => left.value - right.value)
  const peerCount = returns.length - 1
  const rising = returns.filter(value => value > 1e-12).length
  const falling = returns.filter(value => value < -1e-12).length

  for (const [position, { value, index }] of sorted.entries()) {
    // Exclude the coin without sorting the same cross-section again for each peer set.
    const peerAt = offset => sorted[offset + Number(offset >= position)].value
    const peerMedian = peerAt(Math.floor((peerCount - 1) / 2)) / 2
      + peerAt(Math.floor(peerCount / 2)) / 2
    const down = isFinite(marketReturn) && marketReturn < -1e-12
      && (falling - Number(value < -1e-12)) / peerCount > 0.55
    const up = isFinite(marketReturn) && marketReturn > 1e-12
      && (rising - Number(value > 1e-12)) / peerCount > 0.55

    comparisons[index] = {
      change: value,
      excess: value - peerMedian,
      regime: down ? "down" : up ? "up" : "mixed",
      rank: includeRank ? peerRank(returns, index) : null,
    }
  }

  return comparisons
}

function rate (samples, predicate) {
  return samples.length === 0 ? null : samples.filter(predicate).length / samples.length
}

function medianExcess (samples) {
  if (samples.length === 0) {
    return null
  }

  const sorted = samples.map(sample => sample.excess).sort((left, right) => left - right)
  return sorted[Math.floor((sorted.length - 1) / 2)] / 2
    + sorted[Math.floor(sorted.length / 2)] / 2
}

function strengthStatus (metrics) {
  if (metrics.history_score === null || metrics.current_score === null) {
    return "insufficient_data"
  }

  const historicallyStrong = metrics.history_score >= 65
    && metrics.down_win_rate >= 0.6
    && metrics.up_participation_rate >= 0.5
    && metrics.daily_win_rate >= 0.55
    && metrics.weekly_win_rate >= 0.55
  const currentlyStrong = metrics.current_score >= 65
    && [metrics.excess_4h, metrics.excess_12h, metrics.excess_24h]
      .every(value => value > 1e-12)

  if (currentlyStrong) {
    return historicallyStrong && metrics.excess_7d > 1e-12 ? "persistent" : "emerging"
  }

  return historicallyStrong ? "fading" : "neutral"
}

function summarizeStrength ({ historyHours, peerCount, fourHourly, daily, weekly, current }) {
  const down = fourHourly.filter(sample => sample.regime === "down")
  const up = fourHourly.filter(sample => sample.regime === "up")
  const downWinRate = rate(down, sample => sample.excess > 1e-12)
  const upParticipationRate = rate(up, sample => sample.change > 1e-12 && sample.excess >= -1e-12)
  const dailyWinRate = rate(daily, sample => sample.excess > 1e-12)
  const weeklyWinRate = rate(weekly, sample => sample.excess > 1e-12)
  const historyAvailable = daily.length >= 28 && weekly.length >= 4
    && down.length >= 12 && up.length >= 12
  const metrics = {
    history_score: historyAvailable
      ? 100 * (downWinRate + upParticipationRate + dailyWinRate + weeklyWinRate) / 4
      : null,
    current_score: current.every(sample => sample !== null)
      ? 100 * current.reduce((sum, sample) => sum + sample.rank, 0) / current.length
      : null,
    history_hours: historyHours,
    peer_count: peerCount,
    down_windows: down.length,
    down_win_rate: downWinRate,
    down_positive_rate: rate(down, sample => sample.change > 1e-12),
    down_excess_median: medianExcess(down),
    up_windows: up.length,
    up_participation_rate: upParticipationRate,
    up_excess_median: medianExcess(up),
    daily_windows: daily.length,
    daily_win_rate: dailyWinRate,
    weekly_windows: weekly.length,
    weekly_win_rate: weeklyWinRate,
    excess_4h: current[0]?.excess ?? null,
    excess_12h: current[1]?.excess ?? null,
    excess_24h: current[2]?.excess ?? null,
    excess_7d: current[3]?.excess ?? null,
  }

  return { status: strengthStatus(metrics), ...metrics }
}

export function buildSustainedStrength (baseCoins, total3esClose) {
  const last = baseCoins[0].close.length - 1
  const coinReturns = baseCoins.map(({ close }) => priceReturnAt(close))
  const marketReturn = priceReturnAt(total3esClose)
  const compareWindow = (end, hours, includeRank = false) => compareToPeers(
    coinReturns.map(returnAt => returnAt(end, hours)),
    marketReturn(end, hours),
    includeRank,
  )
  // Anchor full, disjoint windows to the snapshot; leave the oldest partial window out.
  const history = hours => Array.from({ length: Math.floor(last / hours) }, (_, index) => (
    compareWindow(last - index * hours, hours)
  ))
  const fourHourly = history(4)
  const daily = history(24)
  const weekly = history(168)
  const current = [4, 12, 24, 168].map(hours => compareWindow(last, hours, true))
  const samplesFor = (windows, index) => windows.map(window => window[index]).filter(sample => sample !== null)

  return new Map(baseCoins.map(({ coin }, index) => [
    coin.baseCurrencyId,
    summarizeStrength({
      historyHours: last,
      peerCount: baseCoins.length - 1,
      fourHourly: samplesFor(fourHourly, index),
      daily: samplesFor(daily, index),
      weekly: samplesFor(weekly, index),
      current: current.map(window => window[index]),
    }),
  ]))
}
