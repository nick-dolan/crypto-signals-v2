import { simpleReturns } from "../../scripts/returns.js"

function median (values) {
  const finite = values.filter(Number.isFinite).sort((left, right) => left - right)

  if (finite.length === 0) {
    return null
  }

  const middle = Math.floor(finite.length / 2)
  return finite.length % 2 === 0
    ? (finite[middle - 1] + finite[middle]) / 2
    : finite[middle]
}

function isHourlyGrid (times) {
  return Array.isArray(times)
    && times.length > 0
    && times.every((time, index) => (
      Number.isFinite(time)
      && (index === 0 || time === times[index - 1] + 3_600)
    ))
}

function hasGrid (times, expected) {
  return Array.isArray(times)
    && times.length === expected.length
    && times.every((time, index) => time === expected[index])
}

function marketClose (marketContext, key, times) {
  const periods = marketContext?.series?.[key]?.periods

  if (!Array.isArray(periods) || !hasGrid(periods.map(period => period?.time), times)) {
    throw new Error(`Market context ${key} must use the universe hourly grid`)
  }

  return periods.map(period => period.close)
}

function subtractSeries (left, right) {
  return left.map((value, index) => (
    Number.isFinite(value) && Number.isFinite(right[index])
      ? value - right[index]
      : null
  ))
}

function categoryNames (baseCoin) {
  return [...new Set(Array.isArray(baseCoin.categories) ? baseCoin.categories : [])]
}

function emptyCategoryContext (length, status) {
  return {
    applicable: false,
    status,
    category: null,
    momentum4h: Array(length).fill(null),
    breadth: Array(length).fill(null),
    coinLeadsCategory: Array(length).fill(null),
  }
}

function buildCategoryContext (baseCoins, returns4h, coinIndex, length) {
  const categories = categoryNames(baseCoins[coinIndex])
  const eligible = categories
    .map(category => ({
      category,
      peerIndices: baseCoins.flatMap((baseCoin, index) => (
        index !== coinIndex && categoryNames(baseCoin).includes(category)
          ? [index]
          : []
      )),
    }))
    .filter(({ peerIndices }) => peerIndices.length >= 3)
    .map(context => ({
      ...context,
      latestMomentum: median(
        context.peerIndices.map(index => returns4h[index][length - 1]),
      ),
    }))
    .filter(({ latestMomentum }) => Number.isFinite(latestMomentum))
    .sort((left, right) => (
      Math.abs(right.latestMomentum) - Math.abs(left.latestMomentum)
      || left.category.localeCompare(right.category)
    ))

  if (eligible.length === 0) {
    return emptyCategoryContext(
      length,
      categories.length === 0 ? "not_applicable" : "insufficient_peers",
    )
  }

  const { category, peerIndices } = eligible[0]
  const momentum4h = Array.from({ length }, (_, index) => median(
    peerIndices.map(peerIndex => returns4h[peerIndex][index]),
  ))
  const breadth = momentum4h.map((momentum, index) => {
    const peerMoves = peerIndices.map(peerIndex => ({
      current: returns4h[peerIndex][index],
      previous: returns4h[peerIndex][index - 4],
    }))

    if (
      !Number.isFinite(momentum)
      || !peerMoves.every(({ current, previous }) => (
        Number.isFinite(current) && Number.isFinite(previous)
      ))
    ) {
      return null
    }

    if (momentum === 0) {
      return 0
    }

    return peerMoves.filter(({ current, previous }) => (
      Math.sign(current) === Math.sign(momentum)
      && Math.abs(current) > Math.abs(previous)
    )).length / peerMoves.length
  })
  const coinLeadsCategory = momentum4h.map((momentum, index) => (
    Number.isFinite(momentum) && Number.isFinite(returns4h[coinIndex][index])
      ? returns4h[coinIndex][index] - momentum
      : null
  ))

  return {
    applicable: true,
    status: "available",
    category,
    momentum4h,
    breadth,
    coinLeadsCategory,
  }
}

export function buildUniverseContext (baseCoins, marketContext) {
  if (!Array.isArray(baseCoins) || baseCoins.length === 0) {
    throw new Error("baseCoins must be a nonempty array")
  }

  const times = baseCoins[0]?.times

  if (
    !isHourlyGrid(times)
    || !baseCoins.every(baseCoin => (
      hasGrid(baseCoin?.times, times)
      && Array.isArray(baseCoin?.close)
      && baseCoin.close.length === times.length
    ))
  ) {
    throw new Error("All base coins must use one identical hourly time grid")
  }

  const btc = baseCoins.find(({ coin }) => (
    coin?.baseCurrencyId === "XTVCBTC" || coin?.symbol === "BTC"
  ))

  if (!btc) {
    throw new Error("BTC must be present in baseCoins")
  }

  const total = marketClose(marketContext, "total", times)
  const totales = marketClose(marketContext, "totales", times)
  const total2es = marketClose(marketContext, "total2es", times)
  const total3esClose = marketClose(marketContext, "total3es", times)
  const stableCap = subtractSeries(total, totales)
  const segmentCaps = {
    btc: subtractSeries(totales, total2es),
    eth: subtractSeries(total2es, total3esClose),
    alts: total3esClose,
    stables: stableCap,
  }
  const segmentShares = Object.fromEntries(
    Object.entries(segmentCaps).map(([key, values]) => [
      key,
      values.map((value, index) => (
        Number.isFinite(value) && Number.isFinite(total[index]) && total[index] !== 0
          ? value / total[index]
          : null
      )),
    ]),
  )
  const segmentRotation4h = times.map((_, index) => {
    const change = key => (
      Number.isFinite(segmentShares[key][index])
      && Number.isFinite(segmentShares[key][index - 4])
        ? segmentShares[key][index] - segmentShares[key][index - 4]
        : null
    )
    const rotation = {
      btc: change("btc"),
      eth: change("eth"),
      alts: change("alts"),
      stables: change("stables"),
    }

    return Object.values(rotation).every(Number.isFinite) ? rotation : null
  })
  const returns4h = baseCoins.map(({ close }) => simpleReturns(close, 4))
  const universeBreadth4h = times.map((_, index) => {
    const finite = returns4h.map(values => values[index]).filter(Number.isFinite)
    return finite.length === 0
      ? null
      : finite.filter(value => value > 0).length / finite.length
  })
  const categoryContextsByCoin = new Map(baseCoins.map((baseCoin, index) => [
    baseCoin.coin.baseCurrencyId,
    buildCategoryContext(baseCoins, returns4h, index, times.length),
  ]))

  return {
    times,
    btcClose: btc.close,
    total3esClose,
    universeBreadth4h,
    segmentRotation4h,
    stablecapChange24h: simpleReturns(stableCap, 24),
    categoryContextsByCoin,
  }
}
