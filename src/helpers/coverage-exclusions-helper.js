import fs from "node:fs/promises"
import path from "node:path"

import { getRequiredString, toIsoTimestamp } from "./normalization-helper.js"

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1_000

export const COVERAGE_EXCLUSION_RECHECK_DAYS = 30
export const COVERAGE_EXCLUSIONS_FILE_PATH = path.resolve(
  process.cwd(),
  "data",
  "coverage-exclusions.json",
)

function normalizeCoverageExclusion (value, index) {
  const fieldName = `Coverage exclusion at index ${index}`

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${fieldName} must be an object`)
  }

  return {
    symbol: getRequiredString(value.symbol, `${fieldName} symbol`),
    name: getRequiredString(value.name, `${fieldName} name`),
    baseCurrencyId: getRequiredString(
      value.baseCurrencyId,
      `${fieldName} baseCurrencyId`,
    ),
    recheckAfter: toIsoTimestamp(
      value.recheckAfter,
      `${fieldName} recheckAfter`,
    ),
  }
}

export function normalizeCoverageExclusions (value) {
  if (!Array.isArray(value)) {
    throw new Error("Coverage exclusions must be an array")
  }

  const exclusions = value.map(normalizeCoverageExclusion)
  const baseCurrencyIds = new Set()

  for (const exclusion of exclusions) {
    if (baseCurrencyIds.has(exclusion.baseCurrencyId)) {
      throw new Error(
        `Coverage exclusions contain duplicate baseCurrencyId: ${exclusion.baseCurrencyId}`,
      )
    }

    baseCurrencyIds.add(exclusion.baseCurrencyId)
  }

  return exclusions.sort((first, second) => (
    first.baseCurrencyId.localeCompare(second.baseCurrencyId)
  ))
}

export async function readCoverageExclusions ({
  filePath = COVERAGE_EXCLUSIONS_FILE_PATH,
} = {}) {
  try {
    const rawData = await fs.readFile(filePath, "utf-8")

    return normalizeCoverageExclusions(JSON.parse(rawData))
  } catch (error) {
    if (error?.code === "ENOENT") {
      return []
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
  const currentTime = getNow(now).getTime()

  return new Set(normalizeCoverageExclusions(exclusions)
    .filter(exclusion => (
      new Date(exclusion.recheckAfter).getTime() > currentTime
    ))
    .map(exclusion => exclusion.baseCurrencyId))
}

function createCoverageExclusion (coin, now, recheckDays) {
  if (!Number.isSafeInteger(recheckDays) || recheckDays <= 0) {
    throw new Error("Coverage exclusion recheckDays must be a positive integer")
  }

  return normalizeCoverageExclusion({
    symbol: coin?.symbol,
    name: coin?.name,
    baseCurrencyId: coin?.baseCurrencyId,
    recheckAfter: new Date(
      now.getTime() + recheckDays * MILLISECONDS_PER_DAY,
    ).toISOString(),
  }, 0)
}

async function writeCoverageExclusions (exclusions, filePath) {
  const temporaryPath = `${filePath}.${process.pid}.tmp`

  await fs.mkdir(path.dirname(filePath), { recursive: true })

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
  const exclusionsById = new Map(current
    .filter(exclusion => !checkedIds.has(exclusion.baseCurrencyId))
    .map(exclusion => [exclusion.baseCurrencyId, exclusion]))

  for (const coin of excludedCoins) {
    const exclusion = createCoverageExclusion(coin, currentTime, recheckDays)
    exclusionsById.set(exclusion.baseCurrencyId, exclusion)
  }

  const updated = normalizeCoverageExclusions([...exclusionsById.values()])

  await writeCoverageExclusions(updated, filePath)

  return {
    filePath,
    excludedNowCount: excludedCoins.length,
    activeCount: getActiveCoverageExclusionIds(updated, { now: currentTime }).size,
    registry: updated,
  }
}
