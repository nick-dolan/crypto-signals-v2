import { zipToObject } from "radash"
import { getRequiredString, parseInteger } from "../../helpers/normalization-helper.js"
import { SCREENER_COLUMNS } from "./config.js"

export function validatePositiveInteger (value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`)
  }
}

function normalizeOptionalPositiveNumber (value, fieldName) {
  if (value === null || value === undefined) {
    return null
  }

  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${fieldName} must be a positive number`)
  }

  return value
}

function getCandidateFieldName (index, field) {
  return `Crypto universe candidate at index ${index} ${field}`
}

function normalizeCandidateCategories (value, index) {
  if (!Array.isArray(value)) {
    throw new Error(`${getCandidateFieldName(index, "categories")} must be an array`)
  }

  return value.map((category, categoryIndex) => getRequiredString(
    category,
    getCandidateFieldName(index, `categories[${categoryIndex}]`),
  ))
}

export function normalizeUniverseCandidate (candidate, index, candidateRankMax) {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    throw new Error(`Crypto universe candidate at index ${index} must be an object`)
  }

  const rank = parseInteger(
    candidate.rank,
    getCandidateFieldName(index, "rank"),
  )

  if (rank < 1 || rank > candidateRankMax) {
    throw new Error(
      `${getCandidateFieldName(index, "rank")} must be between 1 and ${candidateRankMax}`,
    )
  }

  return {
    rank,
    baseCurrencyId: getRequiredString(
      candidate.baseCurrencyId,
      getCandidateFieldName(index, "baseCurrencyId"),
    ),
    symbol: getRequiredString(
      candidate.symbol,
      getCandidateFieldName(index, "symbol"),
    ),
    name: getRequiredString(
      candidate.name,
      getCandidateFieldName(index, "name"),
    ),
    tradingViewSymbol: getRequiredString(
      candidate.tradingViewSymbol,
      getCandidateFieldName(index, "tradingViewSymbol"),
    ),
    categories: normalizeCandidateCategories(candidate.categories, index),
    circulatingSupply: normalizeOptionalPositiveNumber(
      candidate.circulatingSupply,
      getCandidateFieldName(index, "circulatingSupply"),
    ),
    marketCap: normalizeOptionalPositiveNumber(
      candidate.marketCap,
      getCandidateFieldName(index, "marketCap"),
    ),
    fullyDilutedValuation: normalizeOptionalPositiveNumber(
      candidate.fullyDilutedValuation,
      getCandidateFieldName(index, "fullyDilutedValuation"),
    ),
  }
}

export function validateUniqueUniverseCandidates (candidates) {
  const ranks = new Set()
  const baseCurrencyIds = new Set()

  for (const candidate of candidates) {
    if (ranks.has(candidate.rank)) {
      throw new Error(`Crypto universe contains duplicate rank: ${candidate.rank}`)
    }

    if (baseCurrencyIds.has(candidate.baseCurrencyId)) {
      throw new Error(
        `Crypto universe contains duplicate baseCurrencyId: ${candidate.baseCurrencyId}`,
      )
    }

    ranks.add(candidate.rank)
    baseCurrencyIds.add(candidate.baseCurrencyId)
  }
}

export function isStablecoin (candidate) {
  return candidate.categories.some(
    category => category.toLowerCase() === "stablecoins",
  )
}

export function toUniverseCoin (candidate) {
  return {
    rank: candidate.rank,
    baseCurrencyId: candidate.baseCurrencyId,
    symbol: candidate.symbol,
    name: candidate.name,
    tradingViewSymbol: candidate.tradingViewSymbol,
    categories: [...candidate.categories],
    circulatingSupply: candidate.circulatingSupply,
    marketCap: candidate.marketCap,
    fullyDilutedValuation: candidate.fullyDilutedValuation,
  }
}

export function createScreenerRequest (rankMax) {
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

function normalizeScreenerCategories (value, index) {
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

export function normalizeScreenerRow (row, index, rankMax) {
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
    categories: normalizeScreenerCategories(
      values.crypto_common_categories,
      index,
    ),
    circulatingSupply: normalizeOptionalPositiveNumber(
      values.circulating_supply,
      getRowFieldName(index, "circulatingSupply"),
    ),
    marketCap: normalizeOptionalPositiveNumber(
      values.market_cap_calc,
      getRowFieldName(index, "marketCap"),
    ),
    fullyDilutedValuation: normalizeOptionalPositiveNumber(
      values.market_cap_diluted_calc,
      getRowFieldName(index, "fullyDilutedValuation"),
    ),
  }
}

export function validateScreenerCandidates (candidates, totalCount) {
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

export function validateScreenerPayload (payload) {
  if (
    !payload
    || typeof payload !== "object"
    || Array.isArray(payload)
    || !Array.isArray(payload.data)
  ) {
    throw new Error("TradingView crypto screener response does not contain a data array")
  }
}
