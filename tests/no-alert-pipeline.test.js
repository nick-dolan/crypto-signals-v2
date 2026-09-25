import assert from "node:assert/strict"
import path from "node:path"
import test from "node:test"

import { enrichTopCandidatesWithContext } from "../src/steps/step10-context-enrichment/enrich-top-candidates-with-context.js"
import { addReportContext } from "../src/steps/step13-report/add-report-context.js"
import { buildReportData } from "../src/steps/step13-report/build-report-data.js"
import { renderReportHtml } from "../src/steps/step13-report/render-report-html.js"
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

function createInput (symbols = ["BTC", "ETH"]) {
  const asOf = "2027-01-15T08:00:00.000Z"
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

test("trending report coins get sources and analysis with or without agent tops", async (t) => {
  for (const topSymbols of [[], ["BTC", "ETH"]]) {
    await t.test(`top: ${topSymbols.join(", ") || "none"}`, async () => {
      const input = createInput(["BTC", "ETH", "SOL", "ADA"])
      for (const candidate of input.shortlist.candidates) {
        if (["BTC", "SOL"].includes(candidate.coin.symbol)) {
          candidate.coin.coingecko = { isTrending: true }
        }
      }
      input.payload.schema.coingecko = ["coingeckoTrending"]
      input.payload.definitions.coingeckoTrending = "Поисковое внимание CoinGecko"
      input.payload.candidates.forEach((candidate) => {
        candidate.coingecko = [["BTC", "SOL"].includes(candidate.symbol) ? true : null]
      })
      input.analysis.topCandidates = topSymbols.map(symbol => ({
        symbol,
        movementProbability: input.analysis.assessments.find(coin => coin.symbol === symbol).movementProbability,
        explanation: `Исходное объяснение ${symbol}.`,
      }))
      const before = structuredClone(input)
      const expectedSymbols = [...new Set([...topSymbols, "BTC", "SOL"])]
      const referenceTimestamp = Date.parse("2027-01-15T08:05:00.000Z") / 1_000
      const calls = { news: [], twitter: [], context: [] }
      const news = await enrichTopCandidatesWithNews(input.analysis, input.shortlist, {
        referenceTimestamp,
        fetchNews: async ({ symbol }) => {
          calls.news.push(symbol)
          return { items: [{ id: symbol, title: "Обновление сети", published: referenceTimestamp - 60 }] }
        },
        fetchStory: async () => assert.fail("No story URLs to fetch"),
      })
      const sources = await enrichTopCandidatesWithTwitter(news, {
        referenceTimestamp,
        wait: async () => {},
        fetchPage: async (query) => {
          calls.twitter.push(query)
          return { tweets: [{ id: query, text: "Обсуждение обновления", createdAt: new Date(referenceTimestamp * 1_000).toISOString() }] }
        },
      })
      const context = await enrichTopCandidatesWithContext(sources, "System prompt", {
        callAgent: async (_, userMessage) => {
          const message = JSON.parse(userMessage)
          calls.context.push(message.symbol)
          assert.equal(message.news.items.length, 1)
          assert.equal(message.twitter.tweets.length, 1)
          if (!topSymbols.includes(message.symbol)) {
            const assessment = input.analysis.assessments.find(coin => coin.symbol === message.symbol)
            assert.equal(message.explanation, "")
            assert.deepEqual(message.drivers, assessment.drivers)
            assert.deepEqual(message.counterSignals, assessment.counterSignals)
          }
          return JSON.stringify({ schemaVersion: 1, symbol: message.symbol, informationBackground: `Информационный фон ${message.symbol}.` })
        },
      })
      const report = await buildReportData(input.analysis, input.payload, input.shortlist, {
        readCoinData: async relativePath => input.histories.get(relativePath),
      })
      const completeReport = addReportContext(report, sources, context)
      const html = await renderReportHtml(completeReport)

      assert.deepEqual(calls, {
        news: expectedSymbols.map(symbol => `CRYPTO:${symbol}USD`),
        twitter: expectedSymbols.map(symbol => `$${symbol}`),
        context: expectedSymbols,
      })
      for (const output of [news, sources, context]) {
        assert.deepEqual(output.candidates.map(coin => coin.symbol), expectedSymbols)
        assert.equal(Object.hasOwn(output, "topCandidates"), false)
      }
      assert.equal(context.contextEnrichment.candidateCallCount, expectedSymbols.length)
      assert.equal(completeReport.candidateCount, 4)
      assert.deepEqual(completeReport.coins.map(coin => coin.symbol), ["BTC", "ETH", "SOL", "ADA"])
      for (const [index, coin] of completeReport.coins.entries()) {
        const original = report.coins[index]
        assert.deepEqual(coin, expectedSymbols.includes(coin.symbol)
          ? {
              ...original,
              explanation: [original.explanation, `Информационный фон ${coin.symbol}.`].filter(Boolean).join(" "),
              information: {
                news: sources.candidates.find(candidate => candidate.symbol === coin.symbol).news,
                twitter: sources.candidates.find(candidate => candidate.symbol === coin.symbol).twitter,
              },
            }
          : original)
      }
      const embeddedData = html.match(/<script id="report-data" type="application\/json">([\s\S]*?)<\/script>/)
      assert.ok(embeddedData)
      assert.deepEqual(JSON.parse(embeddedData[1]), completeReport)
      assert.deepEqual(input, before)
    })
  }
})

test("no top or trending candidates skip enrichment while all assessments reach the rendered report", async () => {
  const input = createInput()
  const sourceCalls = []
  const forbidden = source => async () => {
    sourceCalls.push(source)
    throw new Error(`${source} must not be called without enrichment candidates`)
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
  assert.deepEqual(news.candidates, [])
  assert.deepEqual(sources.candidates, [])
  assert.deepEqual(context.candidates, [])
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
