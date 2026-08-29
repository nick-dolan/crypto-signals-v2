import { defineIndicator } from "./definition.js"

const OHLC_FIELDS = {
  open: "plotcandle_0_ohlc_open",
  high: "plotcandle_0_ohlc_high",
  low: "plotcandle_0_ohlc_low",
  close: "plotcandle_0_ohlc_close",
}

function defineDerivativeIndicator (definition) {
  return defineIndicator("derivatives", definition)
}

export const DERIVATIVE_INDICATOR_DEFINITIONS = Object.freeze([
  defineDerivativeIndicator({
    key: "openInterest",
    id: "STD;Fund_crypto_open_interest",
    version: "7.0",
    name: "Crypto Open Interest",
    fields: OHLC_FIELDS,
  }),
  defineDerivativeIndicator({
    key: "fundingRate",
    id: "STD;Fund_funding_rate",
    version: "7.0",
    name: "Funding Rate",
    fields: {
      rate: "Funding_Rate",
    },
  }),
  defineDerivativeIndicator({
    key: "liquidations",
    id: "STD;Fund_liquidations",
    version: "7.0",
    name: "Liquidations",
    fields: {
      long: "Long_Liquidations",
      short: "Short_Liquidations",
    },
    allowMissingValues: true,
  }),
  defineDerivativeIndicator({
    key: "longShortRatioAccounts",
    id: "STD;Fund_long_short_ratio",
    version: "7.0",
    name: "Long/Short Ratio Accounts",
    fields: {
      ratio: "LongShort_Ratio_Accounts",
    },
  }),
  defineDerivativeIndicator({
    key: "longShortAccounts",
    id: "STD;Fund_long_short_accounts",
    version: "7.0",
    name: "Long Short Accounts %",
    fields: {
      long: "Long_Accounts_",
      short: "Short_Accounts_",
    },
  }),
  defineDerivativeIndicator({
    key: "markPrice",
    id: "STD;Fund_binance_mark_price_noagg",
    version: "4.0",
    name: "Mark price",
    fields: OHLC_FIELDS,
  }),
  defineDerivativeIndicator({
    key: "indexPrice",
    id: "STD;Fund_binance_index_price_noagg",
    version: "4.0",
    name: "Index price",
    fields: OHLC_FIELDS,
  }),
  defineDerivativeIndicator({
    key: "premium",
    id: "STD;Fund_binance_premium_noagg",
    version: "4.0",
    name: "Premium",
    fields: OHLC_FIELDS,
  }),
  defineDerivativeIndicator({
    key: "basis",
    id: "STD;Fund_binance_basis_noagg",
    version: "4.0",
    name: "Basis",
    fields: OHLC_FIELDS,
  }),
  defineDerivativeIndicator({
    key: "topTradersLongShortAccounts",
    id: "STD;Fund_binance_top_traders_ls_accounts_noagg",
    version: "4.0",
    name: "Top traders long and short accounts %",
    fields: {
      long: "Top_Traders_Long_Accounts_",
      short: "Top_Traders_Short_Accounts_",
    },
  }),
  defineDerivativeIndicator({
    key: "topTradersLongShortRatioAccounts",
    id: "STD;Fund_binance_top_traders_ls_accounts_ratio_noagg",
    version: "4.0",
    name: "Top traders long/short ratio accounts",
    fields: {
      ratio: "Top_traders_longshort_ratio_accounts",
    },
  }),
  defineDerivativeIndicator({
    key: "topTradersLongShortPositions",
    id: "STD;Fund_binance_top_traders_ls_positions_noagg",
    version: "4.0",
    name: "Top traders long and short positions %",
    fields: {
      long: "Top_Traders_Long_Positions_",
      short: "Top_Traders_Short_Positions_",
    },
  }),
  defineDerivativeIndicator({
    key: "topTradersLongShortRatioPositions",
    id: "STD;Fund_binance_top_traders_ls_positions_ratio_noagg",
    version: "4.0",
    name: "Top traders long/short ratio positions",
    fields: {
      ratio: "Top_traders_longshort_ratio_positions",
    },
  }),
])
