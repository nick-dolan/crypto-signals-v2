import { indexCoinPeers } from "../../helpers/coin-peers-helper.js"
import { isArray, isFinite } from "../../helpers/utils.typed.js"
import { averageTrueRange } from "../../scripts/atr.js"
import { rollingSum } from "../../scripts/rolling-statistics.js"
import { relativeToSeasonalMedian } from "../../scripts/seasonality.js"

function positiveOrNull (value) {
  return isFinite(value) && value > 0 ? value : null
}

function finiteRatio (numerator, denominator) {
  if (!isFinite(numerator) || !isFinite(denominator) || denominator <= 0) {
    return null
  }
  const ratio = numerator / denominator
  return isFinite(ratio) ? ratio : null
}

function prepareCoin (baseCoin) {
  const periods = baseCoin.hourlyData?.chart?.periods
  const close = baseCoin.close.map(positiveOrNull)
  const high = close.map((_, index) => positiveOrNull(periods?.[index]?.max))
  const low = close.map((_, index) => positiveOrNull(periods?.[index]?.min))
  const volumeUsd = close.map((price, index) => {
    const volume = periods?.[index]?.volume
    return isFinite(price) && isFinite(volume) && volume >= 0 && isFinite(price * volume)
      ? price * volume
      : null
  })
  const atr = averageTrueRange(high, low, close, 24)
  const returns4h = close.map((price, index) => (
    index >= 4 && close.slice(index - 4, index + 1).every(isFinite)
      ? finiteRatio(price - close[index - 4], close[index - 4])
      : null
  ))
  const move4hAtr = close.map((price, index) => (
    isFinite(returns4h[index])
      ? finiteRatio(price - close[index - 4], atr[index - 4])
      : null
  ))

  return {
    coin: baseCoin.coin,
    close,
    atr,
    returns4h,
    move4hAtr,
    relativeVolume4h: relativeToSeasonalMedian(rollingSum(volumeUsd, 4), 24, 30),
  }
}

function emptyContext (status, generatedAt, coin) {
  return {
    status,
    registryGeneratedAt: generatedAt,
    peerCount: null,
    availablePeerCount: null,
    benchmarkCoinCount: null,
    freshLeaderCount: null,
    fadingLeaderCount: null,
    coinReturn4h: coin.returns4h.at(-1),
    coinMove4hAtr: coin.move4hAtr.at(-1),
    leaders: null,
  }
}

function benchmarkReturns (sortedReturns, excludedIds, count) {
  return sortedReturns.map((row) => {
    const values = row.filter(({ id }) => !excludedIds.has(id))
    if (count < 3 || values.length !== count) {
      return null
    }
    const middle = Math.floor(count / 2)
    return count % 2 === 0
      ? values[middle - 1].value / 2 + values[middle].value / 2
      : values[middle].value
  })
}

function triggerMetrics (peer, benchmark, index) {
  const return4h = peer.returns4h[index]
  const marketReturn = benchmark[index]
  const marketExcess4hAtr = isFinite(return4h) && isFinite(marketReturn)
    ? finiteRatio(
        (return4h - marketReturn) * peer.close[index - 4],
        peer.atr[index - 4],
      )
    : null
  const metrics = {
    return4h,
    move4hAtr: peer.move4hAtr[index],
    marketExcess4hAtr,
    relativeVolume4h: peer.relativeVolume4h[index],
  }

  return Object.values(metrics).every(isFinite) ? metrics : null
}

function reaction (coin, start, end) {
  if (!coin.close.slice(start, end + 1).every(isFinite)) {
    return { change: null, moveAtr: null }
  }
  const change = finiteRatio(coin.close[end] - coin.close[start], coin.close[start])
  return {
    change,
    moveAtr: finiteRatio(coin.close[end] - coin.close[start], coin.atr[start]),
  }
}

function evaluatePeer (peer, candidate, benchmark, relation, times) {
  let event = null
  let quietHours = 0
  let observedHours = 0

  for (let index = 0; index < times.length; index += 1) {
    const metrics = triggerMetrics(peer, benchmark, index)
    if (!metrics) {
      event = null
      quietHours = 0
      observedHours = 0
      continue
    }
    observedHours += 1
    const triggered = metrics.move4hAtr >= 2.5
      && metrics.marketExcess4hAtr >= 1
      && metrics.relativeVolume4h >= 1.5

    // Four non-triggering closes separate episodes; a new high alone never resets age.
    if (triggered && quietHours >= 4) {
      event = {
        index,
        start: index - 4,
        peak: Math.max(...peer.close.slice(index - 4, index + 1)),
        invalidated: false,
        metrics,
      }
    }
    if (event) {
      event.peak = Math.max(event.peak, peer.close[index])
      const retained = (peer.close[index] - peer.close[event.start])
        / (event.peak - peer.close[event.start])
      if (retained < 0.5) {
        event.invalidated = true
      }
    }
    quietHours = triggered ? 0 : quietHours + 1
  }

  // Observe the entire live horizon and its four-hour rearm period, not a left-censored event.
  if (observedHours < 17) {
    return { available: false, leader: null }
  }
  const latest = times.length - 1
  if (!event || event.invalidated || latest - event.index > 12) {
    return { available: true, leader: null }
  }

  const ageHours = latest - event.index
  const coinReaction = reaction(candidate, event.start, latest)
  return {
    available: true,
    leader: {
      baseCurrencyId: peer.coin.baseCurrencyId,
      symbol: peer.coin.symbol,
      type: relation.type,
      basis: relation.basis,
      caveat: relation.caveat,
      // TradingView labels candles by opening time; close-based evidence is available one hour later.
      detectedAt: new Date((times[event.index] + 3_600) * 1_000).toISOString(),
      windowStartedAt: new Date((times[event.start] + 3_600) * 1_000).toISOString(),
      ageHours,
      status: ageHours <= 4 ? "fresh" : "fading",
      ...event.metrics,
      retainedFraction: (peer.close[latest] - peer.close[event.start])
        / (event.peak - peer.close[event.start]),
      returnSinceStart: reaction(peer, event.start, latest).change,
      coinReturnSinceStart: coinReaction.change,
      coinMoveSinceStartAtr: coinReaction.moveAtr,
    },
  }
}

export function buildPeerContext (baseCoins, registry = null) {
  if (!isArray(baseCoins) || baseCoins.length === 0) {
    return new Map()
  }
  const times = baseCoins[0].times
  const coins = baseCoins.map(prepareCoin)
  const byId = new Map(coins.map(coin => [coin.coin.baseCurrencyId, coin]))
  const indexed = registry === null ? null : indexCoinPeers(registry)
  if (!indexed) {
    return new Map(coins.map(coin => [
      coin.coin.baseCurrencyId,
      emptyContext("unavailable", null, coin),
    ]))
  }

  // Sort once per hour; each candidate excludes itself and all its direct neighbors.
  const sortedReturns = times.map((_, index) => coins.flatMap(coin => (
    isFinite(coin.returns4h[index])
      ? [{ id: coin.coin.baseCurrencyId, value: coin.returns4h[index] }]
      : []
  )).sort((first, second) => first.value - second.value))

  return new Map(coins.map((coin) => {
    const id = coin.coin.baseCurrencyId
    const reviewed = indexed.coins.get(id)
    const context = emptyContext("not_covered", indexed.generatedAt, coin)
    if (!reviewed || reviewed.reviewStatus !== "reviewed") {
      context.status = reviewed ? "unreviewed" : "not_covered"
      return [id, context]
    }

    const neighbors = indexed.neighbors.get(id)
    const excluded = new Set([id, ...neighbors.keys()])
    context.peerCount = neighbors.size
    context.availablePeerCount = 0
    context.benchmarkCoinCount = coins.filter(peer => !excluded.has(peer.coin.baseCurrencyId)).length
    if (neighbors.size === 0) {
      return [id, {
        ...context,
        status: "no_peers",
        freshLeaderCount: 0,
        fadingLeaderCount: 0,
        leaders: [],
      }]
    }

    const benchmark = benchmarkReturns(sortedReturns, excluded, context.benchmarkCoinCount)
    const evaluated = [...neighbors].flatMap(([peerId, relation]) => (
      byId.has(peerId)
        ? [evaluatePeer(byId.get(peerId), coin, benchmark, relation, times)]
        : []
    ))
    context.availablePeerCount = evaluated.filter(peer => peer.available).length
    if (context.availablePeerCount === 0) {
      context.status = "insufficient_data"
      return [id, context]
    }

    const leaders = evaluated.flatMap(peer => peer.leader ? [peer.leader] : [])
      .sort((first, second) => first.ageHours - second.ageHours
        || second.marketExcess4hAtr - first.marketExcess4hAtr
        || first.baseCurrencyId.localeCompare(second.baseCurrencyId))
    return [id, {
      ...context,
      status: context.availablePeerCount === context.peerCount ? "available" : "partial",
      freshLeaderCount: leaders.filter(leader => leader.status === "fresh").length,
      fadingLeaderCount: leaders.filter(leader => leader.status === "fading").length,
      leaders,
    }]
  }))
}
