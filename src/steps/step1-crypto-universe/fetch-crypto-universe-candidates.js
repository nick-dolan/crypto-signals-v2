import { zipToObject } from "radash"
import { requestTradingViewJson } from "../../api/tradingview/request.js"
import { getRequiredString, parseInteger } from "../../helpers/normalization-helper.js"
import {
  CRYPTO_UNIVERSE_CANDIDATE_RANK_MAX,
  SCREENER_COLUMNS,
} from "./config.js"

function validatePositiveInteger (value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`)
  }
}

function createScreenerRequest (rankMax) {
  return {
    columns: SCREENER_COLUMNS,
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
  return `TradingView crypto screener row at index ${index} ${field}`
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

function normalizeOptionalPositiveNumber (value, index, field) {
  if (value === null || value === undefined) {
    return null
  }

  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${getRowFieldName(index, field)} must be a positive number`)
  }

  return value
}

function normalizeRow (row, index, rankMax) {
  if (!row || typeof row !== "object" || Array.isArray(row) || !Array.isArray(row.d)) {
    throw new Error(
      `TradingView crypto screener row at index ${index} must contain a data array`,
    )
  }

  if (row.d.length !== SCREENER_COLUMNS.length) {
    throw new Error(
      `TradingView crypto screener row at index ${index} must contain ${SCREENER_COLUMNS.length} values`,
    )
  }

  const values = zipToObject(SCREENER_COLUMNS, row.d)
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
    categories: normalizeCategories(
      values.crypto_common_categories,
      index,
    ),
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

function validateCandidates (candidates, totalCount) {
  if (!Number.isSafeInteger(totalCount) || totalCount < 0) {
    throw new Error("TradingView crypto screener response has invalid totalCount")
  }

  if (candidates.length !== totalCount) {
    throw new Error(
      `TradingView crypto screener response is incomplete: expected ${totalCount} rows, received ${candidates.length}`,
    )
  }

  const ranks = new Set()
  const baseCurrencyIds = new Set()

  for (const candidate of candidates) {
    if (ranks.has(candidate.rank)) {
      throw new Error(
        `TradingView crypto screener response contains duplicate rank: ${candidate.rank}`,
      )
    }

    if (baseCurrencyIds.has(candidate.baseCurrencyId)) {
      throw new Error(
        `TradingView crypto screener response contains duplicate baseCurrencyId: ${candidate.baseCurrencyId}`,
      )
    }

    ranks.add(candidate.rank)
    baseCurrencyIds.add(candidate.baseCurrencyId)
  }
}

export async function fetchCryptoUniverseCandidates ({
  rankMax = CRYPTO_UNIVERSE_CANDIDATE_RANK_MAX,
  timeoutMs = 15_000,
} = {}) {
  validatePositiveInteger(rankMax, "rankMax")

  const payload = await requestTradingViewJson(
    "https://scanner.tradingview.com/coin/scan",
    {
      label: "TradingView crypto screener",
      timeoutMs,
      method: "POST",
      headers: {
        "content-type": "application/json",
        "origin": "https://www.tradingview.com",
      },
      body: JSON.stringify(createScreenerRequest(rankMax)),
    },
  )

  if (
    !payload
    || typeof payload !== "object"
    || Array.isArray(payload)
    || !Array.isArray(payload.data)
  ) {
    throw new Error("TradingView crypto screener response does not contain a data array")
  }

  const candidates = payload.data
    .map((row, index) => normalizeRow(row, index, rankMax))
    .sort((first, second) => first.rank - second.rank)

  validateCandidates(candidates, payload.totalCount)

  return candidates
}
