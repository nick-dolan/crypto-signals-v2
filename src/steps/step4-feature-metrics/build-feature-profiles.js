import { isArray, isFinite, isNaN, isNumber, isObject } from "../../helpers/utils.typed.js"
import { buildAlignedCoinSeries } from "./build-base-series.js"
import { calculateCoinMetrics } from "./calculate-coin-metrics.js"

function latestValues (seriesByName) {
  return Object.fromEntries(Object.entries(seriesByName).map(([name, series]) => [
    name,
    isArray(series) ? series.at(-1) : series,
  ]))
}

function findUnavailableMetrics (features, categoryApplicable) {
  const allowedNulls = new Set(
    categoryApplicable
      ? []
      : [
          "breadthNarrative.category_momentum_4h",
          "breadthNarrative.category_breadth",
          "breadthNarrative.coin_leads_category",
          "divergences.laggard",
        ],
  )
  const unavailable = []

  function visit (value, path) {
    if (value === null) {
      if (!allowedNulls.has(path)) {
        unavailable.push(path)
      }
      return
    }

    if ((isNumber(value) || isNaN(value)) && !isFinite(value)) {
      unavailable.push(path)
      return
    }

    if (isObject(value)) {
      for (const [key, nestedValue] of Object.entries(value)) {
        visit(nestedValue, path ? `${path}.${key}` : key)
      }
    }
  }

  visit(features, "")
  return unavailable
}

function calculateVolume24hUsd ({ close, volume }) {
  return close.slice(-24).reduce((total, price, index) => (
    total + price * volume.at(index - 24)
  ), 0)
}

export function createFeatureProfile (baseCoin, coinSeries, calculated) {
  const features = Object.fromEntries(
    Object.entries(calculated.featureSeries).map(([group, seriesByName]) => [
      group,
      latestValues(seriesByName),
    ]),
  )
  const unavailableMetrics = findUnavailableMetrics(
    features,
    calculated.categoryContext.applicable,
  )

  if (unavailableMetrics.length > 0) {
    return {
      profile: null,
      rejection: {
        coin: baseCoin.coin,
        unavailableMetrics,
      },
    }
  }

  return {
    profile: {
      coin: {
        ...baseCoin.coin,
        categories: [...baseCoin.categories],
      },
      context: {
        price: coinSeries.close.at(-1),
        atr24hPct: calculated.atr24hPct.at(-1),
        marketCap: baseCoin.metadata.marketCap,
        volume24hUsd: calculateVolume24hUsd(coinSeries),
        narrativeCategory: calculated.categoryContext.category,
        categoryStatus: calculated.categoryContext.status,
      },
      features,
    },
    rejection: null,
  }
}

export function buildFeatureProfiles (
  baseCoins,
  universeContext,
  { onProgress = () => {} } = {},
) {
  const profiles = []
  const rejected = []

  for (const [index, baseCoin] of baseCoins.entries()) {
    const coinSeries = buildAlignedCoinSeries(
      baseCoin.hourlyData,
      universeContext.times,
    )
    const calculated = calculateCoinMetrics(
      coinSeries,
      universeContext,
      baseCoin.coin.baseCurrencyId,
    )
    const result = createFeatureProfile(baseCoin, coinSeries, calculated)

    if (result.profile) {
      profiles.push(result.profile)
    } else {
      rejected.push(result.rejection)
    }

    onProgress({
      index: index + 1,
      total: baseCoins.length,
      coin: baseCoin.coin,
      status: result.profile ? "complete" : "rejected",
      unavailableMetrics: result.rejection?.unavailableMetrics ?? [],
    })
  }

  return { profiles, rejected }
}
