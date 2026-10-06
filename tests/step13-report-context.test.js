import assert from "node:assert/strict"
import test from "node:test"

import { addReportContext } from "../src/steps/step13-report/add-report-context.js"

function createInput () {
  const report = {
    asOf: "2026-09-16T07:00:00.000Z",
    timeframe: "1h",
    objective: "P(рост > 2.5 ATR в следующие 4–12 часов)",
    candidateCount: 7,
    universeCoinCount: 241,
    marketContext: { breadth4h: 0.279 },
    marketDefinitions: { breadth4h: "Ширина рынка" },
    definitions: { volumeZ: "Аномалия объёма" },
    flagDefinitions: { coiling: "Сжатие" },
    coins: ["XVG", "HUMA", "HOLO", "USELESS", "SKY", "DOGE", "BTC"].map((symbol, index) => ({
      symbol,
      name: symbol,
      marketSymbol: `BINANCE:${symbol}USDT.P`,
      topRank: index < 5 ? index + 1 : null,
      explanation: index < 5 ? `Исходное объяснение ${symbol}.` : "",
      technicalExplanation: index < 5 ? `Исходное объяснение ${symbol}.` : "",
      movementProbability: 0.8 - index / 10,
      estimateConfidence: "medium",
      drivers: [`Драйвер ${symbol}`],
      counterSignals: [`Риск ${symbol}`],
      features: { volumeZ: index, flags: [], socialZ: null, coingeckoTrending: index === 0 || symbol === "DOGE" },
      history: {
        candles: [{ time: 1_789_542_000, open: 1, high: 2, low: 1, close: 2 }],
        volume: [{ time: 1_789_542_000, value: index }],
        openInterest: [{ time: 1_789_542_000 }],
        warning: "Неполная неделя",
      },
    })),
  }
  const sources = {
    asOf: report.asOf,
    candidateCount: 999,
    newsEnrichment: {
      source: "tradingview",
      from: "2026-09-15T08:49:03.000Z",
      asOf: "2026-09-16T08:49:03.000Z",
      lookbackHours: 24,
      maxItemsPerCandidate: 3,
    },
    twitterEnrichment: {
      source: "twitterapi.io",
      from: "2026-09-15T09:00:00.000Z",
      asOf: "2026-09-16T09:00:00.000Z",
      lookbackHours: 24,
      maxPagesPerCandidate: 2,
    },
    candidates: report.coins.map((coin, index) => ({
      symbol: coin.symbol,
      explanation: coin.explanation,
      movementProbability: 0.99,
      estimateConfidence: "low",
      drivers: ["Не брать из шага 9"],
      news: {
        status: "available",
        error: null,
        recentItemCount: 1,
        items: [{
          id: `news:${coin.symbol}`,
          title: `Новость <b>${coin.symbol}</b>`,
          published: 1_789_548_600,
          publishedAt: "2026-09-16T08:50:00.000Z",
          provider: { id: "provider", name: "Provider", url: "https://provider.example" },
          externalUrl: "https://provider.example/story",
          tradingViewUrl: "https://www.tradingview.com/news/story/",
          paywall: true,
          content: "Полный текст\n".repeat(200),
          contentStatus: "full",
          shortDescription: "Описание",
          copyright: "Provider",
          extraField: { preserved: true },
        }],
      },
      twitter: {
        status: "available",
        error: null,
        recentTweetCount: [40, 12, 12, 24, 22, 8, 1][index],
        tweets: Array.from({ length: [40, 12, 12, 24, 22, 8, 1][index] }, (_, tweetIndex) => ({
          id: tweetIndex === 0 ? null : `${coin.symbol}-${tweetIndex}`,
          text: `Обсуждение ${coin.symbol}\n<b>Без изменения текста</b>`,
          createdAt: "2026-09-16T08:50:00.000Z",
          hoursAgo: 0.2,
          likeCount: 1,
          retweetCount: 2,
          viewCount: 100,
          authorUsername: "author",
          authorFollowers: 500,
        })),
      },
    })),
  }
  const context = {
    asOf: report.asOf,
    generatedAt: "2026-09-16T09:03:00.249Z",
    candidateCount: 888,
    newsEnrichment: structuredClone(sources.newsEnrichment),
    twitterEnrichment: structuredClone(sources.twitterEnrichment),
    candidates: sources.candidates.map(candidate => ({
      symbol: candidate.symbol,
      newsStatus: candidate.news.status,
      twitterStatus: candidate.twitter.status,
      newsSummary: `Краткие новости ${candidate.symbol}.`,
      twitterSummary: `Обсуждение ${candidate.symbol}.`,
      contextCaveat: "Слух не подтверждён.",
      socialSignificant: true,
      socialReason: "Значимое обновление.",
      socialSentiment: "bullish",
      movementProbability: 0.01,
      estimateConfidence: "high",
      drivers: ["Не брать из шага 10"],
      counterSignals: [],
      topRank: 99,
      history: { candles: [] },
    })),
  }

  return { report, sources, context }
}

function addContext ({ report, sources, context }) {
  return addReportContext(report, sources, context)
}

test("keeps source windows independent from the market snapshot and accepts equivalent timestamps", () => {
  const input = createInput()
  input.context.asOf = "2026-09-16T10:00:00+03:00"
  input.context.newsEnrichment.from = input.context.newsEnrichment.from.replace(".000Z", "Z")
  input.context.newsEnrichment.asOf = input.context.newsEnrichment.asOf.replace(".000Z", "Z")
  input.sources.twitterEnrichment.from = input.sources.twitterEnrichment.asOf
  input.context.twitterEnrichment.from = input.sources.twitterEnrichment.from
  const result = addContext(input)

  assert.equal(result.asOf, input.report.asOf)
  assert.deepEqual(result.informationSources.news, input.sources.newsEnrichment)
  assert.deepEqual(result.informationSources.twitter, input.sources.twitterEnrichment)
  assert.notEqual(result.informationSources.news.asOf, result.asOf)
  assert.notEqual(result.informationSources.twitter.asOf, result.asOf)
})

test("rejects mismatched market snapshots", async (t) => {
  for (const source of ["report", "sources", "context"]) {
    await t.test(source, () => {
      const input = createInput()
      input[source].asOf = "2026-09-16T06:00:00.000Z"
      assert.throws(() => addContext(input), /market snapshots do not match/)
    })
  }
})

test("rejects invalid market or generation timestamps", async (t) => {
  for (const [source, field] of [["report", "asOf"], ["sources", "asOf"], ["context", "asOf"], ["context", "generatedAt"]]) {
    for (const value of [undefined, null, "", "invalid", 1_789_542_000]) {
      await t.test(`${source}.${field}: ${value}`, () => {
        const input = createInput()
        input[source][field] = value
        assert.throws(() => addContext(input), /valid timestamp/)
      })
    }
  }
})

test("rejects missing, extra, duplicate or malformed candidate members in either enrichment input", async (t) => {
  for (const source of ["sources", "context"]) {
    for (const [name, change, message] of [
      ["missing top", candidates => candidates.slice(1), /candidate set/],
      ["missing non-top trending", candidates => candidates.slice(0, -1), /candidate set/],
      ["extra outsider", candidates => [...candidates, { ...candidates[0], symbol: "OTHER" }], /candidate set/],
      ["wrong top", candidates => [{ ...candidates[0], symbol: "OTHER" }, ...candidates.slice(1)], /candidate set/],
      ["wrong non-top trending", candidates => [...candidates.slice(0, -1), { ...candidates.at(-1), symbol: "OTHER" }], /candidate set/],
      ["duplicate trending top", candidates => [candidates[0], ...candidates], /duplicate symbol/],
      ["duplicate non-top trending", candidates => [...candidates, candidates.at(-1)], /duplicate symbol/],
      ["missing array", () => undefined, /must be an array/],
      ["invalid symbol", candidates => [{ ...candidates[0], symbol: " " }, ...candidates.slice(1)], /invalid symbol/],
    ]) {
      await t.test(`${source}: ${name}`, () => {
        const input = createInput()
        input[source].candidates = change(input[source].candidates)
        assert.throws(() => addContext(input), message)
      })
    }
  }
})

test("rejects duplicate report candidate members", () => {
  for (const symbol of ["XVG", "DOGE"]) {
    const input = createInput()
    input.report.coins.push(input.report.coins.find(coin => coin.symbol === symbol))
    assert.throws(() => addContext(input), /Report candidates contain duplicate symbol/)
  }
})

test("rejects invalid or mismatched inherited source windows", async (t) => {
  for (const key of ["newsEnrichment", "twitterEnrichment"]) {
    for (const source of ["sources", "context"]) {
      for (const field of ["from", "asOf"]) {
        await t.test(`${source}.${key}.${field}: invalid`, () => {
          const input = createInput()
          input[source][key][field] = "invalid"
          assert.throws(() => addContext(input), /valid timestamp/)
        })

        await t.test(`${source}.${key}.${field}: mismatch`, () => {
          const input = createInput()
          input[source][key][field] = field === "from"
            ? "2026-09-15T08:00:00.000Z"
            : "2026-09-16T10:00:00.000Z"
          assert.throws(() => addContext(input), /source windows do not match/)
        })
      }

      await t.test(`${source}.${key}: missing metadata`, () => {
        const input = createInput()
        delete input[source][key]
        assert.throws(() => addContext(input), /valid timestamp/)
      })

      await t.test(`${source}.${key}: reversed window`, () => {
        const input = createInput()
        input[source][key].from = "2026-09-17T00:00:00.000Z"
        assert.throws(() => addContext(input), /from <= asOf/)
      })
    }
  }
})

test("rejects missing containers, invalid statuses and non-array publications", async (t) => {
  for (const [key, itemsKey] of [["news", "items"], ["twitter", "tweets"]]) {
    for (const [name, container] of [
      ["missing", undefined],
      ["null", null],
      ["invalid status", { status: "unknown", [itemsKey]: [] }],
      ["missing status", { [itemsKey]: [] }],
      ["missing array", { status: "empty" }],
      ["invalid array", { status: "failed", [itemsKey]: {} }],
    ]) {
      for (const symbol of ["XVG", "DOGE"]) {
        await t.test(`${symbol}: ${key}: ${name}`, () => {
          const input = createInput()
          input.sources.candidates.find(coin => coin.symbol === symbol)[key] = container
          assert.throws(() => addContext(input), /must have an available, empty or failed status/)
        })
      }
    }
  }
})

test("joins every assessed candidate by symbol and preserves the authoritative analysis", () => {
  const input = createInput()
  input.report.coins.reverse()
  input.sources.candidates.reverse()
  input.context.candidates.reverse()
  for (const coin of input.report.coins) {
    coin.summary = { observation: `Итоговый анализ ${coin.symbol}.`, caveat: "Риск уже учтён." }
    coin.technicalSummary = coin.summary
  }
  for (const candidate of input.context.candidates) {
    candidate.summary = { observation: "Не подменять анализ", caveat: null }
    candidate.enrichedExplanation = "Не подменять объяснение"
  }
  const before = structuredClone(input)
  const result = addContext(input)

  assert.deepEqual(result.coins.map(coin => coin.symbol), input.report.coins.map(coin => coin.symbol))
  assert.equal(result.candidateCount, 7)
  for (const [index, coin] of result.coins.entries()) {
    const original = input.report.coins[index]
    const source = input.sources.candidates.find(candidate => candidate.symbol === coin.symbol)
    const context = input.context.candidates.find(candidate => candidate.symbol === coin.symbol)
    for (const key of ["movementProbability", "estimateConfidence", "drivers", "counterSignals", "summary", "technicalSummary", "explanation", "technicalExplanation", "history", "features", "topRank"]) {
      assert.deepEqual(coin[key], original[key])
    }
    for (const key of ["newsStatus", "twitterStatus", "newsSummary", "twitterSummary", "contextCaveat", "socialSignificant", "socialReason", "socialSentiment"]) {
      assert.deepEqual(coin[key], context[key])
    }
    assert.deepEqual(coin.information, { news: source.news, twitter: source.twitter })
  }
  assert.ok(result.coins.find(coin => coin.symbol === "BTC").information)
  assert.deepEqual(input, before)
})

test("preserves failed partial sources and distinguishes empty from unavailable context", () => {
  const input = createInput()
  input.sources.candidates[0].news.status = "failed"
  input.sources.candidates[0].news.error = "Partial results"
  input.sources.candidates[0].twitter = { status: "empty", tweets: [] }
  Object.assign(input.context.candidates[0], {
    newsStatus: "failed", twitterStatus: "empty", twitterSummary: null,
    socialSignificant: null, socialReason: "Данных недостаточно.", socialSentiment: null,
  })
  const result = addContext(input)
  assert.equal(result.coins[0].information.news.items.length, 1)
  assert.equal(result.coins[0].information.news.error, "Partial results")
  assert.deepEqual(result.coins[0].information.twitter.tweets, [])
  assert.equal(result.coins[0].twitterSummary, null)
  assert.equal(result.coins[0].socialSignificant, null)
})

test("accepts no candidates only when report and both enrichment sets are empty", () => {
  const input = createInput()
  input.report.coins = []
  input.report.candidateCount = 0
  input.sources.candidates = []
  input.context.candidates = []
  assert.deepEqual(addContext(input).coins, [])
})

test("rejects context from mismatched source statuses and malformed summaries", () => {
  for (const key of ["newsStatus", "twitterStatus"]) {
    const input = createInput()
    input.context.candidates[0][key] = "empty"
    assert.throws(() => addContext(input), /status does not match/)
  }
  for (const key of ["newsSummary", "twitterSummary", "contextCaveat"]) {
    for (const value of [undefined, "", " ", 1, {}]) {
      const input = createInput()
      input.context.candidates[0][key] = value
      assert.throws(() => addContext(input), /must be a non-empty string or null/)
    }
  }
})

test("accepts directional and legacy sentiment but rejects malformed social signals", () => {
  for (const socialSentiment of ["bullish", "bearish", "positive", "negative", "mixed", "neutral"]) {
    const input = createInput()
    input.context.candidates[0].socialSentiment = socialSentiment
    assert.equal(addContext(input).coins[0].socialSentiment, socialSentiment)
  }
  for (const fields of [
    { socialSignificant: "true" }, { socialReason: null }, { socialReason: "" },
    { socialSentiment: null }, { socialSentiment: "up" }, { socialSignificant: null },
  ]) {
    const input = createInput()
    Object.assign(input.context.candidates[0], fields)
    assert.throws(() => addContext(input), /socialSignificant|socialReason|socialSentiment/)
  }
})

test("insignificant context retains its tone independently and accepts legacy missing tone", () => {
  for (const socialSentiment of ["bullish", "bearish", "mixed", "neutral", null]) {
    const input = createInput()
    Object.assign(input.context.candidates[0], { socialSignificant: false, socialSentiment })
    const result = addContext(input)
    assert.equal(result.coins[0].socialSignificant, false)
    assert.equal(result.coins[0].socialSentiment, socialSentiment)
  }
})
