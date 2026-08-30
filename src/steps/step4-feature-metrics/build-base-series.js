import { readTmpJson } from "../../helpers/fs-helper.js"

function isHourlyGrid (times) {
  return times.length > 0 && times.every((time, index) => (
    Number.isFinite(time)
    && (index === 0 || time === times[index - 1] + 3_600)
  ))
}

function getChartPeriods (hourlyData) {
  const periods = hourlyData?.chart?.periods

  if (!Array.isArray(periods)) {
    throw new Error("Coin OHLCV periods are required")
  }

  const times = periods.map(period => period?.time)

  if (!isHourlyGrid(times)) {
    throw new Error("Coin OHLCV must use a complete hourly grid")
  }

  return periods
}

function alignPeriods (periods, field, times) {
  if (!Array.isArray(periods)) {
    throw new Error(`Study periods for ${field} are required`)
  }

  const valuesByTime = new Map()

  for (const period of periods) {
    if (!Number.isFinite(period?.time) || valuesByTime.has(period.time)) {
      throw new Error(`Study field ${field} contains an invalid hourly grid`)
    }

    const value = period[field]

    valuesByTime.set(
      period.time,
      Number.isFinite(value) ? Object.is(value, -0) ? 0 : value : null,
    )
  }

  return times.map(time => valuesByTime.get(time) ?? null)
}

function studyField (hourlyData, key, field, times) {
  return alignPeriods(hourlyData?.studies?.[key]?.periods, field, times)
}

export function buildAlignedCoinSeries (hourlyData, expectedTimes) {
  const chartPeriods = getChartPeriods(hourlyData)
  const times = chartPeriods.map(period => period.time)

  if (
    !Array.isArray(expectedTimes)
    || times.length !== expectedTimes.length
    || !times.every((time, index) => time === expectedTimes[index])
  ) {
    throw new Error(`${hourlyData?.coin?.symbol ?? "Coin"} does not use the universe hourly grid`)
  }

  return {
    times,
    high: chartPeriods.map(period => period.max),
    low: chartPeriods.map(period => period.min),
    close: chartPeriods.map(period => period.close),
    volume: chartPeriods.map(period => period.volume),
    volumeDelta: studyField(hourlyData, "volumeDelta", "close", times),
    openInterest: studyField(hourlyData, "openInterest", "close", times),
    fundingRate: studyField(hourlyData, "fundingRate", "rate", times),
    longLiquidations: studyField(hourlyData, "liquidations", "long", times),
    shortLiquidations: studyField(hourlyData, "liquidations", "short", times),
    longShortRatioAccounts: studyField(
      hourlyData,
      "longShortRatioAccounts",
      "ratio",
      times,
    ),
    topTradersLong: studyField(
      hourlyData,
      "topTradersLongShortPositions",
      "long",
      times,
    ),
    topTradersShort: studyField(
      hourlyData,
      "topTradersLongShortPositions",
      "short",
      times,
    ),
    premium: studyField(hourlyData, "premium", "close", times),
    socialDominance: studyField(
      hourlyData,
      "socialDominance",
      "percent",
      times,
    ),
    interactions: studyField(hourlyData, "interactions", "value", times),
    activeContributors: studyField(
      hourlyData,
      "activeContributors",
      "value",
      times,
    ),
    createdPosts: studyField(hourlyData, "createdPosts", "value", times),
  }
}

export async function buildBaseSeries (
  { coinDataFiles, sourceUniverse },
  { readCoinData = readTmpJson } = {},
) {
  const metadataById = new Map(
    sourceUniverse.coins.map(coin => [coin.baseCurrencyId, coin]),
  )
  const baseCoins = []

  for (const dataFile of coinDataFiles) {
    const hourlyData = await readCoinData(dataFile)
    const chartPeriods = getChartPeriods(hourlyData)
    const metadata = metadataById.get(hourlyData?.coin?.baseCurrencyId)

    if (!metadata) {
      throw new Error(
        `${hourlyData?.coin?.baseCurrencyId ?? "Unknown coin"} is missing from step 1`,
      )
    }

    if (metadata.market?.tradingViewSymbol !== hourlyData.coin.marketSymbol) {
      throw new Error(`${metadata.symbol} market does not match step 1`)
    }

    baseCoins.push({
      dataFile,
      coin: {
        rank: metadata.rank,
        baseCurrencyId: metadata.baseCurrencyId,
        symbol: metadata.symbol,
        name: metadata.name,
        tradingViewSymbol: metadata.tradingViewSymbol,
        marketSymbol: metadata.market.tradingViewSymbol,
      },
      categories: [...metadata.categories],
      metadata,
      times: chartPeriods.map(period => period.time),
      close: chartPeriods.map(period => period.close),
    })
  }

  return baseCoins.sort((first, second) => first.coin.rank - second.coin.rank)
}
