import { zipToObject } from "radash"
import { getRequiredString, parseInteger } from "../../helpers/normalization-helper.js"
import { requestTradingViewJson } from "./request.js"

const COIN_SCREENER_URL = "https://scanner.tradingview.com/coin/scan"
const TRADINGVIEW_ORIGIN = "https://www.tradingview.com"
const DEFAULT_TIMEOUT_MS = 15_000

const COIN_COLUMNS = Object.freeze([
  "crypto_total_rank",
  "base_currency_id",
  "base_currency",
  "base_currency_desc",
  "crypto_common_categories",
  "circulating_supply",
  "market_cap_calc",
  "market_cap_diluted_calc",
])

function validatePositiveInteger (value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`)
  }
}

function createScreenerRequest (rankMax) {
  return {
    columns: COIN_COLUMNS,
    filter: [
      {
        left: "crypto_total_rank",
        operation: "eless",
        right: rankMax,
      },
    ],
    ignore_unknown_fields: false,
    options: {
      lang: "en",
    },
    range: [0, rankMax],
    sort: {
      sortBy: "crypto_total_rank",
      sortOrder: "asc",
    },
    symbols: {},
    markets: ["coin"],
  }
}

function getRowFieldName (index, field) {
  return `TradingView coin screener row at index ${index} ${field}`
}

function normalizeOptionalPositiveNumber (value, index, field) {
  if (value === null || value === undefined) {
    return null
  }

  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${getRowFieldName(index, field)} must be a positive number`)
  }

  return value
}

function normalizeCategories (value, index) {
  if (value === null || value === undefined) {
    return []
  }

  if (!Array.isArray(value)) {
    throw new Error(`${getRowFieldName(index, "categories")} must be an array`)
  }

  return value.map((category, categoryIndex) => getRequiredString(
    category,
    getRowFieldName(index, `categories[${categoryIndex}]`),
  ))
}

function normalizeCoin (row, index, rankMax) {
  if (!row || typeof row !== "object" || Array.isArray(row) || !Array.isArray(row.d)) {
    throw new Error(
      `TradingView coin screener row at index ${index} must contain a data array`,
    )
  }

  if (row.d.length !== COIN_COLUMNS.length) {
    throw new Error(
      `TradingView coin screener row at index ${index} must contain ${COIN_COLUMNS.length} values`,
    )
  }

  const values = zipToObject(COIN_COLUMNS, row.d)
  const rank = parseInteger(
    values.crypto_total_rank,
    getRowFieldName(index, "rank"),
  )

  if (rank < 1 || rank > rankMax) {
    throw new Error(
      `${getRowFieldName(index, "rank")} must be between 1 and ${rankMax}`,
    )
  }

  return {
    rank,
    baseCurrencyId: getRequiredString(
      values.base_currency_id,
      getRowFieldName(index, "baseCurrencyId"),
    ),
    symbol: getRequiredString(
      values.base_currency,
      getRowFieldName(index, "symbol"),
    ),
    name: getRequiredString(
      values.base_currency_desc,
      getRowFieldName(index, "name"),
    ),
    tradingViewSymbol: getRequiredString(
      row.s,
      getRowFieldName(index, "tradingViewSymbol"),
    ),
    categories: normalizeCategories(values.crypto_common_categories, index),
    circulatingSupply: normalizeOptionalPositiveNumber(
      values.circulating_supply,
      index,
      "circulatingSupply",
    ),
    marketCap: normalizeOptionalPositiveNumber(
      values.market_cap_calc,
      index,
      "marketCap",
    ),
    fullyDilutedValuation: normalizeOptionalPositiveNumber(
      values.market_cap_diluted_calc,
      index,
      "fullyDilutedValuation",
    ),
  }
}

function validateResponse (payload) {
  if (
    !payload
    || typeof payload !== "object"
    || Array.isArray(payload)
    || !Array.isArray(payload.data)
  ) {
    throw new Error("TradingView coin screener response does not contain a data array")
  }

  if (!Number.isSafeInteger(payload.totalCount) || payload.totalCount < 0) {
    throw new Error("TradingView coin screener response has invalid totalCount")
  }

  if (payload.data.length !== payload.totalCount) {
    throw new Error(
      `TradingView coin screener response is incomplete: expected ${payload.totalCount} rows, received ${payload.data.length}`,
    )
  }
}

function validateUniqueCoins (coins) {
  const ranks = new Set()
  const baseCurrencyIds = new Set()

  for (const coin of coins) {
    if (ranks.has(coin.rank)) {
      throw new Error(`TradingView coin screener response contains duplicate rank: ${coin.rank}`)
    }

    if (baseCurrencyIds.has(coin.baseCurrencyId)) {
      throw new Error(
        `TradingView coin screener response contains duplicate baseCurrencyId: ${coin.baseCurrencyId}`,
      )
    }

    ranks.add(coin.rank)
    baseCurrencyIds.add(coin.baseCurrencyId)
  }
}

export async function fetchTradingViewCoins ({
  rankMax,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  validatePositiveInteger(rankMax, "rankMax")

  const payload = await requestTradingViewJson(
    COIN_SCREENER_URL,
    {
      label: "TradingView coin screener",
      timeoutMs,
      method: "POST",
      headers: {
        "content-type": "application/json",
        "origin": TRADINGVIEW_ORIGIN,
      },
      body: JSON.stringify(createScreenerRequest(rankMax)),
    },
  )

  validateResponse(payload)

  const coins = payload.data
    .map((row, index) => normalizeCoin(row, index, rankMax))
    .sort((first, second) => first.rank - second.rank)

  validateUniqueCoins(coins)

  return coins
}
