export const DATA_COVERAGE_TARGET_COUNT = 100
export const DATA_BOOTSTRAP_HISTORY_HOURS = 100 * 24
export const DATA_COVERAGE_PROBE_HOURS = 168
export const DATA_COVERAGE_MIN_DENSE_VALUES = 120
export const DATA_COVERAGE_MAX_STALENESS_HOURS = 24
export const DATA_COVERAGE_MAX_ATTEMPTS = 2
export const DATA_COVERAGE_UNAVAILABLE_CONFIRMATION_ATTEMPTS = 2
export const DATA_COVERAGE_LONG_HISTORY_HOURS = 90 * 24
export const DATA_COVERAGE_STANDARD_HISTORY_HOURS = 30 * 24
export const DATA_COVERAGE_HISTORY_MIN_RATIO = (
  DATA_COVERAGE_MIN_DENSE_VALUES / DATA_COVERAGE_PROBE_HOURS
)
export const DATA_COVERAGE_TIMEFRAME = "60"
export const DATA_COVERAGE_TIMEFRAME_LABEL = "1h"
export const DATA_COVERAGE_TIMEOUT_MS = 45_000
export const DATA_COVERAGE_CHART_SETTLE_DELAY_MS = 500
export const DATA_COVERAGE_STUDY_SETTLE_DELAY_MS = 250

export const DATA_COVERAGE_REQUIRED_SELECTION_FIELDS = Object.freeze([
  "exchange",
  "quoteSymbol",
  "instrumentType",
  "typeSpecification",
])

export const DATA_COVERAGE_REQUIRED_STUDY_KEYS = Object.freeze([
  "volumeDelta",
  "openInterest",
  "fundingRate",
  "liquidations",
  "longShortRatioAccounts",
  "topTradersLongShortPositions",
  "premium",
  "socialDominance",
  "interactions",
  "activeContributors",
  "createdPosts",
])

export const DATA_COVERAGE_SPARSE_STUDIES = Object.freeze(["liquidations"])

export const DATA_COVERAGE_HISTORY_REQUIREMENTS = Object.freeze({
  ohlcv: DATA_COVERAGE_LONG_HISTORY_HOURS,
  volumeDelta: DATA_COVERAGE_STANDARD_HISTORY_HOURS,
  openInterest: DATA_COVERAGE_STANDARD_HISTORY_HOURS,
  fundingRate: DATA_COVERAGE_LONG_HISTORY_HOURS,
  premium: DATA_COVERAGE_STANDARD_HISTORY_HOURS,
  socialDominance: DATA_COVERAGE_STANDARD_HISTORY_HOURS,
  interactions: DATA_COVERAGE_STANDARD_HISTORY_HOURS,
  activeContributors: DATA_COVERAGE_STANDARD_HISTORY_HOURS,
  createdPosts: DATA_COVERAGE_STANDARD_HISTORY_HOURS,
})

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
