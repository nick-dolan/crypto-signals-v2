import fs from "node:fs/promises"
import path from "node:path"

import { isArray, isError, isObject, isString } from "../../helpers/utils.typed.js"

function isText (value) {
  return isString(value) && value.trim().length > 0
}

export async function readCoinDescriptions (coins, { readFile = fs.readFile } = {}) {
  try {
    const data = JSON.parse(await readFile(path.resolve(process.cwd(), "data", "coin-descriptions.json"), "utf8"))
    if (!isObject(data) || !isArray(data.coins)) {
      throw new Error("ожидается объект с массивом coins")
    }

    const requestedIds = new Set(coins.map(coin => coin?.baseCurrencyId).filter(isText))
    const descriptions = new Map()

    for (const coin of data.coins) {
      if (!isObject(coin) || !requestedIds.has(coin.baseCurrencyId)) {
        continue
      }
      if (descriptions.has(coin.baseCurrencyId)) {
        descriptions.set(coin.baseCurrencyId, null)
        console.warn(`⚠ Повторяющийся baseCurrencyId в data/coin-descriptions.json: ${coin.baseCurrencyId}; описание пропущено.`)
        continue
      }

      // Incomplete entries still reserve their ID so duplicates cannot silently replace them.
      descriptions.set(coin.baseCurrencyId, null)
      if (!isText(coin.description)) {
        continue
      }

      descriptions.set(coin.baseCurrencyId, {
        description: coin.description.trim(),
        sources: (isArray(coin.sources) ? coin.sources : [])
          .filter(source => isObject(source) && isText(source.url))
          .map(source => ({
            url: source.url.trim(),
            ...(isText(source.checkedAt) ? { checkedAt: source.checkedAt.trim() } : {}),
          })),
      })
    }

    return Object.fromEntries([...descriptions].filter(([, description]) => description !== null))
  } catch (error) {
    if (error?.code !== "ENOENT") {
      console.warn(`⚠ Не удалось загрузить data/coin-descriptions.json: ${isError(error) ? error.message : "неизвестная ошибка"}`)
    }
    return {}
  }
}
