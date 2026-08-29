import { zipToObject } from "radash"
import { requestTradingViewJson } from "./request.js"

const CRYPTO_MARKET_SCREENER_URL = "https://scanner.tradingview.com/crypto/scan"
const TRADINGVIEW_ORIGIN = "https://www.tradingview.com"
const DEFAULT_TIMEOUT_MS = 20_000
const DEFAULT_MAX_ROWS = 10_000

const MARKET_COLUMNS = Object.freeze([
  "name",
  "description",
  "base_currency",
  "base_currency_id",
  "currency",
  "exchange",
  "close",
  "24h_vol|5",
  "type",
  "subtype",
  "typespecs",
])

function validatePositiveInteger (value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`)
  }
}

function normalizeStringArray (values, name) {
  if (!Array.isArray(values) || values.length === 0) {
    throw new Error(`${name} must be a non-empty array`)
  }

  const normalizedValues = [...new Set(values.map(value => (
    typeof value === "string" ? value.trim().toUpperCase() : ""
  )))]

  if (normalizedValues.includes("")) {
    throw new Error(`${name} must contain non-empty strings`)
  }

  return normalizedValues
}

function createScreenerRequest ({
  baseCurrencyIds,
  exchanges,
  instrumentTypes,
  maxRows,
  quoteSymbols,
}) {
  return {
    columns: MARKET_COLUMNS,
    filter: [
      {
        left: "base_currency_id",
        operation: "in_range",
        right: baseCurrencyIds,
      },
      {
        left: "currency",
        operation: "in_range",
        right: quoteSymbols,
      },
      {
        left: "exchange",
        operation: "in_range",
        right: exchanges,
      },
      {
        left: "type",
        operation: "in_range",
        right: instrumentTypes,
      },
      {
        left: "24h_vol|5",
        operation: "greater",
        right: 0,
      },
    ],
    ignore_unknown_fields: false,
    options: {
      lang: "en",
    },
    range: [0, maxRows],
    sort: {
      sortBy: "24h_vol|5",
      sortOrder: "desc",
    },
    symbols: {},
    markets: ["crypto"],
  }
}

function getRowFieldName (index, field) {
  return `TradingView crypto market row at index ${index} ${field}`
}

function getRequiredString (value, index, field) {
  const normalizedValue = typeof value === "string" ? value.trim() : ""

  if (!normalizedValue) {
    throw new Error(`${getRowFieldName(index, field)} is required`)
  }

  return normalizedValue
}

function getPositiveNumber (value, index, field) {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${getRowFieldName(index, field)} must be a positive number`)
  }

  return value
}

function normalizeTypeSpecifications (value, index) {
  if (value === null || value === undefined) {
    return []
  }

  if (!Array.isArray(value)) {
    throw new Error(
      `${getRowFieldName(index, "typeSpecifications")} must be an array`,
    )
  }

  return value.map((specification, specificationIndex) => getRequiredString(
    specification,
    index,
    `typeSpecifications[${specificationIndex}]`,
  ))
}

function normalizeMarket (row, index) {
  if (!row || typeof row !== "object" || Array.isArray(row) || !Array.isArray(row.d)) {
    throw new Error(
      `TradingView crypto market row at index ${index} must contain a data array`,
    )
  }

  if (row.d.length !== MARKET_COLUMNS.length) {
    throw new Error(
      `TradingView crypto market row at index ${index} must contain ${MARKET_COLUMNS.length} values`,
    )
  }

  const values = zipToObject(MARKET_COLUMNS, row.d)

  return {
    tradingViewSymbol: getRequiredString(row.s, index, "tradingViewSymbol"),
    symbol: getRequiredString(values.name, index, "symbol"),
    description: getRequiredString(values.description, index, "description"),
    baseSymbol: getRequiredString(values.base_currency, index, "baseSymbol"),
    baseCurrencyId: getRequiredString(
      values.base_currency_id,
      index,
      "baseCurrencyId",
    ),
    quoteSymbol: getRequiredString(values.currency, index, "quoteSymbol"),
    exchange: getRequiredString(values.exchange, index, "exchange"),
    price: getPositiveNumber(values.close, index, "price"),
    volume24hUsd: getPositiveNumber(values["24h_vol|5"], index, "volume24hUsd"),
    instrumentType: getRequiredString(values.type, index, "instrumentType"),
    instrumentSubtype: getRequiredString(
      values.subtype,
      index,
      "instrumentSubtype",
    ),
    typeSpecifications: normalizeTypeSpecifications(values.typespecs, index),
  }
}

function validateResponse (payload, maxRows) {
  if (
    !payload
    || typeof payload !== "object"
    || Array.isArray(payload)
    || !Array.isArray(payload.data)
  ) {
    throw new Error("TradingView crypto market response does not contain a data array")
  }

  if (!Number.isSafeInteger(payload.totalCount) || payload.totalCount < 0) {
    throw new Error("TradingView crypto market response has invalid totalCount")
  }

  if (payload.totalCount > maxRows) {
    throw new Error(
      `TradingView crypto market response exceeds maxRows: ${payload.totalCount} > ${maxRows}`,
    )
  }

  if (payload.data.length !== payload.totalCount) {
    throw new Error(
      `TradingView crypto market response is incomplete: expected ${payload.totalCount} rows, received ${payload.data.length}`,
    )
  }
}

export async function fetchTradingViewCryptoMarkets ({
  baseCurrencyIds,
  exchanges = ["BINANCE"],
  instrumentTypes = ["swap"],
  maxRows = DEFAULT_MAX_ROWS,
  quoteSymbols = ["USDT"],
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  const normalizedBaseCurrencyIds = normalizeStringArray(
    baseCurrencyIds,
    "baseCurrencyIds",
  )
  const normalizedExchanges = normalizeStringArray(exchanges, "exchanges")
  const normalizedInstrumentTypes = normalizeStringArray(
    instrumentTypes,
    "instrumentTypes",
  ).map(value => value.toLowerCase())
  const normalizedQuoteSymbols = normalizeStringArray(
    quoteSymbols,
    "quoteSymbols",
  )

  validatePositiveInteger(maxRows, "maxRows")

  const payload = await requestTradingViewJson(
    CRYPTO_MARKET_SCREENER_URL,
    {
      label: "TradingView crypto market screener",
      timeoutMs,
      method: "POST",
      headers: {
        "content-type": "application/json",
        "origin": TRADINGVIEW_ORIGIN,
      },
      body: JSON.stringify(createScreenerRequest({
        baseCurrencyIds: normalizedBaseCurrencyIds,
        exchanges: normalizedExchanges,
        instrumentTypes: normalizedInstrumentTypes,
        maxRows,
        quoteSymbols: normalizedQuoteSymbols,
      })),
    },
  )

  validateResponse(payload, maxRows)

  return payload.data.map(normalizeMarket)
}
