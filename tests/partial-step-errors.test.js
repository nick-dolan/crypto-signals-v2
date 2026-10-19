import assert from "node:assert/strict"
import fs from "node:fs/promises"
import test from "node:test"

import { readCoinHistory } from "../src/helpers/coin-history-helper.js"
import { formatStepError } from "../src/helpers/step-error-helper.js"
import { sendTelegramRelease } from "../src/reports/telegram/send-telegram-release.js"
import { runContextEnrichmentStep } from "../src/step8-context-enrichment.js"
import { runCandidateEnrichment } from "../src/steps/candidate-enrichment/run-candidate-enrichment.js"
import { buildMarketBrief } from "../src/steps/step12.1-market-brief/build-market-brief.js"
import { createCoinDataCoverageChecker } from "../src/steps/step2-data-bootstrap/check-coin-data-coverage.js"
import { createCoverageStudyRequests } from "../src/steps/step2-data-bootstrap/coverage-study-definitions.js"
import { checkWithRetry } from "../src/steps/step2-data-bootstrap/data-coverage-helpers.js"
import { InvalidContextEnrichmentError } from "../src/steps/step8-context-enrichment/parse-context-enrichment.js"

test("market brief reports the original model failure without losing collected sources", async (t) => {
  const error = new Error("Model request timed out", { cause: new Error("Upstream transport failure") })
  error.context = { timeoutMs: 30_000 }
  const reportError = t.mock.fn(async () => {})
  const collection = {
    from: "2026-10-19T06:00:00.000Z",
    asOf: "2026-10-19T12:00:00.000Z",
    sources: [{
      id: "source-1", channel: "tradingview", title: "Exchange reports an outage",
      text: "The exchange is investigating a technical outage.",
      url: "https://example.com/news/outage", publishedAt: "2026-10-19T11:00:00.000Z",
      author: null, publisher: null,
    }],
    coverage: [
      { source: "tradingview", status: "available", fetchedCount: 1, error: null },
      { source: "twitter", status: "empty", fetchedCount: 0, error: null },
    ],
    warnings: [],
  }
  const output = await buildMarketBrief("Summarize the sources", {
    collectSources: async () => collection,
    callAgent: async () => {
      throw error
    },
    reportError,
  })

  assert.equal(reportError.mock.callCount(), 1)
  const [reported, context] = reportError.mock.calls[0].arguments
  assert.equal(reported, error)
  assert.equal(reported.cause.message, "Upstream transport failure")
  assert.equal(reported.context.timeoutMs, 30_000)
  assert.equal(context.step, "step12.1-market-brief.js")
  assert.equal(context.operation, "analyze_market_brief")
  assert.ok(context.provider && context.model)
  assert.equal(output.status, "unavailable")
  assert.equal(output.analysis.status, "failed")
  assert.equal(output.analysis.error, error.message)
  assert.equal(output.sources, collection.sources)
  assert.deepEqual(output.items, [])
})

test("combined enrichment preserves invalid responses and leaves fatal reporting to the wrapper", async (t) => {
  const asOf = "2026-10-19T12:00:00.000Z"
  const referenceTimestamp = Date.parse(asOf) / 1_000
  const reportError = t.mock.fn(async () => {})
  const callAgent = t.mock.fn(async () => "not JSON")
  await assert.rejects(runCandidateEnrichment({
    referenceTimestamp,
    concurrency: 1,
    readJson: async () => ({
      asOf,
      candidates: ["TEST", "NEXT"].map(symbol => ({ coin: { symbol, tradingViewSymbol: `BINANCE:${symbol}USDT.P` } })),
    }),
    readPrompt: async () => "Summarize publications",
    writeJson: async () => "memory.json",
    removeJson: async () => {},
    preparePatterns: async () => ({ asOf, directory: "patterns", candidateCount: 0, candidates: [] }),
    fetchNews: async () => ({ items: [{ id: "news-1", title: "Exchange outage", published: referenceTimestamp }] }),
    fetchStory: async () => {
      throw new Error("No story request expected")
    },
    fetchPage: async () => ({ tweets: [], has_next_page: false }),
    callAgent,
    reportError,
  }), (error) => {
    assert.ok(error instanceof InvalidContextEnrichmentError)
    const { symbol } = JSON.parse(callAgent.mock.calls[0].arguments[1])
    assert.equal(error.symbol, symbol)
    assert.equal(error.response, "not JSON")
    assert.equal(error.context.step, "step8-context-enrichment.js")
    assert.equal(error.context.symbol, symbol)
    assert.equal(error.context.operation, "summarize_publications")
    return true
  })
  assert.equal(callAgent.mock.callCount(), 1)
  assert.equal(reportError.mock.callCount(), 0)
})

test("coin history reports pipeline I/O and JSON failures, not missing or unready history", async (t) => {
  const coin = { symbol: "TEST", baseCurrencyId: "XTVCTEST", marketSymbol: "BINANCE:TESTUSDT.P" }
  const asOf = Date.parse("2026-10-19T12:00:00.000Z") / 1_000
  const reportError = t.mock.fn(async () => {})
  const empty = { coin, timeframe: "1h", chart: { periods: [] } }
  const missing = Object.assign(new Error("History file is absent"), { code: "ENOENT" })
  const stale = { ...empty, chart: { periods: [{ time: asOf - 3_600, open: 1, max: 1, min: 1, close: 1 }] } }

  for (const data of [empty, stale]) {
    await readCoinHistory(coin, asOf, { readCoinData: async () => data, step: "step13-report.js", reportError })
  }
  await readCoinHistory(coin, asOf, {
    readCoinData: async () => {
      throw missing
    }, step: "step13-report.js", reportError,
  })
  await readCoinHistory(coin, asOf, { readCoinData: async () => empty, reportError })
  assert.equal(reportError.mock.callCount(), 0)

  for (const error of [Object.assign(new Error("Permission denied"), { code: "EACCES" }), new SyntaxError("Invalid saved JSON")]) {
    const history = await readCoinHistory(coin, asOf, {
      readCoinData: async () => {
        throw error
      }, step: "step8.1-pattern-enrichment.js", reportError,
    })
    assert.deepEqual(history.candles, [])
    const [reported, context] = reportError.mock.calls.at(-1).arguments
    assert.equal(reported, error)
    assert.equal(context.step, "step8.1-pattern-enrichment.js")
    assert.equal(context.symbol, coin.symbol)
    assert.equal(context.operation, "read_coin_history")
  }
  assert.equal(reportError.mock.callCount(), 2)
})

test("a failed diagnostic write preserves the primary invalid response and earlier cleanup errors", async (t) => {
  const primary = new InvalidContextEnrichmentError("Invalid model response")
  primary.symbol = "TEST"
  primary.response = "not JSON"
  const earlier = new Error("Earlier cleanup failure")
  primary.cleanupErrors = [earlier]
  const writeError = Object.assign(new Error("Disk is full"), { code: "ENOSPC" })
  const writeJson = t.mock.fn(async () => {
    throw writeError
  })
  t.mock.method(console, "error", () => {})

  await assert.rejects(runContextEnrichmentStep({
    readJson: async () => ({}),
    readPrompt: async () => "Summarize publications",
    enrich: async () => {
      throw primary
    },
    writeJson,
  }), (error) => {
    assert.equal(error, primary)
    assert.ok(error instanceof InvalidContextEnrichmentError)
    assert.equal(error.symbol, "TEST")
    assert.equal(error.response, "not JSON")
    assert.deepEqual(error.cleanupErrors, [earlier, writeError])
    assert.equal(writeError.context.step, "step8-context-enrichment.js")
    assert.equal(writeError.context.operation, "write_invalid_response")
    return true
  })
  assert.equal(writeJson.mock.callCount(), 1)
})

test("a Telegram receipt failure retains its I/O cause without sending the release again", async (t) => {
  const error = Object.assign(new Error("Disk is full"), { code: "ENOSPC" })
  t.mock.method(fs, "readFile", async () => JSON.stringify({
    schemaVersion: 2, source: "reports/test-report", richMessage: { text: "Report" }, candidates: [],
  }))
  t.mock.method(fs, "mkdir", async () => {})
  t.mock.method(fs, "writeFile", async () => {
    throw error
  })
  const client = { chatId: "test-chat", sendRichMessage: t.mock.fn(async () => ({ message_id: 42 })) }

  await assert.rejects(sendTelegramRelease({ manifestPath: "memory/release.json" }, {
    reportId: "test-report", client,
  }), (failure) => {
    assert.equal(failure.cause, error)
    assert.match(failure.message, /do not resend blindly/)
    return true
  })
  assert.equal(client.sendRichMessage.mock.callCount(), 1)
})

test("coverage reports original request errors only at the final return, including optional partial data", async (t) => {
  const nowTimestamp = Date.parse("2026-10-19T12:30:00.000Z") / 1_000
  const coin = {
    symbol: "TEST", baseCurrencyId: "XTVCTEST", tradingViewSymbol: "CRYPTO:TESTUSD",
    circulatingSupply: 1_000_000, marketCap: 100_000_000, fullyDilutedValuation: 200_000_000,
    market: { tradingViewSymbol: "BINANCE:TESTUSDT.P", baseCurrencyId: "XTVCTEST" },
  }
  const periods = [2, 1].map(hours => ({
    time: Math.floor(nowTimestamp / 3_600) * 3_600 - hours * 3_600,
    open: 100, max: 101, min: 99, close: 100, volume: 10,
  }))
  const chartData = {
    chart: { info: { fullName: coin.market.tradingViewSymbol, baseCurrencyId: coin.baseCurrencyId }, periods },
    studies: Object.fromEntries(createCoverageStudyRequests(coin.tradingViewSymbol).map(request => [request.key, {
      status: "fulfilled",
      value: {
        request, fields: request.fields,
        periods: periods.map(({ time }) => ({ time, ...Object.fromEntries(Object.keys(request.fields).map(field => [field, 1])) })),
      },
    }])),
  }
  const transient = new Error("Core study request failed")
  const coreFailure = { ...chartData, studies: { ...chartData.studies, openInterest: { status: "rejected", reason: transient } } }
  const error = new Error("TradingView active posts request timed out: received 0 source periods", { cause: new Error("Socket idle") })
  error.context = { type: "timeout", code: "ETIMEDOUT", timeoutMs: 45_000 }
  const partial = { ...chartData, studies: { ...chartData.studies, activePosts: { status: "rejected", reason: error } } }
  let responses = [coreFailure, chartData]
  const reportError = t.mock.fn(async () => {})
  const checker = createCoinDataCoverageChecker({
    fetchChartStudies: async () => responses.shift(),
    saveHourlyData: async () => "memory.json",
  })
  const checkCoverage = async () => {
    const result = await checker(null, coin, { fetchHours: 2, nowTimestamp })
    assert.equal(Object.getOwnPropertyDescriptor(result, "requestErrors").enumerable, false)
    assert.equal(Object.hasOwn(JSON.parse(JSON.stringify(result)), "requestErrors"), false)
    return result
  }

  const recovered = await checkWithRetry(checkCoverage, coin, 2, () => {}, { reportError })
  assert.equal(recovered.attempts, 2)
  assert.equal(recovered.result.complete, true)
  assert.equal(reportError.mock.callCount(), 0)

  responses = [coreFailure, partial]
  const final = await checkWithRetry(checkCoverage, coin, 2, () => {}, { reportError })
  assert.equal(final.attempts, 2)
  assert.equal(final.result.complete, true)
  assert.equal(final.result.coverage.social.status, "unavailable")
  assert.equal(reportError.mock.callCount(), 1)
  const [reported, context] = reportError.mock.calls[0].arguments
  assert.equal(reported, error)
  assert.equal(reported.cause.message, "Socket idle")
  assert.equal(context.step, "step2-data-bootstrap.js")
  assert.equal(context.symbol, coin.symbol)
  assert.equal(context.attempt, 2)
  assert.match(formatStepError(reported, context, {}), /Тип: Таймаут/)

  reportError.mock.resetCalls()
  await checkWithRetry(async () => {
    throw error
  }, coin, 2, () => {}, { reportError })
  assert.equal(reportError.mock.callCount(), 1)
  assert.equal(reportError.mock.calls[0].arguments[0], error)
})
