export const DATA_COVERAGE_TARGET_COUNT = 100
export const DATA_COVERAGE_PROBE_HOURS = 168
export const DATA_COVERAGE_MIN_DENSE_VALUES = 120
export const DATA_COVERAGE_MAX_STALENESS_HOURS = 24
export const DATA_COVERAGE_MAX_ATTEMPTS = 2

export const DATA_COVERAGE_TIMEFRAME = "60"
export const DATA_COVERAGE_TIMEFRAME_LABEL = "1h"
export const DATA_COVERAGE_TIMEOUT_MS = 45_000
export const DATA_COVERAGE_CHART_SETTLE_DELAY_MS = 500
export const DATA_COVERAGE_STUDY_SETTLE_DELAY_MS = 250

export const DATA_COVERAGE_REQUIRED_METADATA = Object.freeze([
  Object.freeze({
    field: "circulatingSupply",
    label: "circulating supply",
  }),
  Object.freeze({
    field: "marketCap",
    label: "market cap",
  }),
  Object.freeze({
    field: "fullyDilutedValuation",
    label: "fully diluted valuation",
  }),
])

export const DATA_COVERAGE_OPTIONAL_METADATA = Object.freeze(["categories"])
