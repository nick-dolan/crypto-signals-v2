import fs from "node:fs/promises"
import path from "node:path"
import { sleep } from "radash"
import { indexBinanceMarkets } from "../../api/coingecko/index-binance-markets.js"
import { requestCoinGeckoJson } from "../../api/coingecko/request.js"
import { writeDataJson } from "../../helpers/fs-helper.js"
import { getRequiredString, toIsoTimestamp } from "../../helpers/normalization-helper.js"
import { isArray, isError, isObject } from "../../helpers/utils.typed.js"
import { describeCoin } from "./describe-coin.js"

function getCoinIds (coins, label) {
  if (!isArray(coins)) {
    throw new Error(`${label} must contain a coins array`)
  }

  const ids = new Set()

  for (const coin of coins) {
    const id = getRequiredString(coin?.baseCurrencyId, `${label} baseCurrencyId`)

    if (id !== coin.baseCurrencyId || ids.has(id)) {
      throw new Error(`${label} contains an invalid or duplicate baseCurrencyId: ${id}`)
    }

    ids.add(id)
  }

  return ids
}

async function readRegistry (readFile) {
  try {
    return JSON.parse(await readFile(
      path.resolve(process.cwd(), "data", "coin-descriptions.json"),
      "utf8",
    ))
  } catch (error) {
    if (error?.code === "ENOENT") {
      return {
        schemaVersion: 1,
        language: "ru",
        sourceNotes: "Накопительный справочник. Новые описания составлены по страницам, прочитанным через Tavily; checkedAt — дата получения текста, а не обновления проекта. universe указывает последний список, из которого добавлялись монеты.",
        coins: [],
      }
    }

    throw new Error("Cannot read coin-descriptions.json; leaving the registry unchanged", { cause: error })
  }
}

async function loadCoinGeckoDetails (coin, coinIdsByMarket, { request, pause, onWarning }) {
  const coinId = coinIdsByMarket.get(coin.market?.tradingViewSymbol)

  if (!coinId) {
    return null
  }

  try {
    await pause(2_000)
    const details = await request(`/coins/${encodeURIComponent(coinId)}`, {
      searchParams: {
        localization: false,
        tickers: false,
        market_data: false,
        community_data: false,
        developer_data: false,
        sparkline: false,
      },
    })

    if (details?.id !== coinId) {
      throw new Error(`CoinGecko response ID does not match ${coinId}`)
    }

    return details
  } catch (error) {
    onWarning(`⚠ CoinGecko context for ${coin.symbol}: ${isError(error) ? error.message : "Unknown error"}; continuing with web research`)
    return null
  }
}

export async function updateCoinDescriptions (
  sourceUniverse,
  systemPrompt,
  {
    readFile = fs.readFile,
    saveRegistry = data => writeDataJson("coin-descriptions.json", data),
    request = requestCoinGeckoJson,
    requestTavily,
    callAgent,
    pause = sleep,
    onProgress = () => {},
    onWarning = message => console.warn(message),
  } = {},
) {
  getCoinIds(sourceUniverse?.coins, "Step 1 universe")
  const registry = await readRegistry(readFile)

  if (!isObject(registry) || registry.schemaVersion !== 1 || registry.language !== "ru") {
    throw new Error("Invalid coin-descriptions.json schema; leaving the registry unchanged")
  }

  const knownIds = getCoinIds(registry.coins, "coin-descriptions.json")
  const missing = sourceUniverse.coins.filter(coin => !knownIds.has(coin.baseCurrencyId))
  const result = { missingCount: missing.length, addedCount: 0, failedCount: 0, coinCount: registry.coins.length }

  if (!missing.length) {
    return result
  }

  const prompt = getRequiredString(systemPrompt, "Coin description system prompt")
  const sourceGeneratedAt = toIsoTimestamp(sourceUniverse.generatedAt, "Step 1 generatedAt")
  let coinIdsByMarket = new Map()

  try {
    const futures = await request("/derivatives/exchanges/binance_futures", {
      searchParams: { include_tickers: "unexpired" },
    })
    coinIdsByMarket = indexBinanceMarkets(futures).coinIdsByMarket
  } catch (error) {
    onWarning(`⚠ CoinGecko context unavailable: ${isError(error) ? error.message : "Unknown error"}; continuing with web research`)
  }

  const additions = []

  for (const [index, coin] of missing.entries()) {
    try {
      const details = await loadCoinGeckoDetails(coin, coinIdsByMarket, { request, pause, onWarning })
      const { description, sources } = await describeCoin(coin, details, prompt, { callAgent, requestTavily })
      additions.push({
        baseCurrencyId: coin.baseCurrencyId,
        symbol: coin.symbol,
        name: coin.name,
        description,
        sources,
      })
    } catch (error) {
      result.failedCount += 1
      onWarning(`⚠ Description ${coin.symbol} (${coin.baseCurrencyId}): ${isError(error) ? error.message : "Unknown error"}; will retry next run`)
    }

    onProgress({ index: index + 1, total: missing.length, addedCount: additions.length })
  }

  if (additions.length) {
    // The universe is the latest source, not the contents of this cumulative registry.
    const coins = [...registry.coins, ...additions]
    await saveRegistry({
      ...registry,
      generatedAt: new Date().toISOString(),
      universe: {
        ...registry.universe,
        sourcePath: "tmp/step1-crypto-universe.json",
        sourceGeneratedAt,
      },
      coinCount: coins.length,
      coins,
    })
    result.addedCount = additions.length
    result.coinCount = coins.length
  }

  return result
}
