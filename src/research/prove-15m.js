import fs from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"

import { fetchTradingViewChartPeriods } from "../api/tradingview/chart-candles.js"
import { connectTradingView, disconnectTradingView } from "../api/tradingview/client.js"
import { isArray, isError, isFinite, isInt } from "../helpers/utils.typed.js"
import { buildPriceCharacterReport, preparePriceCharacterPeriods } from "./price-character.js"
import { renderPriceCharacterHtml, renderPriceCharacterMarkdown } from "./render-price-character-report.js"

export async function fetchProveSnapshot ({
  nowTimestamp = Date.now() / 1000,
  connect = connectTradingView,
  disconnect = disconnectTradingView,
  fetchPeriods = fetchTradingViewChartPeriods,
} = {}) {
  if (!isFinite(nowTimestamp) || nowTimestamp <= 0) {
    throw new Error("Research reference time must be a positive timestamp")
  }
  const endTime = Math.floor(nowTimestamp / 900) * 900

  try {
    const client = await connect()
    const periods = await fetchPeriods(client, {
      symbol: "BINANCE:PROVEUSDT.P",
      timeframe: "15",
      range: 90 * 96 + 98,
      to: endTime - 1,
      timeoutMs: 60_000,
      settleDelayMs: 1_000,
    })
    if (!isArray(periods) || !periods.every(period => isInt(period?.time))) {
      throw new Error("Research candles must have integer timestamps")
    }
    const earliestTime = Math.min(...periods.map(period => period.time))
    const analysisDays = Math.min(90, Math.floor(((endTime - earliestTime) / 900 - 97) / 96))
    if (analysisDays < 30) {
      throw new Error(`Incomplete 15m history: at least 30 days plus baseline required, received ${periods.length} candles`)
    }

    return {
      source: "tradingview",
      symbol: "PROVE",
      marketSymbol: "BINANCE:PROVEUSDT.P",
      timeframe: "15m",
      collectedAt: new Date(nowTimestamp * 1000).toISOString(),
      endTime,
      requestedDays: 90,
      analysisDays,
      receivedBars: periods.length,
      periods: preparePriceCharacterPeriods(periods, endTime, analysisDays),
    }
  } finally {
    await disconnect()
  }
}

export async function runProveResearch ({
  cached = false,
  directory = "reports/prove-15m",
  loadSnapshot = fetchProveSnapshot,
} = {}) {
  const snapshot = cached
    ? JSON.parse(await fs.readFile(path.join(directory, "candles.json"), "utf8"))
    : await loadSnapshot()

  if (snapshot.symbol !== "PROVE" || snapshot.marketSymbol !== "BINANCE:PROVEUSDT.P"
    || snapshot.source !== "tradingview" || snapshot.timeframe !== "15m") {
    throw new Error("Expected a TradingView BINANCE:PROVEUSDT.P 15m snapshot")
  }
  const report = buildPriceCharacterReport(snapshot)
  const candles = preparePriceCharacterPeriods(snapshot.periods, snapshot.endTime, report.coverage.analysisDays).slice(97)
  const html = await renderPriceCharacterHtml(report, candles)

  await fs.mkdir(directory, { recursive: true })
  if (!cached) {
    await fs.writeFile(path.join(directory, "candles.json"), JSON.stringify(snapshot), "utf8")
  }
  await Promise.all([
    fs.writeFile(path.join(directory, "report.json"), JSON.stringify(report, null, 2) + "\n", "utf8"),
    fs.writeFile(path.join(directory, "report.md"), renderPriceCharacterMarkdown(report), "utf8"),
    fs.writeFile(path.join(directory, "report.html"), html, "utf8"),
  ])

  return report
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.slice(2).some(argument => argument !== "--cached")) {
      throw new Error("Usage: pnpm research:prove [--cached]")
    }
    console.log(process.argv.includes("--cached")
      ? "PROVE: analysing saved 15m candles without network requests…"
      : "PROVE: downloading 90 days of closed 15m candles + baseline from TradingView…")
    const report = await runProveResearch({ cached: process.argv.includes("--cached") })
    report.warnings.forEach(warning => console.warn(warning))
    console.log(`PROVE: ${report.coverage.analysisBars} candles, through ${new Date(report.endTime * 1000).toISOString()} (exclusive)`)
    console.table(report.windows.map(window => ({
      days: window.days,
      medianRangePct: window.medianRangePct,
      spikeCount: window.spikeCount,
      spikeRatePct: window.spikeRatePct,
      efficiency4h: window.efficiency4hMedian,
      top1PctMovementSharePct: window.top1PctMovementSharePct,
    })))
    console.log("Saved: reports/prove-15m/{candles.json,report.json,report.md,report.html}")
  } catch (error) {
    console.error("PROVE research failed:", isError(error) ? error.message : String(error))
    process.exitCode = 1
  }
}
