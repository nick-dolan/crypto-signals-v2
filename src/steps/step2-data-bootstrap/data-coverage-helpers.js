import { getRequiredString } from "../../helpers/normalization-helper.js"

export function validatePositiveInteger (value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`)
  }
}

function validateCandidateMarket (candidate, index) {
  const market = candidate.market
  const fieldName = `Crypto universe candidate at index ${index} market`

  if (!market || typeof market !== "object" || Array.isArray(market)) {
    throw new Error(`${fieldName} is required`)
  }

  getRequiredString(market.tradingViewSymbol, `${fieldName} tradingViewSymbol`)
  getRequiredString(market.baseCurrencyId, `${fieldName} baseCurrencyId`)

  if (market.baseCurrencyId !== candidate.baseCurrencyId) {
    throw new Error(`${fieldName} baseCurrencyId does not match its coin`)
  }
}

function validateCandidates (candidates) {
  if (!Array.isArray(candidates)) {
    throw new Error("Crypto universe candidates must be an array")
  }

  const ranks = new Set()
  const baseCurrencyIds = new Set()

  for (const [index, candidate] of candidates.entries()) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      throw new Error(`Crypto universe candidate at index ${index} must be an object`)
    }

    if (!Number.isSafeInteger(candidate.rank) || candidate.rank <= 0) {
      throw new Error(`Crypto universe candidate at index ${index} rank is invalid`)
    }

    getRequiredString(
      candidate.baseCurrencyId,
      `Crypto universe candidate at index ${index} baseCurrencyId`,
    )
    validateCandidateMarket(candidate, index)

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

export function normalizeSourceUniverse (sourceUniverse) {
  if (!sourceUniverse || typeof sourceUniverse !== "object" || Array.isArray(sourceUniverse)) {
    throw new Error("Source crypto universe must be an object")
  }

  const source = getRequiredString(sourceUniverse.source, "Crypto universe source")
  const selection = sourceUniverse.selection

  if (!selection || typeof selection !== "object" || Array.isArray(selection)) {
    throw new Error("Crypto universe selection is required")
  }

  validateCandidates(sourceUniverse.coins)

  return {
    source,
    selection: { ...selection },
    candidates: sourceUniverse.coins,
  }
}

function getErrorMessage (error) {
  return error instanceof Error ? error.message : String(error)
}

function createFailedCheckResult (error) {
  const message = getErrorMessage(error)

  return {
    complete: false,
    retryable: true,
    reasonCodes: ["coverage:request_failed"],
    reasons: [`Coverage request failed: ${message}`],
    unavailableMetrics: [],
    coverage: null,
  }
}

export async function checkWithRetry (
  checkCoverage,
  coin,
  maxAttempts,
  onProgress,
) {
  let result
  let previousUnavailableMetrics = new Set()

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      result = await checkCoverage(coin, attempt)
    } catch (error) {
      result = createFailedCheckResult(error)
    }

    const unavailableMetrics = new Set(
      Array.isArray(result?.unavailableMetrics)
        ? result.unavailableMetrics
        : [],
    )
    const confirmedUnavailableMetrics = [...unavailableMetrics]
      .filter(metric => previousUnavailableMetrics.has(metric))

    result = {
      ...result,
      confirmedUnavailableMetrics,
    }

    if (result?.complete || !result?.retryable || attempt === maxAttempts) {
      return {
        attempts: attempt,
        result,
      }
    }

    previousUnavailableMetrics = unavailableMetrics

    onProgress({
      status: "retrying",
      coin,
      market: coin.market,
      attempt,
      result,
    })
  }

  throw new Error("Coverage retry loop ended unexpectedly")
}

export function toPublicMarket (market) {
  return {
    tradingViewSymbol: market.tradingViewSymbol,
    symbol: market.symbol,
    baseSymbol: market.baseSymbol,
    baseCurrencyId: market.baseCurrencyId,
    quoteSymbol: market.quoteSymbol,
    exchange: market.exchange,
    price: market.price,
    volume24hUsd: market.volume24hUsd,
    instrumentType: market.instrumentType,
    typeSpecifications: [...market.typeSpecifications],
  }
}

export function createCoverageRejection (coin, attempts, result) {
  return {
    ...coin,
    market: toPublicMarket(coin.market),
    attempts,
    reasonCodes: Array.isArray(result?.reasonCodes)
      ? [...result.reasonCodes]
      : ["coverage:invalid_result"],
    reasons: Array.isArray(result?.reasons)
      ? [...result.reasons]
      : ["Coverage check returned an invalid result"],
    unavailableMetrics: Array.isArray(result?.unavailableMetrics)
      ? [...result.unavailableMetrics]
      : [],
    confirmedUnavailableMetrics: Array.isArray(result?.confirmedUnavailableMetrics)
      ? [...result.confirmedUnavailableMetrics]
      : [],
    coverage: result?.coverage ?? null,
  }
}

export function summarizeRejections (rejected) {
  const summary = {}

  for (const rejection of rejected) {
    for (const reasonCode of rejection.reasonCodes) {
      summary[reasonCode] = (summary[reasonCode] ?? 0) + 1
    }
  }

  return Object.fromEntries(
    Object.entries(summary).sort((first, second) => (
      second[1] - first[1] || first[0].localeCompare(second[0])
    )),
  )
}

function getLatestClosedHourlyPeriodTime (referenceTime) {
  if (!Number.isFinite(referenceTime)) {
    return null
  }

  return Math.floor(referenceTime / 3_600) * 3_600 - 3_600
}

export function getClosedHourlyPeriods (periods, referenceTime, hours) {
  const latestClosedTime = getLatestClosedHourlyPeriodTime(referenceTime)

  if (latestClosedTime === null) {
    return []
  }

  const earliestTime = hours === undefined
    ? -Infinity
    : latestClosedTime - (hours - 1) * 3_600

  return (Array.isArray(periods) ? periods : [])
    .filter(period => (
      Number.isFinite(period?.time)
      && period.time >= earliestTime
      && period.time <= latestClosedTime
    ))
    .sort((first, second) => first.time - second.time)
}

function summarizeHourlyCoverage (
  periods,
  fields,
  referenceTime,
  requiredHours,
) {
  const latestExpectedTime = getLatestClosedHourlyPeriodTime(referenceTime)
  const earliestExpectedTime = latestExpectedTime - (requiredHours - 1) * 3_600
  const expectedTimes = Array.from(
    { length: requiredHours },
    (_, index) => earliestExpectedTime + index * 3_600,
  )
  const expectedTimeSet = new Set(expectedTimes)
  const sourcePeriods = Array.isArray(periods) ? periods : []
  const windowPeriods = getClosedHourlyPeriods(
    sourcePeriods,
    referenceTime,
    requiredHours,
  )
  const periodsByTime = new Map()
  let offGridPeriodCount = 0

  for (const period of windowPeriods) {
    if (!expectedTimeSet.has(period.time)) {
      offGridPeriodCount += 1
      continue
    }

    const matchingPeriods = periodsByTime.get(period.time) ?? []
    matchingPeriods.push(period)
    periodsByTime.set(period.time, matchingPeriods)
  }

  const missingPeriodCount = expectedTimes.filter(
    time => !periodsByTime.has(time),
  ).length
  const duplicatePeriodCount = [...periodsByTime.values()].reduce(
    (count, matchingPeriods) => count + Math.max(0, matchingPeriods.length - 1),
    0,
  )
  const fieldValueCounts = Object.fromEntries(fields.map(field => [
    field,
    expectedTimes.filter(time => (
      periodsByTime.get(time)?.some(period => Number.isFinite(period[field]))
    )).length,
  ]))
  const fieldMissingValueCounts = Object.fromEntries(fields.map(field => [
    field,
    requiredHours - fieldValueCounts[field],
  ]))
  const completePeriodCount = expectedTimes.filter((time) => {
    const matchingPeriods = periodsByTime.get(time)

    return matchingPeriods?.length === 1
      && fields.every(field => Number.isFinite(matchingPeriods[0][field]))
  }).length
  const invalidTimestampCount = sourcePeriods.filter(
    period => !Number.isFinite(period?.time),
  ).length
  const complete = fields.length > 0
    && missingPeriodCount === 0
    && duplicatePeriodCount === 0
    && offGridPeriodCount === 0
    && invalidTimestampCount === 0
    && Object.values(fieldMissingValueCounts).every(count => count === 0)

  return {
    requiredHours,
    earliestExpectedTime,
    latestExpectedTime,
    expectedPeriodCount: requiredHours,
    periodCount: windowPeriods.length,
    completePeriodCount,
    missingPeriodCount,
    duplicatePeriodCount,
    offGridPeriodCount,
    invalidTimestampCount,
    fields,
    fieldValueCounts,
    fieldMissingValueCounts,
    complete,
  }
}

export function summarizeChartCoverage (periods, referenceTime, requiredHours) {
  return summarizeHourlyCoverage(
    periods,
    ["open", "max", "min", "close", "volume"],
    referenceTime,
    requiredHours,
  )
}

function summarizeStudyCoverage (
  study,
  referenceTime,
  requiredHours,
) {
  const fields = study?.fields && typeof study.fields === "object"
    ? Object.keys(study.fields)
    : []

  const coverage = summarizeHourlyCoverage(
    study?.periods,
    fields,
    referenceTime,
    requiredHours,
  )

  const duplicatePeriodCount = coverage.duplicatePeriodCount
  const invalidTimestampCount = Math.max(
    coverage.invalidTimestampCount,
    study?.coverage?.invalidTimestampCount ?? 0,
  )

  return {
    ...coverage,
    duplicatePeriodCount,
    invalidTimestampCount,
    complete: coverage.complete
      && duplicatePeriodCount === 0
      && invalidTimestampCount === 0,
    sourcePeriodCount: Number.isSafeInteger(study?.coverage?.sourcePeriodCount)
      ? study.coverage.sourcePeriodCount
      : Array.isArray(study?.periods) ? study.periods.length : 0,
  }
}

export function createResultBuilder () {
  const reasonCodes = []
  const reasons = []
  let retryable = false

  return {
    add (code, message, { canRetry = false } = {}) {
      reasonCodes.push(code)
      reasons.push(message)
      retryable ||= canRetry
    },
    build (coverage) {
      return {
        complete: reasonCodes.length === 0,
        retryable,
        reasonCodes,
        reasons,
        coverage,
      }
    },
  }
}

export function evaluateMetadata (coin, result) {
  for (const { field, label } of [
    { field: "circulatingSupply", label: "circulating supply" },
    { field: "marketCap", label: "market cap" },
    { field: "fullyDilutedValuation", label: "fully diluted valuation" },
  ]) {
    if (!Number.isFinite(coin[field]) || coin[field] <= 0) {
      result.add(
        `metadata:${field}_missing`,
        `Coin ${label} is missing`,
      )
    }
  }
}

export function evaluateIdentity (coin, chartInfo, result) {
  const market = coin.market

  if (market.baseCurrencyId !== coin.baseCurrencyId) {
    result.add(
      "market:identity_mismatch",
      `Market baseCurrencyId ${market.baseCurrencyId} does not match ${coin.baseCurrencyId}`,
    )
  }

  if (
    chartInfo?.baseCurrencyId
    && chartInfo.baseCurrencyId !== coin.baseCurrencyId
  ) {
    result.add(
      "chart:identity_mismatch",
      `Chart baseCurrencyId ${chartInfo.baseCurrencyId} does not match ${coin.baseCurrencyId}`,
    )
  }

  if (!chartInfo?.fullName) {
    result.add(
      "chart:symbol_missing",
      "Chart symbol is missing",
    )
  } else if (chartInfo.fullName !== market.tradingViewSymbol) {
    result.add(
      "chart:symbol_mismatch",
      `Chart symbol ${chartInfo.fullName} does not match ${market.tradingViewSymbol}`,
    )
  }
}

function evaluateHourlyCoverage (key, label, coverage, result) {
  if (coverage.fields.length === 0) {
    result.add(
      `${key}:missing_fields`,
      `${label} exposes no fields`,
    )
  }

  if (coverage.missingPeriodCount > 0) {
    result.add(
      `${key}:missing_hours`,
      `${label} is missing ${coverage.missingPeriodCount}/${coverage.requiredHours} required hours`,
    )
  }

  if (coverage.duplicatePeriodCount > 0) {
    result.add(
      `${key}:duplicate_hours`,
      `${label} contains ${coverage.duplicatePeriodCount} duplicate hourly periods`,
    )
  }

  if (coverage.offGridPeriodCount > 0) {
    result.add(
      `${key}:off_grid_hours`,
      `${label} contains ${coverage.offGridPeriodCount} periods outside the hourly grid`,
    )
  }

  if (coverage.invalidTimestampCount > 0) {
    result.add(
      `${key}:invalid_timestamps`,
      `${label} contains ${coverage.invalidTimestampCount} invalid timestamps`,
    )
  }

  const fieldsWithMissingValues = Object.entries(coverage.fieldMissingValueCounts)
    .filter(([, count]) => count > 0)
    .map(([field, count]) => `${field}=${count}`)

  if (fieldsWithMissingValues.length > 0) {
    result.add(
      `${key}:missing_values`,
      `${label} has missing numeric values: ${fieldsWithMissingValues.join(", ")}`,
    )
  }
}

export function evaluateChart (chartCoverage, result) {
  evaluateHourlyCoverage("ohlcv", "OHLCV", chartCoverage, result)
}

export function evaluateStudy (
  key,
  settledStudy,
  result,
  options,
) {
  if (!settledStudy) {
    result.add(
      `${key}:missing_result`,
      `${key} did not return a result`,
      { canRetry: true },
    )

    return {
      status: "missing",
    }
  }

  if (settledStudy.status === "rejected") {
    const error = getErrorMessage(settledStudy.reason)
    const unavailable = options.canClassifyRejectedStudyUnavailable

    result.add(
      `${key}:request_failed`,
      `${key} request failed: ${error}`,
      { canRetry: true },
    )

    return {
      status: "rejected",
      error,
      unavailable,
    }
  }

  if (settledStudy.status !== "fulfilled") {
    result.add(
      `${key}:invalid_result`,
      `${key} returned an invalid status`,
      { canRetry: true },
    )

    return {
      status: "invalid",
    }
  }

  const coverage = summarizeStudyCoverage(
    settledStudy.value,
    options.nowTimestamp,
    options.requiredHours,
  )
  const unavailable = options.canClassifyUnavailable
    && coverage.fields.length > 0
    && Object.values(coverage.fieldValueCounts).every(count => count === 0)

  evaluateHourlyCoverage(key, key, coverage, result)

  if (unavailable) {
    result.add(
      `${key}:unavailable`,
      `${key} has no numeric values in ${options.requiredHours} required hours`,
      { canRetry: true },
    )
  }

  return {
    status: "fulfilled",
    ...coverage,
    unavailable,
  }
}
