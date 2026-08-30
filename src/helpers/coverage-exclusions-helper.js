import fs from "node:fs/promises"
import path from "node:path"

import { getRequiredString, toIsoTimestamp } from "./normalization-helper.js"

const COVERAGE_EXCLUSIONS_VERSION = 1
const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1_000

export const COVERAGE_EXCLUSION_RECHECK_DAYS = 30
export const COVERAGE_EXCLUSIONS_FILE_PATH = path.resolve(
  process.cwd(),
  "data",
  "coverage-exclusions.json",
)

function createEmptyCoverageExclusions () {
  return {
    version: COVERAGE_EXCLUSIONS_VERSION,
    updatedAt: null,
    coins: [],
  }
}

function normalizeOptionalTimestamp (value, name) {
  return value === null || value === undefined
    ? null
    : toIsoTimestamp(value, name)
}

function normalizeUnavailableMetrics (value, name) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${name} must be a non-empty array`)
  }

  return [...new Set(value.map((metric, index) => (
    getRequiredString(metric, `${name}[${index}]`)
  )))].sort()
}

function normalizeCoverageExclusion (value, index) {
  const name = `Coverage exclusion at index ${index}`

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must be an object`)
  }

  const excludedAt = toIsoTimestamp(value.excludedAt, `${name} excludedAt`)
  const recheckAfter = toIsoTimestamp(value.recheckAfter, `${name} recheckAfter`)

  if (new Date(recheckAfter).getTime() <= new Date(excludedAt).getTime()) {
    throw new Error(`${name} recheckAfter must be later than excludedAt`)
  }

  return {
    baseCurrencyId: getRequiredString(value.baseCurrencyId, `${name} baseCurrencyId`),
    symbol: getRequiredString(value.symbol, `${name} symbol`),
    name: getRequiredString(value.name, `${name} name`),
    tradingViewSymbol: getRequiredString(
      value.tradingViewSymbol,
      `${name} tradingViewSymbol`,
    ),
    marketSymbol: getRequiredString(value.marketSymbol, `${name} marketSymbol`),
    reason: "required_metrics_unavailable",
    unavailableMetrics: normalizeUnavailableMetrics(
      value.unavailableMetrics,
      `${name} unavailableMetrics`,
    ),
    excludedAt,
    recheckAfter,
  }
}

export function normalizeCoverageExclusions (value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Coverage exclusions must be an object")
  }

  if (value.version !== COVERAGE_EXCLUSIONS_VERSION) {
    throw new Error(
      `Coverage exclusions version must be ${COVERAGE_EXCLUSIONS_VERSION}`,
    )
  }

  if (!Array.isArray(value.coins)) {
    throw new Error("Coverage exclusions coins must be an array")
  }

  const coins = value.coins.map(normalizeCoverageExclusion)
  const baseCurrencyIds = new Set()

  for (const coin of coins) {
    if (baseCurrencyIds.has(coin.baseCurrencyId)) {
      throw new Error(
        `Coverage exclusions contain duplicate baseCurrencyId: ${coin.baseCurrencyId}`,
      )
    }

    baseCurrencyIds.add(coin.baseCurrencyId)
  }

  return {
    version: COVERAGE_EXCLUSIONS_VERSION,
    updatedAt: normalizeOptionalTimestamp(
      value.updatedAt,
      "Coverage exclusions updatedAt",
    ),
    coins: coins.sort((first, second) => (
      first.baseCurrencyId.localeCompare(second.baseCurrencyId)
    )),
  }
}

export async function readCoverageExclusions ({
  filePath = COVERAGE_EXCLUSIONS_FILE_PATH,
} = {}) {
  try {
    const rawData = await fs.readFile(filePath, "utf-8")

    return normalizeCoverageExclusions(JSON.parse(rawData))
  } catch (error) {
    if (error?.code === "ENOENT") {
      return createEmptyCoverageExclusions()
    }

    throw error
  }
}

function getNow (value) {
  const now = new Date(value)

  if (Number.isNaN(now.getTime())) {
    throw new Error("Coverage exclusions now must be a valid timestamp")
  }

  return now
}

export function getActiveCoverageExclusionIds (
  exclusions,
  { now = new Date() } = {},
) {
  const normalized = normalizeCoverageExclusions(exclusions)
  const currentTime = getNow(now).getTime()

  return new Set(normalized.coins
    .filter(coin => new Date(coin.recheckAfter).getTime() > currentTime)
    .map(coin => coin.baseCurrencyId))
}

function createCoverageExclusion (coin, now, recheckDays) {
  if (!coin || typeof coin !== "object" || Array.isArray(coin)) {
    throw new Error("Excluded coin must be an object")
  }

  if (!Number.isSafeInteger(recheckDays) || recheckDays <= 0) {
    throw new Error("Coverage exclusion recheckDays must be a positive integer")
  }

  const excludedAt = now.toISOString()
  const recheckAfter = new Date(
    now.getTime() + recheckDays * MILLISECONDS_PER_DAY,
  ).toISOString()

  return normalizeCoverageExclusion({
    baseCurrencyId: coin.baseCurrencyId,
    symbol: coin.symbol,
    name: coin.name,
    tradingViewSymbol: coin.tradingViewSymbol,
    marketSymbol: coin.market?.tradingViewSymbol,
    unavailableMetrics: coin.unavailableMetrics,
    excludedAt,
    recheckAfter,
  }, 0)
}

async function writeCoverageExclusions (exclusions, filePath) {
  const directory = path.dirname(filePath)
  const temporaryPath = `${filePath}.${process.pid}.tmp`

  await fs.mkdir(directory, { recursive: true })

  try {
    await fs.writeFile(
      temporaryPath,
      `${JSON.stringify(exclusions, null, 2)}\n`,
      "utf-8",
    )
    await fs.rename(temporaryPath, filePath)
  } catch (error) {
    await fs.rm(temporaryPath, { force: true })
    throw error
  }
}

export async function updateCoverageExclusions ({
  checkedBaseCurrencyIds,
  excludedCoins,
  filePath = COVERAGE_EXCLUSIONS_FILE_PATH,
  now = new Date(),
  recheckDays = COVERAGE_EXCLUSION_RECHECK_DAYS,
}) {
  if (!Array.isArray(checkedBaseCurrencyIds)) {
    throw new Error("checkedBaseCurrencyIds must be an array")
  }

  if (!Array.isArray(excludedCoins)) {
    throw new Error("excludedCoins must be an array")
  }

  const currentTime = getNow(now)
  const current = await readCoverageExclusions({ filePath })
  const checkedIds = new Set(checkedBaseCurrencyIds.map((baseCurrencyId, index) => (
    getRequiredString(baseCurrencyId, `checkedBaseCurrencyIds[${index}]`)
  )))
  const coinsById = new Map(current.coins
    .filter(coin => !checkedIds.has(coin.baseCurrencyId))
    .map(coin => [coin.baseCurrencyId, coin]))

  for (const coin of excludedCoins) {
    const exclusion = createCoverageExclusion(coin, currentTime, recheckDays)
    coinsById.set(exclusion.baseCurrencyId, exclusion)
  }

  const updated = normalizeCoverageExclusions({
    version: COVERAGE_EXCLUSIONS_VERSION,
    updatedAt: currentTime.toISOString(),
    coins: [...coinsById.values()],
  })

  await writeCoverageExclusions(updated, filePath)

  return {
    filePath,
    excludedNowCount: excludedCoins.length,
    activeCount: getActiveCoverageExclusionIds(updated, { now: currentTime }).size,
    registry: updated,
  }
}
