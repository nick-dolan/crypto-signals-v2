import assert from "node:assert/strict"
import path from "node:path"
import test from "node:test"

import { enrichTopCandidatesWithContext } from "../src/steps/step10-context-enrichment/enrich-top-candidates-with-context.js"
import { addReportContext } from "../src/steps/step11-report/add-report-context.js"
import { buildReportData } from "../src/steps/step11-report/build-report-data.js"
import { renderReportHtml } from "../src/steps/step11-report/render-report-html.js"
import { enrichTopCandidatesWithNews } from "../src/steps/step8-news-enrichment/enrich-top-candidates-with-news.js"
import { enrichTopCandidatesWithTwitter } from "../src/steps/step9-twitter-enrichment/enrich-top-candidates-with-twitter.js"

function createHistory (coin, asOf) {
  const asOfTimestamp = Date.parse(asOf) / 1_000
  const periods = Array.from({ length: 168 }, (_, index) => ({
    time: asOfTimestamp - (167 - index) * 3_600,
    open: 100 + index,
    max: 102 + index,
    min: 99 + index,
    close: 101 + index,
    volume: 1_000 + index,
  }))

  return {
    coin: { ...coin },
    timeframe: "1h",
    chart: { info: { fullName: coin.marketSymbol }, periods },
    studies: {
      openInterest: {
        periods: periods.map(({ time }, index) => ({ time, close: 10_000 + index })),
      },
    },
  }
}

function createInput () {
  const asOf = "2027-01-15T08:00:00.000Z"
  const symbols = ["BTC", "ETH"]
  const shortlist = {
    asOf,
    timeframe: "1h",
    candidateCount: symbols.length,
    universeCoinCount: 200,
    candidates: symbols.map(symbol => ({
      coin: {
        symbol,
        name: `Coin ${symbol}`,
        baseCurrencyId: `XTVC${symbol}`,
        tradingViewSymbol: `CRYPTO:${symbol}USD`,
        marketSymbol: `BINANCE:${symbol}USDT.P`,
      },
    })),
  }
  const payload = {
    schemaVersion: 10,
    asOf,
    timeframe: "1h",
    objective: "P(|движение| > 2.5 ATR в следующие 4–12 часов)",
    candidateCount: symbols.length,
    marketContext: { breadth4h: 0.5 },
    marketDefinitions: { breadth4h: "Ширина рынка" },
    schema: { volume: ["volumeZ"] },
    definitions: { symbol: "Тикер", volumeZ: "Аномалия объёма" },
    flagDefinitions: {},
    candidates: symbols.map((symbol, index) => ({
      symbol,
      name: `Coin ${symbol}`,
      selectionRank: index + 1,
      volume: [index + 0.25],
      flags: [],
    })),
  }
  const analysis = {
    schemaVersion: 1,
    asOf,
    candidateCount: symbols.length,
    topCandidates: [],
    assessments: symbols.map((symbol, index) => ({
      symbol,
      movementProbability: 0.2 - index * 0.05,
      estimateConfidence: "medium",
      drivers: [`Драйвер ${symbol}`],
      counterSignals: [`Ограничение ${symbol}`],
      tradingViewUrl: `https://www.tradingview.com/chart/?symbol=BINANCE:${symbol}USDT.P`,
    })),
  }
  const histories = new Map(shortlist.candidates.map(({ coin }) => [
    path.join("step2-data-bootstrap", `${coin.symbol}--${coin.baseCurrencyId}`, "data.json"),
    createHistory(coin, asOf),
  ]))

  return { analysis, histories, payload, shortlist }
}

test("empty top candidates skip enrichment while all assessments reach the rendered report", async () => {
  const input = createInput()
  const sourceCalls = []
  const forbidden = source => async () => {
    sourceCalls.push(source)
    throw new Error(`${source} must not be called without top candidates`)
  }
  const referenceTimestamp = Date.parse("2027-01-15T08:05:00.000Z") / 1_000
  const news = await enrichTopCandidatesWithNews(
    input.analysis,
    input.shortlist,
    {
      referenceTimestamp,
      fetchNews: forbidden("news"),
      fetchStory: forbidden("news story"),
    },
  )
  const sources = await enrichTopCandidatesWithTwitter(news, {
    referenceTimestamp,
    fetchPage: forbidden("twitter"),
    wait: forbidden("twitter wait"),
  })
  const context = await enrichTopCandidatesWithContext(
    sources,
    "System prompt",
    { callAgent: forbidden("context LLM") },
  )
  const report = await buildReportData(
    input.analysis,
    input.payload,
    input.shortlist,
    { readCoinData: async relativePath => input.histories.get(relativePath) },
  )
  const completeReport = addReportContext(report, sources, context)
  const html = await renderReportHtml(completeReport)
  const embeddedData = html.match(
    /<script id="report-data" type="application\/json">([\s\S]*?)<\/script>/,
  )

  assert.deepEqual(sourceCalls, [])
  assert.deepEqual(news.topCandidates, [])
  assert.deepEqual(sources.topCandidates, [])
  assert.deepEqual(context.topCandidates, [])
  assert.equal(context.contextEnrichment.candidateCallCount, 0)
  assert.equal(completeReport.coins.length, input.analysis.assessments.length)
  assert.deepEqual(completeReport.coins.map(coin => coin.symbol), ["BTC", "ETH"])
  assert.deepEqual(completeReport.coins.map(coin => coin.topRank), [null, null])

  for (const assessment of input.analysis.assessments) {
    const coin = completeReport.coins.find(item => item.symbol === assessment.symbol)

    assert.ok(coin)
    assert.deepEqual(
      Object.fromEntries(Object.keys(assessment).map(key => [key, coin[key]])),
      assessment,
    )
    assert.equal(coin.explanation, "")
    assert.ok(!Object.hasOwn(coin, "information"))
  }

  assert.ok(embeddedData)
  assert.deepEqual(JSON.parse(embeddedData[1]), completeReport)
})
