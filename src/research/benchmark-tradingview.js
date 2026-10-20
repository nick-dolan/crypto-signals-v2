import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { performance } from "node:perf_hooks"
import { pathToFileURL } from "node:url"
import { parseArgs } from "node:util"
import { parallel } from "radash"

import { fetchTradingViewChartStudies } from "../api/tradingview/chart-studies.js"
import { connectTradingView, disconnectTradingView } from "../api/tradingview/client.js"
import { isError, isFinite, isSafeInteger, isString } from "../helpers/utils.typed.js"
import { createBootstrapDataRelativePath, createCoinDataCoverageChecker } from "../steps/step2-data-bootstrap/check-coin-data-coverage.js"
import { getClosedHourlyPeriods, normalizeSourceCoinList } from "../steps/step2-data-bootstrap/data-coverage-helpers.js"

function errorMessage (error) {
  let message = isError(error) ? error.message : String(error)
  for (const name of ["TV_SESSIONID", "TV_SESSIONID_SIGN"]) {
    const secret = process.env[name]?.trim()
    if (secret) {
      message = message.replaceAll(secret, "[redacted]")
    }
  }
  return message
    .replace(/\beyJ[\w-]+\.[\w-]+\.[\w-]+\b/g, "[redacted]")
    .replace(/((?:sessionid(?:_sign)?|authorization|token|signature)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}]+)/gi, "$1[redacted]")
}

function isLimitError (message) {
  return /\b(?:429|limit(?:s|ed|ing)?|quota|protocol|critical)\b|too many|rate.?limit/i.test(message)
}

async function writeJson (file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8")
  return file
}

function fingerprint (periods) {
  const hash = value => createHash("sha256").update(JSON.stringify(value)).digest("hex")
  return {
    periodCount: periods.length,
    firstTime: periods[0]?.time ?? null,
    lastTime: periods.at(-1)?.time ?? null,
    gridHash: hash(periods.map(period => period.time)),
    valuesHash: hash(periods),
  }
}

function compareResults (results, baseline) {
  const differences = []
  for (const [index, result] of results.entries()) {
    const previous = baseline.results[index]
    const add = (source, reason) => differences.push({ symbol: result.symbol, source, reason })
    if (previous.complete && !result.complete) {
      add("coin", "Previously accepted coin was rejected")
    }
    if (previous.coverage?.social.status === "available" && result.coverage?.social.status !== "available") {
      add("social", "Social availability degraded")
    }
    for (const [key, previousCoverage] of Object.entries(previous.coverage?.studies ?? {})) {
      const current = result.coverage?.studies[key]
      if (previousCoverage.status === "fulfilled" && current?.status !== "fulfilled") {
        add(key, "Study request now fails")
      } else if (current?.completePeriodCount < previousCoverage.completePeriodCount) {
        add(key, "Fewer complete hours than the baseline")
      }
    }
    for (const [key, previousFingerprint] of Object.entries(previous.saved ?? {})) {
      if (result.saved?.[key]?.gridHash !== previousFingerprint.gridHash) {
        add(key, "Saved hourly grid differs from the baseline")
      }
    }
  }
  return differences
}

export async function runTradingViewBenchmark (
  { directory, concurrency, count, baseline } = {},
  {
    connect = connectTradingView,
    disconnect = disconnectTradingView,
    fetchChartStudies = fetchTradingViewChartStudies,
  } = {},
) {
  if (!isString(directory) || !directory.trim()) {
    throw new Error("--directory is required")
  }
  if (!isSafeInteger(concurrency) || concurrency < 1) {
    throw new Error("--concurrency must be a positive safe integer")
  }
  if (count !== undefined && (!isSafeInteger(count) || count < 1)) {
    throw new Error("--count must be a positive safe integer")
  }

  const root = path.resolve(directory)
  const [sourceCoinList, reference, previous] = await Promise.all([
    fs.readFile(path.join(root, "inputs", "step1-coin-list.json"), "utf8").then(JSON.parse),
    fs.readFile(path.join(root, "inputs", "step3-market-context.json"), "utf8").then(JSON.parse),
    baseline ? fs.readFile(baseline, "utf8").then(JSON.parse) : null,
  ])
  const nowTimestamp = Date.parse(reference.collectedAt) / 1_000
  if (!isFinite(nowTimestamp)) {
    throw new Error("Frozen collectedAt is required")
  }
  const { candidates } = normalizeSourceCoinList(sourceCoinList)
  const coins = [...candidates].sort((first, second) => first.rank - second.rank).slice(0, count)
  if (count !== undefined && coins.length !== count) {
    throw new Error(`Requested ${count} coins; only ${coins.length} are available`)
  }
  if (previous && (previous.nowTimestamp !== nowTimestamp
    || JSON.stringify(previous.results.map(result => result.baseCurrencyId)) !== JSON.stringify(coins.map(coin => coin.baseCurrencyId)))) {
    throw new Error("Baseline must use the same frozen time and coins")
  }

  const resultDirectory = await fs.mkdtemp(path.join(root, `c${concurrency}-`))
  const metrics = {
    concurrency, nowTimestamp, count: coins.length, maxActive: 0, startedAt: new Date().toISOString(),
    connectionTimeMs: 0, wallTimeMs: 0, totalTimeMs: 0, stopReason: null, error: null,
    clientErrors: [], unexpectedDisconnects: 0, results: [], baseline: baseline ?? null,
    regressions: [], valueChanges: [], success: false,
  }
  let active = 0
  let closing = false
  let batchStarted
  const started = performance.now()
  const stop = (message) => {
    metrics.stopReason ??= message || "Shared TradingView client error"
  }

  try {
    const client = await connect()
    metrics.connectionTimeMs = performance.now() - started
    client.onError((...messages) => {
      const message = messages.map(errorMessage).join(" ")
      metrics.clientErrors.push(message)
      stop(message)
    })
    client.onDisconnected(() => {
      if (!closing) {
        metrics.unexpectedDisconnects++
        stop("Shared TradingView connection disconnected")
      }
    })
    batchStarted = performance.now()
    metrics.results = (await parallel(Math.min(concurrency, coins.length || 1), [...coins].reverse(), async (coin) => {
      const result = {
        baseCurrencyId: coin.baseCurrencyId, symbol: coin.symbol, market: coin.market.tradingViewSymbol,
        startOffsetMs: performance.now() - batchStarted, durationMs: 0, complete: false, skipped: false,
        error: null, studyErrors: [], raw: {}, saved: {}, coverage: null, reasonCodes: [],
      }
      if (metrics.stopReason) {
        return { ...result, skipped: true }
      }
      const coinStarted = performance.now()
      metrics.maxActive = Math.max(metrics.maxActive, ++active)
      const checkCoverage = createCoinDataCoverageChecker({
        fetchChartStudies: async (...args) => {
          const data = await fetchChartStudies(...args)
          result.raw.ohlcv = fingerprint(getClosedHourlyPeriods(data.chart.periods, nowTimestamp, 2_400))
          for (const [key, study] of Object.entries(data.studies)) {
            if (study.status === "rejected") {
              const message = errorMessage(study.reason)
              result.studyErrors.push({ key, message })
              if (isLimitError(message)) {
                stop(message)
              }
            } else {
              result.raw[key] = fingerprint(getClosedHourlyPeriods(study.value.periods, nowTimestamp, key === "volumeDelta" ? 1_666 : 2_400))
            }
          }
          return data
        },
        saveHourlyData: async (_coin, data) => {
          result.saved = Object.fromEntries([
            ["ohlcv", fingerprint(data.chart.periods)],
            ...Object.entries(data.studies).map(([key, study]) => [key, fingerprint(study.periods)]),
          ])
          return writeJson(path.join(resultDirectory, createBootstrapDataRelativePath(coin)), data)
        },
      })
      try {
        const checked = await checkCoverage(client, coin, { nowTimestamp })
        Object.assign(result, {
          complete: checked.complete,
          coverage: JSON.parse(JSON.stringify(checked.coverage), (_key, value) => isString(value) ? errorMessage(value) : value),
          reasonCodes: checked.reasonCodes,
          dataFile: checked.dataFile ?? null,
        })
      } catch (error) {
        result.error = errorMessage(error)
        if (isLimitError(result.error)) {
          stop(result.error)
        }
      } finally {
        active--
        result.durationMs = performance.now() - coinStarted
        console.log(`${result.complete ? "OK" : "FAIL"} c=${concurrency} ${coin.symbol} ${(result.durationMs / 1_000).toFixed(2)}s social=${result.coverage?.social.status ?? "unknown"}`)
      }
      return result
    })).reverse()
  } catch (error) {
    metrics.error = errorMessage(error.errors?.[0] ?? error)
  } finally {
    metrics.wallTimeMs = batchStarted === undefined ? 0 : performance.now() - batchStarted
    closing = true
    await disconnect().catch((error) => {
      metrics.error ??= errorMessage(error)
    })
    metrics.totalTimeMs = performance.now() - started
  }

  metrics.acceptedCount = metrics.results.filter(result => result.complete).length
  metrics.skippedCount = metrics.results.filter(result => result.skipped).length
  metrics.rejectedCount = metrics.results.length - metrics.acceptedCount - metrics.skippedCount
  metrics.studyErrorCount = metrics.results.reduce((total, result) => total + result.studyErrors.length, 0)
  metrics.socialAvailableCount = metrics.results.filter(result => result.coverage?.social.status === "available").length
  if (previous && metrics.results.length === previous.results.length) {
    metrics.regressions = compareResults(metrics.results, previous)
    metrics.valueChanges = metrics.results.flatMap((result, index) => Object.keys(result.saved)
      .filter(key => previous.results[index].saved?.[key]?.valuesHash !== result.saved[key].valuesHash)
      .map(key => ({ symbol: result.symbol, source: key })))
  }
  metrics.success = !metrics.error && !metrics.stopReason && !metrics.clientErrors.length
    && !metrics.unexpectedDisconnects && metrics.acceptedCount === coins.length
    && !metrics.regressions.length && metrics.maxActive <= concurrency
  await writeJson(path.join(resultDirectory, "metrics.json"), metrics)
  return { resultDirectory, metrics }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { values } = parseArgs({ options: {
      directory: { type: "string" }, concurrency: { type: "string" },
      count: { type: "string" }, baseline: { type: "string" },
    } })
    const { resultDirectory, metrics } = await runTradingViewBenchmark({
      directory: values.directory, concurrency: Number(values.concurrency),
      count: values.count === undefined ? undefined : Number(values.count), baseline: values.baseline,
    })
    console.log(`${metrics.success ? "OK" : "FAIL"} c=${metrics.concurrency} | ${metrics.acceptedCount}/${metrics.count} accepted | ${(metrics.wallTimeMs / 1_000).toFixed(2)}s | peak=${metrics.maxActive} | social=${metrics.socialAvailableCount} studyErrors=${metrics.studyErrorCount} regressions=${metrics.regressions.length}`)
    console.log(`Results: ${resultDirectory}`)
    if (!metrics.success) {
      console.log(`Stopped: ${metrics.stopReason ?? metrics.error ?? "Incomplete or degraded data"}`)
      process.exitCode = 1
    }
  } catch (error) {
    console.error("TradingView benchmark failed:", errorMessage(error))
    process.exitCode = 1
  }
}
