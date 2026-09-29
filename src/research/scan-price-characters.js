import { randomUUID } from "node:crypto"
import { constants } from "node:fs"
import fs from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { parseArgs } from "node:util"

import { fetchTradingViewChartPeriods } from "../api/tradingview/chart-candles.js"
import { connectTradingView, disconnectTradingView } from "../api/tradingview/client.js"
import { isArray, isError, isInt, isObject, isString } from "../helpers/utils.typed.js"
import { comparePriceCharacters } from "./compare-price-characters.js"
import { buildPriceCharacterReport, preparePriceCharacterPeriods } from "./price-character.js"
import { renderPriceComparisonHtml, renderPriceComparisonMarkdown } from "./render-price-comparison.js"

async function readOptionalJson (file) {
  try {
    const data = JSON.parse(await fs.readFile(file, "utf8"))
    if (!isObject(data)) {
      throw new Error(`Expected a JSON object in ${file}`)
    }
    return data
  } catch (error) {
    if (error.code === "ENOENT") {
      return null
    }
    throw error
  }
}

async function freezeJson (file, source) {
  const existing = await readOptionalJson(file)
  if (existing) {
    return existing
  }
  const temporary = `${file}.${randomUUID()}.tmp`
  try {
    await fs.copyFile(source, temporary, constants.COPYFILE_EXCL)
    await readOptionalJson(temporary)
    try {
      await fs.link(temporary, file)
    } catch (error) {
      if (error.code !== "EEXIST") {
        throw error
      }
    }
    return await readOptionalJson(file)
  } finally {
    await fs.rm(temporary, { force: true })
  }
}

async function writeJson (file, data) {
  const temporary = `${file}.${process.pid}.tmp`
  await fs.writeFile(temporary, JSON.stringify(data), "utf8")
  await fs.rename(temporary, file)
}

function universeCoins (universe) {
  if (!isArray(universe?.coins) || !universe.coins.length) {
    throw new Error("A nonempty crypto universe is required")
  }
  const coins = universe.coins.map(coin => ({
    baseCurrencyId: coin.baseCurrencyId,
    symbol: coin.symbol,
    name: coin.name,
    marketSymbol: coin.market?.tradingViewSymbol,
    rank: coin.rank,
  }))
  if (coins.some(coin => !isString(coin.baseCurrencyId) || !/^[A-Za-z0-9_-]+$/.test(coin.baseCurrencyId)
    || !isString(coin.symbol) || !coin.symbol.trim()
    || !isString(coin.marketSymbol) || !/^BINANCE:[A-Z0-9_]+USDT\.P$/.test(coin.marketSymbol))) {
    throw new Error("Universe requires safe unique IDs and Binance USDT perpetual symbols")
  }
  if (new Set(coins.map(coin => coin.baseCurrencyId)).size !== coins.length
    || new Set(coins.map(coin => coin.marketSymbol)).size !== coins.length) {
    throw new Error("Duplicate coin ID or market in the universe")
  }
  return coins
}

function validateSnapshot (snapshot, coin, reference) {
  if (snapshot?.source !== "tradingview" || snapshot.timeframe !== "15m"
    || snapshot.symbol !== coin.symbol || snapshot.marketSymbol !== coin.marketSymbol
    || snapshot.endTime !== reference.endTime || snapshot.analysisDays !== reference.analysisDays) {
    throw new Error("Cached snapshot does not match the coin and frozen reference dates")
  }
  return preparePriceCharacterPeriods(snapshot.periods, reference.endTime, reference.analysisDays)
}

function toProfile (snapshot, coin, reference) {
  validateSnapshot(snapshot, coin, reference)
  return { ...buildPriceCharacterReport(snapshot), ...coin }
}

function reason (error) {
  return isError(error) ? error.message : String(error)
}

export async function runPriceCharacterScan ({
  directory = "reports/price-character",
  referencePath = "reports/prove-15m/candles.json",
  universePath = "tmp/step1-crypto-universe.json",
  limit = 50,
  cached = false,
  retryFailed = false,
  connect = connectTradingView,
  disconnect = disconnectTradingView,
  fetchPeriods = fetchTradingViewChartPeriods,
  onProgress = () => {},
} = {}) {
  if (!isInt(limit) || limit <= 0 || (cached && retryFailed)) {
    throw new Error("limit must be positive; --cached and --retry-failed cannot be combined")
  }
  await Promise.all(["", "candles", "results"].map(part => fs.mkdir(path.join(directory, part), { recursive: true })))
  const referenceSnapshot = await freezeJson(path.join(directory, "reference.json"), referencePath)
  const universe = await freezeJson(path.join(directory, "universe.json"), universePath)
  const coins = universeCoins(universe)
  const referenceCoin = coins.find(coin => coin.symbol === "PROVE" && coin.marketSymbol === "BINANCE:PROVEUSDT.P")
  if (!referenceCoin) {
    throw new Error("PROVE must be present in the frozen universe")
  }
  const reference = toProfile(referenceSnapshot, referenceCoin, referenceSnapshot)
  const profiles = new Map([[referenceCoin.baseCurrencyId, reference]])
  const rejected = new Map()
  const queue = []

  for (const coin of coins.filter(coin => coin.baseCurrencyId !== referenceCoin.baseCurrencyId)) {
    const resultPath = path.join(directory, "results", `${coin.baseCurrencyId}.json`)
    try {
      // A retry can commit its candles before updating the older error checkpoint.
      const snapshot = await readOptionalJson(path.join(directory, "candles", `${coin.baseCurrencyId}.json`))
      if (snapshot) {
        profiles.set(coin.baseCurrencyId, toProfile(snapshot, coin, referenceSnapshot))
        continue
      }
      const previous = await readOptionalJson(resultPath)
      if (previous?.status === "error") {
        rejected.set(coin.baseCurrencyId, { coin, reason: previous.reason })
        if (retryFailed) {
          queue.push(coin)
        }
      } else {
        queue.push(coin)
      }
    } catch (error) {
      rejected.set(coin.baseCurrencyId, { coin, reason: reason(error) })
      await writeJson(resultPath, { coin, status: "error", reason: reason(error), updatedAt: new Date().toISOString() })
      if (retryFailed) {
        queue.push(coin)
      }
    }
  }

  const work = cached ? [] : queue.slice(0, limit)
  onProgress({ status: "resume", loaded: profiles.size, failed: rejected.size, queued: work.length })
  if (work.length) {
    let cursor = 0
    let completed = 0
    let stopped = false
    try {
      const client = await connect()
      const workers = await Promise.allSettled(Array.from({ length: Math.min(3, work.length) }, async () => {
        try {
          while (!stopped && cursor < work.length && client.isOpen !== false) {
            const coin = work[cursor++]
            let snapshot, profile, result
            try {
              const periods = await fetchPeriods(client, {
                symbol: coin.marketSymbol,
                timeframe: "15",
                range: referenceSnapshot.analysisDays * 96 + 98,
                to: referenceSnapshot.endTime - 1,
                timeoutMs: 45_000,
                settleDelayMs: 1_000,
              })
              snapshot = {
                source: "tradingview",
                symbol: coin.symbol,
                marketSymbol: coin.marketSymbol,
                timeframe: "15m",
                collectedAt: new Date().toISOString(),
                endTime: referenceSnapshot.endTime,
                requestedDays: referenceSnapshot.analysisDays,
                analysisDays: referenceSnapshot.analysisDays,
                periods: preparePriceCharacterPeriods(periods, referenceSnapshot.endTime, referenceSnapshot.analysisDays),
              }
              profile = toProfile(snapshot, coin, referenceSnapshot)
            } catch (error) {
              rejected.set(coin.baseCurrencyId, { coin, reason: reason(error) })
              result = { coin, status: "error", reason: reason(error), updatedAt: new Date().toISOString() }
            }
            if (profile) {
              await writeJson(path.join(directory, "candles", `${coin.baseCurrencyId}.json`), snapshot)
              profiles.set(coin.baseCurrencyId, profile)
              rejected.delete(coin.baseCurrencyId)
              result = { coin, status: "ok", updatedAt: snapshot.collectedAt }
            }
            await writeJson(path.join(directory, "results", `${coin.baseCurrencyId}.json`), result)
            onProgress({ ...result, completed: ++completed, total: work.length })
          }
        } catch (error) {
          stopped = true
          throw error
        }
      }))
      const failed = workers.find(worker => worker.status === "rejected")
      if (failed) {
        throw failed.reason
      }
    } finally {
      await disconnect()
    }
  }

  const report = comparePriceCharacters({
    reference,
    profiles: [...profiles.values()].filter(profile => profile.baseCurrencyId !== referenceCoin.baseCurrencyId),
    universeGeneratedAt: universe.generatedAt,
    universeCount: coins.length,
    rejected: [...rejected.values()].sort((first, second) => first.coin.rank - second.coin.rank),
    pending: coins.filter(coin => !profiles.has(coin.baseCurrencyId) && !rejected.has(coin.baseCurrencyId)),
  })
  const charts = await Promise.all([...new Set([reference.baseCurrencyId, ...report.closest, ...report.calmer])].map(async (id) => {
    const coin = coins.find(coin => coin.baseCurrencyId === id)
    const snapshot = id === reference.baseCurrencyId
      ? referenceSnapshot
      : await readOptionalJson(path.join(directory, "candles", `${id}.json`))
    const periods = validateSnapshot(snapshot, coin, referenceSnapshot)
    return { ...coin, previousClose: periods[96].close, candles: periods.slice(97) }
  }))
  const html = await renderPriceComparisonHtml(report, charts)
  await writeJson(path.join(directory, "report.json"), report)
  await Promise.all([
    fs.writeFile(path.join(directory, "report.md"), renderPriceComparisonMarkdown(report), "utf8"),
    fs.writeFile(path.join(directory, "report.html"), html, "utf8"),
  ])
  return report
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { values } = parseArgs({ options: {
      "cached": { type: "boolean", default: false },
      "retry-failed": { type: "boolean", default: false },
      "limit": { type: "string", default: "50" },
      "directory": { type: "string", default: "reports/price-character" },
    } })
    const report = await runPriceCharacterScan({
      directory: values.directory,
      limit: Number(values.limit),
      cached: values.cached,
      retryFailed: values["retry-failed"],
      onProgress: (event) => {
        if (event.status === "resume") {
          console.log(`Cached: ${event.loaded}; rejected: ${event.failed}; downloading this batch: ${event.queued}`)
        } else {
          console.log(`${event.completed}/${event.total} ${event.coin.symbol}: ${event.status}${event.reason ? ` — ${event.reason}` : ""}`)
        }
      },
    })
    console.log("Coverage:", report.coverage)
    for (const [label, ids] of [["Closest to PROVE", report.closest], ["Fewer outliers", report.calmer]]) {
      console.log(label)
      console.table(ids.map((id) => {
        const entry = report.candidates.find(entry => entry.baseCurrencyId === id)
        const month = entry.profile.windows.find(window => window.days === 30)
        return { symbol: entry.symbol, distance: entry.distance, spikeRate30d: month.spikeRatePct, medianRange30d: month.medianRangePct }
      }))
    }
    console.log(`Saved ${values.directory}/report.{json,md,html}. Pending: ${report.pending.length}; failed: ${report.rejected.length}.`)
  } catch (error) {
    console.error("Price character scan failed:", reason(error))
    process.exitCode = 1
  }
}
