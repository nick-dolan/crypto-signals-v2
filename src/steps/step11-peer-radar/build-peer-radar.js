import { isArray, isFinite } from "../../helpers/utils.typed.js"
import { buildBaseSeries } from "../step4-feature-metrics/build-base-series.js"
import { buildPeerContext } from "../step4-feature-metrics/build-peer-context.js"

function laggingReaction (leader) {
  if (
    ![leader.return4h, leader.returnSinceStart, leader.coinReturnSinceStart, leader.coinMoveSinceStartAtr].every(isFinite)
    || leader.return4h <= 0
  ) {
    return null
  }

  // Recover the leader's current move in its original ATR, not its frozen trigger move.
  const moveSinceStartAtr = leader.move4hAtr * (leader.returnSinceStart / leader.return4h)
  const responseRatio = leader.coinMoveSinceStartAtr / moveSinceStartAtr
  const gapAtr = moveSinceStartAtr - leader.coinMoveSinceStartAtr
  if (
    ![moveSinceStartAtr, responseRatio, gapAtr].every(isFinite)
    || moveSinceStartAtr <= 0 || responseRatio > 0.5 || gapAtr < 1
  ) {
    return null
  }

  return {
    baseCurrencyId: leader.baseCurrencyId,
    symbol: leader.symbol,
    type: leader.type,
    basis: leader.basis,
    caveat: leader.caveat,
    detectedAt: leader.detectedAt,
    windowStartedAt: leader.windowStartedAt,
    ageHours: leader.ageHours,
    status: leader.status,
    return4hPct: leader.return4h * 100,
    move4hAtr: leader.move4hAtr,
    marketExcess4hAtr: leader.marketExcess4hAtr,
    relativeVolume4h: leader.relativeVolume4h,
    retainedPct: leader.retainedFraction * 100,
    returnSinceStartPct: leader.returnSinceStart * 100,
    moveSinceStartAtr,
    coinReturnSinceStartPct: leader.coinReturnSinceStart * 100,
    coinMoveSinceStartAtr: leader.coinMoveSinceStartAtr,
    responseRatio,
    gapAtr,
    coinReaction: Math.abs(leader.coinMoveSinceStartAtr) <= 0.5
      ? "flat"
      : leader.coinMoveSinceStartAtr > 0 ? "rising" : "falling",
  }
}

export function buildPeerRadar ({ sourceUniverse, coinData, coinPeers = null }) {
  if (!isArray(sourceUniverse?.coins) || !isArray(coinData) || !coinData.length) {
    throw new Error("Peer radar requires the universe and non-empty hourly coin data from steps 1–2")
  }

  const baseCoins = buildBaseSeries({ sourceUniverse, coinData })
  const times = baseCoins[0].times
  if (
    new Set(baseCoins.map(({ coin }) => coin.baseCurrencyId)).size !== baseCoins.length
      || !baseCoins.every(coin => coin.times.length === times.length
        && coin.times.every((time, index) => time === times[index]))
  ) {
    throw new Error("Peer radar requires unique coin IDs on one identical hourly grid")
  }

  const contexts = buildPeerContext(baseCoins, coinPeers)
  const candidates = baseCoins.flatMap(({ coin }) => {
    const context = contexts.get(coin.baseCurrencyId)
    const leaders = (context.leaders ?? []).map(laggingReaction).filter(Boolean)
    if (!leaders.length) {
      return []
    }

    return [{
      coin: {
        baseCurrencyId: coin.baseCurrencyId,
        symbol: coin.symbol,
        name: coin.name,
        tradingViewSymbol: coin.tradingViewSymbol,
        marketSymbol: coin.marketSymbol,
      },
      peerStatus: context.status,
      peerCount: context.peerCount,
      availablePeerCount: context.availablePeerCount,
      benchmarkCoinCount: context.benchmarkCoinCount,
      leaders,
    }]
  }).sort((first, second) => first.coin.baseCurrencyId.localeCompare(second.coin.baseCurrencyId))

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    asOf: new Date(times.at(-1) * 1_000).toISOString(),
    snapshotClosedAt: new Date((times.at(-1) + 3_600) * 1_000).toISOString(),
    timeframe: "1h",
    registryGeneratedAt: coinPeers?.generatedAt ?? null,
    universeCoinCount: sourceUniverse.coins.length,
    loadedCoinCount: baseCoins.length,
    coverage: Object.fromEntries([
      "available", "partial", "no_peers", "insufficient_data", "not_covered", "unreviewed", "unavailable",
    ].map(status => [status, [...contexts.values()].filter(context => context.status === status).length])),
    criteria: {
      impulse: "Прямой сосед: исходный рост за 4ч >= 2.5 ATR, excess над медианой рынка без кандидата и его соседей >= 1 ATR, сезонный USD-объём >= 1.5 нормы. ATR заморожен до окна. Эпизод живёт до 12ч при удержании >= 50% пикового close; fresh до 4ч, затем fading. Новые максимумы не обновляют возраст.",
      lag: "На одном интервале от windowStartedAt до snapshotClosedAt реакция кандидата <= 0.5 реакции лидера, разница >= 1 ATR. Каждая монета нормирована на собственный ATR до окна; сравниваются текущие реакции, а не frozen trigger лидера. Это стартовая эвристика, не вероятность и не ранний вход.",
      reaction: "flat: модуль реакции кандидата <= 0.5 собственного ATR; rising: > 0.5 ATR; falling: < -0.5 ATR. Сравнение не ограничивает абсолютный рост кандидата: rising не означает, что он ещё не начал движение. Пропуск реакции не заменяется нулём.",
    },
    candidateCount: candidates.length,
    candidates,
  }
}
