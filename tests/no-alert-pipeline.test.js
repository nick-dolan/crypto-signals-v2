import assert from "node:assert/strict"
import path from "node:path"
import test from "node:test"

import { enrichCandidatesWithContext } from "../src/steps/step8-context-enrichment/enrich-candidates-with-context.js"
import { addReportContext } from "../src/steps/step13-report/add-report-context.js"
import { buildReportData } from "../src/steps/step13-report/build-report-data.js"
import { renderReportHtml } from "../src/reports/render-report-html.js"
import { enrichCandidatesWithNews } from "../src/steps/step6-news-enrichment/enrich-candidates-with-news.js"
import { enrichCandidatesWithTwitter } from "../src/steps/step7-twitter-enrichment/enrich-candidates-with-twitter.js"

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
    objective: "P(рост > 2.5 ATR в следующие 4–12 часов)",
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

test("every preliminary candidate gets context before top selection, including no alerts", async (t) => {
  for (const topSymbols of [[], ["BTC", "ETH"]]) {
    await t.test(`top: ${topSymbols.join(", ") || "none"}`, async () => {
      const input = createInput(["BTC", "ETH", "SOL", "ADA"])
      input.analysis.topCandidates = topSymbols.map(symbol => ({
        symbol,
        movementProbability: input.analysis.assessments.find(coin => coin.symbol === symbol).movementProbability,
        technicalSummary: { observation: `Итоговое объяснение ${symbol}.`, caveat: null },
        explanation: `Итоговое объяснение ${symbol}.`,
      }))
      const before = structuredClone(input)
      const expectedSymbols = input.shortlist.candidates.map(({ coin }) => coin.symbol)
      const referenceTimestamp = Date.parse("2027-01-15T08:05:00.000Z") / 1_000
      const calls = { news: [], twitter: [], context: [] }
      const news = await enrichCandidatesWithNews(input.shortlist, {
        referenceTimestamp,
        fetchNews: async ({ symbol }) => {
          calls.news.push(symbol)
          return { items: [{ id: symbol, title: "Обновление сети", published: referenceTimestamp - 60 }] }
        },
        fetchStory: async () => assert.fail("No story URLs to fetch"),
      })
      const sources = await enrichCandidatesWithTwitter(news, {
        wait: async () => {},
        fetchPage: async (query) => {
          calls.twitter.push(query)
          return { tweets: [{ id: query, text: "Обсуждение обновления", createdAt: new Date(referenceTimestamp * 1_000).toISOString() }] }
        },
      })
      const context = await enrichCandidatesWithContext(sources, "System prompt", {
        callAgent: async (_, userMessage) => {
          const message = JSON.parse(userMessage)
          calls.context.push(message.symbol)
          assert.equal(message.news.items.length, 1)
          assert.equal(message.twitter.tweets.length, 1)
          assert.equal(Object.hasOwn(message, "explanation"), false)
          assert.equal(Object.hasOwn(message, "movementProbability"), false)
          assert.equal(Object.hasOwn(message, "drivers"), false)
          return JSON.stringify({
            schemaVersion: 4,
            symbol: message.symbol,
            newsSummary: `Запущено обновление ${message.symbol}.`,
            twitterSummary: "Разработчики обсуждают запуск.",
            contextCaveat: null,
            socialSignificant: true,
            socialReason: "Объявлено важное обновление сети.",
            socialSentiment: "bullish",
          })
        },
      })
      const report = await buildReportData(input.analysis, input.payload, input.shortlist, {
        readCoinData: async relativePath => input.histories.get(relativePath),
      })
      const completeReport = addReportContext(report, sources, context)
      const html = await renderReportHtml(completeReport)

      assert.deepEqual({ ...calls, news: [...calls.news].sort() }, {
        news: expectedSymbols.map(symbol => `CRYPTO:${symbol}USD`).sort(),
        twitter: expectedSymbols.map(symbol => (
          `$${symbol} since_time:${referenceTimestamp - 86_400} until_time:${referenceTimestamp + 1}`
        )),
        context: expectedSymbols,
      })
      for (const output of [news, sources, context]) {
        assert.deepEqual(output.candidates.map(coin => coin.symbol), expectedSymbols)
      }
      assert.equal(context.contextEnrichment.candidateCallCount, expectedSymbols.length)
      assert.equal(completeReport.candidateCount, 4)
      for (const [index, coin] of completeReport.coins.entries()) {
        assert.equal(coin.explanation, report.coins[index].explanation)
        assert.equal(coin.movementProbability, report.coins[index].movementProbability)
        assert.deepEqual(coin.technicalSummary, report.coins[index].technicalSummary)
        assert.equal(coin.newsSummary, `Запущено обновление ${coin.symbol}.`)
        assert.equal(coin.socialSentiment, "bullish")
        assert.equal(coin.information.news.items.length, 1)
        assert.equal(coin.information.twitter.tweets.length, 1)
      }
      const embeddedData = html.match(/<script id="report-data" type="application\/json">([\s\S]*?)<\/script>/)
      assert.ok(embeddedData)
      assert.deepEqual(JSON.parse(embeddedData[1]), completeReport)
      assert.deepEqual(input, before)
    })
  }
})

test("an empty preliminary shortlist skips all source and context calls", async () => {
  const input = createInput([])
  const forbidden = async () => assert.fail("Empty shortlist must not make external calls")
  const news = await enrichCandidatesWithNews(input.shortlist, {
    referenceTimestamp: Date.parse(input.shortlist.asOf) / 1_000,
    fetchNews: forbidden,
    fetchStory: forbidden,
  })
  const sources = await enrichCandidatesWithTwitter(news, { fetchPage: forbidden, wait: forbidden })
  const context = await enrichCandidatesWithContext(sources, "System prompt", { callAgent: forbidden })
  const report = await buildReportData(input.analysis, input.payload, input.shortlist, { readCoinData: forbidden })
  const completeReport = addReportContext(report, sources, context)

  assert.deepEqual(news.candidates, [])
  assert.deepEqual(sources.candidates, [])
  assert.deepEqual(context.candidates, [])
  assert.equal(context.contextEnrichment.candidateCallCount, 0)
  assert.deepEqual(completeReport.coins, [])
})
