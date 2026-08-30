import fs from "node:fs/promises"
import path from "node:path"

import { getRequiredString, toIsoTimestamp } from "./normalization-helper.js"

function normalizeCoverageExclusionIdentity (value, index, label) {
  const fieldName = `${label} at index ${index}`

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
  }
}

function normalizeCoverageExclusion (value, index) {
  const exclusion = normalizeCoverageExclusionIdentity(
    value,
    index,
    "Coverage exclusion",
  )

  return {
    ...exclusion,
    recheckAfter: toIsoTimestamp(
      value.recheckAfter,
      `Coverage exclusion at index ${index} recheckAfter`,
    ),
  }
}

function normalizeExclusions (value, label, normalizeExclusion) {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array`)
  }

  const exclusions = value.map(normalizeExclusion)
  const baseCurrencyIds = new Set()

  for (const exclusion of exclusions) {
    if (baseCurrencyIds.has(exclusion.baseCurrencyId)) {
      throw new Error(
        `${label} contain duplicate baseCurrencyId: ${exclusion.baseCurrencyId}`,
      )
    }

    baseCurrencyIds.add(exclusion.baseCurrencyId)
  }

  return exclusions.sort((first, second) => (
    first.baseCurrencyId.localeCompare(second.baseCurrencyId)
  ))
}

export function normalizeCoverageExclusions (value) {
  return normalizeExclusions(
    value,
    "Coverage exclusions",
    normalizeCoverageExclusion,
  )
}

export function normalizePermanentCoverageExclusions (value) {
  return normalizeExclusions(
    value,
    "Permanent coverage exclusions",
    (exclusion, index) => normalizeCoverageExclusionIdentity(
      exclusion,
      index,
      "Permanent coverage exclusion",
    ),
  )
}

export async function readCoverageExclusions ({
  filePath = path.resolve(process.cwd(), "data", "coverage-exclusions.json"),
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

export async function readPermanentCoverageExclusions ({
  filePath = path.resolve(
    process.cwd(),
    "data",
    "permanent-coverage-exclusions.json",
  ),
} = {}) {
  const rawData = await fs.readFile(filePath, "utf-8")

  return normalizePermanentCoverageExclusions(JSON.parse(rawData))
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

export function getPermanentCoverageExclusionIds (exclusions) {
  return new Set(normalizePermanentCoverageExclusions(exclusions)
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
      now.getTime() + recheckDays * (24 * 60 * 60 * 1_000),
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
  filePath = path.resolve(process.cwd(), "data", "coverage-exclusions.json"),
  now = new Date(),
  recheckDays = 30,
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
