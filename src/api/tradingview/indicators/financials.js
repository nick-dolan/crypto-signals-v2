import { defineIndicator } from "./definition.js"

function defineFinancialIndicator ({ plot, ...definition }) {
  return defineIndicator("financials", {
    ...definition,
    fields: {
      value: plot,
    },
  })
}

export const FINANCIAL_INDICATOR_DEFINITIONS = Object.freeze([
  defineFinancialIndicator({
    key: "rvtRatio90Days",
    id: "STD;CryptoFund_rvt_adj_90",
    version: "7.0",
    name: "RVT ratio, 90 days",
    plot: "RVT_ratio_90_days",
  }),
  defineFinancialIndicator({
    key: "realizedMarketCap",
    id: "STD;CryptoFund_market_cap_real",
    version: "7.0",
    name: "Realized market cap",
    plot: "Realized_market_cap",
  }),
  defineFinancialIndicator({
    key: "supplyEqualityRatio",
    id: "STD;CryptoFund_ser",
    version: "7.0",
    name: "Supply equality ratio",
    plot: "Supply_equality_ratio",
  }),
  defineFinancialIndicator({
    key: "activeSupplyOneYearPercent",
    id: "STD;CryptoFund_active_supply_1y",
    version: "7.0",
    name: "1 year active supply %",
    plot: "1_year_active_supply_",
  }),
])
