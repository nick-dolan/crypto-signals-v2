import fs from "node:fs/promises"
import path from "node:path"

import { isArray, isFinite, isString } from "./utils.typed.js"

export async function readCoinPeers (
  filePath = path.resolve(process.cwd(), "data", "coin-peers.json"),
) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"))
  } catch (error) {
    if (error.code === "ENOENT") {
      return null
    }
    throw error
  }
}

export function indexCoinPeers (registry) {
  if (
    registry?.schemaVersion !== 1
    || !isString(registry.generatedAt)
    || !isFinite(Date.parse(registry.generatedAt))
    || !isArray(registry.universe?.coins)
    || !isArray(registry.relations)
  ) {
    throw new Error("Invalid coin peers registry: expected schemaVersion 1, generatedAt, coins and relations")
  }

  const coins = new Map()
  const neighbors = new Map()

  for (const coin of registry.universe.coins) {
    const id = coin?.baseCurrencyId
    if (
      !isString(id) || !id.trim() || coins.has(id)
      || !["reviewed", "insufficient_evidence", "not_reviewed"].includes(coin.reviewStatus)
    ) {
      throw new Error("Invalid coin peers registry: coin IDs must be unique and have a review status")
    }
    coins.set(id, coin)
    neighbors.set(id, new Map())
  }

  for (const relation of registry.relations) {
    if (!isArray(relation?.coinIds) || relation.coinIds.length !== 2) {
      throw new Error("Invalid coin peers registry: a relation must contain two coin IDs")
    }
    const [first, second] = relation.coinIds
    if (
      first === second
      || coins.get(first)?.reviewStatus !== "reviewed"
      || coins.get(second)?.reviewStatus !== "reviewed"
      || neighbors.get(first).has(second)
      || !["competitor", "adjacent"].includes(relation.type)
      || ![relation.basis, relation.caveat].every(value => isString(value) && value.trim())
    ) {
      throw new Error(`Invalid coin peers relation: ${first} / ${second}`)
    }
    neighbors.get(first).set(second, relation)
    neighbors.get(second).set(first, relation)
  }

  return { coins, neighbors, generatedAt: registry.generatedAt }
}
