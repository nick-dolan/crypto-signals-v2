import { defineIndicator } from "./definition.js"

function defineOwnershipIndicator ({ inputs = {}, plot, ...definition }) {
  return defineIndicator("ownership", {
    ...definition,
    fields: {
      value: plot,
    },
    inputs,
  })
}

export const OWNERSHIP_INDICATOR_DEFINITIONS = Object.freeze([
  defineOwnershipIndicator({
    key: "heldTokensAboveUsdThreshold",
    id: "STD;CryptoFund_supply_addresses_balance_1_usd",
    version: "7.0",
    name: "Held tokens in addresses ≥ X (USD)",
    plot: "Held_tokens_in_addresses__X_in_USD",
    inputs: {
      in_1: "≥ $100 (USD)",
    },
  }),
  defineOwnershipIndicator({
    key: "heldTokensAboveTokenThreshold",
    id: "STD;CryptoFund_supply_addresses_balance_0001",
    version: "7.0",
    name: "Held tokens in addresses ≥ X (tokens)",
    plot: "Held_tokens_in_addresses__X_in_native_units",
    inputs: {
      in_1: "≥ 1 (tokens)",
    },
  }),
  defineOwnershipIndicator({
    key: "heldTokensAboveSupplyThreshold",
    id: "STD;CryptoFund_supply_addresses_balance_1_in_10",
    version: "7.0",
    name: "Held tokens in addresses ≥ X (% of supply)",
    plot: "Held_tokens_in_addresses__X__of_supply",
    inputs: {
      in_1: "≥ 0.001% (%)",
    },
  }),
  defineOwnershipIndicator({
    key: "addressesAboveUsdBalanceThreshold",
    id: "STD;CryptoFund_addresses_balance_1_usd",
    version: "7.0",
    name: "Addresses with balance ≥ X (USD)",
    plot: "Addresses_with_balance__X_USD",
    inputs: {
      in_1: "≥ $100 (USD)",
    },
  }),
  defineOwnershipIndicator({
    key: "addressesAboveSupplyBalanceThreshold",
    id: "STD;CryptoFund_addresses_supply_1_in_10",
    version: "7.0",
    name: "Addresses with balance ≥ X (% of supply)",
    plot: "Addresses_with_balance__X__of_supply",
    inputs: {
      in_1: "≥ 0.001% (%)",
    },
  }),
  defineOwnershipIndicator({
    key: "usSpotEtfBalancesUsd",
    id: "STD;CryptoFund_total_us_spot_etf_balances_usd",
    version: "6.0",
    name: "US spot crypto ETF balances in USD",
    plot: "US_spot_crypto_ETF_balances_in_USD",
  }),
  defineOwnershipIndicator({
    key: "usSpotEtfBalances",
    id: "STD;CryptoFund_total_us_spot_etf_balances",
    version: "6.0",
    name: "US spot crypto ETF balances",
    plot: "US_spot_crypto_ETF_balances",
  }),
  defineOwnershipIndicator({
    key: "usSpotEtfFlowsUsd",
    id: "STD;CryptoFund_total_us_spot_etf_flows_usd",
    version: "6.0",
    name: "US spot crypto ETF flows in USD",
    plot: "US_spot_crypto_ETF_flows_in_USD",
  }),
  defineOwnershipIndicator({
    key: "usSpotEtfFlows",
    id: "STD;CryptoFund_total_us_spot_etf_flows",
    version: "6.0",
    name: "US spot crypto ETF flows",
    plot: "US_spot_crypto_ETF_flows",
  }),
])
