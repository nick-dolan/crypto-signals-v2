import assert from "node:assert/strict"
import test from "node:test"

import { addReportContext } from "../src/steps/step11-report/add-report-context.js"

function createInput () {
  const report = {
    asOf: "2026-09-16T07:00:00.000Z",
    timeframe: "1h",
    objective: "P(сильное движение в следующие 4–12 часов)",
    candidateCount: 6,
    universeCoinCount: 241,
    marketContext: { breadth4h: 0.279 },
    marketDefinitions: { breadth4h: "Ширина рынка" },
    definitions: { volumeZ: "Аномалия объёма" },
    flagDefinitions: { coiling: "Сжатие" },
    coins: ["XVG", "HUMA", "HOLO", "USELESS", "SKY", "BTC"].map((symbol, index) => ({
      symbol,
      name: symbol,
      marketSymbol: `BINANCE:${symbol}USDT.P`,
      topRank: index < 5 ? index + 1 : null,
      explanation: index < 5 ? `Исходное объяснение ${symbol}.` : "",
      movementProbability: 0.8 - index / 10,
      directionBias: "up",
      estimateConfidence: "medium",
      drivers: [`Драйвер ${symbol}`],
      counterSignals: [`Риск ${symbol}`],
      features: { volumeZ: index, flags: [], socialZ: null },
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
    topCandidates: report.coins.filter(coin => coin.topRank != null).map((coin, index) => ({
      symbol: coin.symbol,
      explanation: coin.explanation,
      movementProbability: 0.99,
      directionBias: "down",
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
        recentTweetCount: [40, 12, 12, 24, 22][index],
        tweets: Array.from({ length: [40, 12, 12, 24, 22][index] }, (_, tweetIndex) => ({
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
    topCandidates: sources.topCandidates.map(candidate => ({
      symbol: candidate.symbol,
      explanation: candidate.explanation,
      enrichedExplanation: `${candidate.explanation} Информационный фон ${candidate.symbol}.`,
      movementProbability: 0.01,
      directionBias: "down",
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

test("joins reordered tops by symbol without changing assessments, counts, order or inputs", () => {
  const input = createInput()
  input.report.coins.reverse()
  input.sources.topCandidates.reverse()
  input.context.topCandidates = [...input.context.topCandidates.slice(2), ...input.context.topCandidates.slice(0, 2)]
  input.context.topCandidates[0].enrichedExplanation += "  "
  const before = structuredClone(input)
  const result = addContext(input)

  assert.notEqual(result, input.report)
  assert.notEqual(result.coins, input.report.coins)
  assert.deepEqual(result, {
    ...input.report,
    informationSources: {
      news: input.sources.newsEnrichment,
      twitter: input.sources.twitterEnrichment,
      contextGeneratedAt: input.context.generatedAt,
    },
    coins: input.report.coins.map((coin) => {
      if (coin.topRank == null) {
        return coin
      }

      const source = input.sources.topCandidates.find(candidate => candidate.symbol === coin.symbol)
      const context = input.context.topCandidates.find(candidate => candidate.symbol === coin.symbol)

      return {
        ...coin,
        explanation: context.enrichedExplanation,
        information: { news: source.news, twitter: source.twitter },
      }
    }),
  })
  assert.equal(result.coins[0], input.report.coins[0])
  assert.equal(Object.hasOwn(result.coins[0], "information"), false)
  assert.equal(result.informationSources.news, input.sources.newsEnrichment)
  assert.equal(result.informationSources.twitter, input.sources.twitterEnrichment)

  for (const [index, coin] of result.coins.entries()) {
    assert.equal(coin.history, input.report.coins[index].history)
    assert.equal(coin.features, input.report.coins[index].features)

    if (coin.topRank != null) {
      const source = input.sources.topCandidates.find(candidate => candidate.symbol === coin.symbol)
      assert.equal(coin.information.news, source.news)
      assert.equal(coin.information.twitter, source.twitter)
      assert.equal(coin.information.twitter.tweets.length, source.twitter.recentTweetCount)
    }
  }

  assert.deepEqual(input, before)
})

test("preserves empty and failed containers, errors, partial results and extra metadata", () => {
  const input = createInput()
  input.sources.topCandidates[0].news = { status: "empty", error: null, items: [], recentItemCount: 0 }
  input.sources.topCandidates[1].news = { status: "failed", error: "News unavailable", items: [] }
  input.sources.topCandidates[0].twitter.status = "failed"
  input.sources.topCandidates[0].twitter.error = "Second page unavailable"
  input.sources.topCandidates[1].twitter = { status: "empty", error: null, tweets: [], recentTweetCount: 0 }
  const before = structuredClone(input)
  const result = addContext(input)

  for (const coin of result.coins.filter(coin => coin.topRank != null)) {
    const source = input.sources.topCandidates.find(candidate => candidate.symbol === coin.symbol)
    assert.equal(coin.information.news, source.news)
    assert.equal(coin.information.twitter, source.twitter)
  }

  assert.equal(result.coins[0].information.twitter.tweets.length, 40)
  assert.deepEqual(input, before)
})

test("accepts empty tops with or without non-top coins", () => {
  for (const keepCoins of [true, false]) {
    const input = createInput()
    input.report.coins = keepCoins ? input.report.coins.map(coin => ({ ...coin, topRank: null })) : []
    input.report.candidateCount = input.report.coins.length
    input.sources.topCandidates = []
    input.context.topCandidates = []
    const result = addContext(input)

    assert.deepEqual(result.coins, input.report.coins)
    assert.equal(result.candidateCount, input.report.candidateCount)
    assert.equal(result.informationSources.contextGeneratedAt, input.context.generatedAt)

    for (const [index, coin] of result.coins.entries()) {
      assert.equal(coin, input.report.coins[index])
      assert.equal(Object.hasOwn(coin, "information"), false)
    }
  }
})

test("keeps source windows independent from the market snapshot and accepts equivalent timestamps", () => {
  const input = createInput()
  input.context.asOf = "2026-09-16T10:00:00+03:00"
  input.context.newsEnrichment.from = input.context.newsEnrichment.from.replace(".000Z", "Z")
  input.context.newsEnrichment.asOf = input.context.newsEnrichment.asOf.replace(".000Z", "Z")
  input.sources.twitterEnrichment.from = input.sources.twitterEnrichment.asOf
  input.context.twitterEnrichment.from = input.sources.twitterEnrichment.from
  const result = addContext(input)

  assert.equal(result.asOf, input.report.asOf)
  assert.equal(result.informationSources.news, input.sources.newsEnrichment)
  assert.equal(result.informationSources.twitter, input.sources.twitterEnrichment)
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

test("rejects missing, extra, duplicate or malformed tops in either enrichment input", async (t) => {
  for (const source of ["sources", "context"]) {
    for (const [name, change, message] of [
      ["missing", top => top.slice(1), /top candidate set/],
      ["extra non-top", top => [...top, { ...top[0], symbol: "BTC" }], /top candidate set/],
      ["wrong member", top => [{ ...top[0], symbol: "OTHER" }, ...top.slice(1)], /top candidate set/],
      ["duplicate", top => [top[0], ...top], /duplicate symbol/],
      ["missing array", () => undefined, /must be an array/],
      ["invalid symbol", top => [{ ...top[0], symbol: " " }, ...top.slice(1)], /invalid symbol/],
    ]) {
      await t.test(`${source}: ${name}`, () => {
        const input = createInput()
        input[source].topCandidates = change(input[source].topCandidates)
        assert.throws(() => addContext(input), message)
      })
    }
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

test("rejects missing or blank enriched explanations instead of falling back to the original", async (t) => {
  for (const value of [undefined, null, "", " \n ", 42, {}]) {
    await t.test(String(value), () => {
      const input = createInput()
      input.context.topCandidates[0].enrichedExplanation = value
      assert.throws(() => addContext(input), /enrichedExplanation must be a non-empty string/)
    })
  }
})

test("rejects stale base explanations at any joining stage", async (t) => {
  for (const source of ["report", "sources", "context"]) {
    await t.test(source, () => {
      const input = createInput()
      const candidate = source === "report" ? input.report.coins[0] : input[source].topCandidates[0]
      candidate.explanation = "Объяснение из другого анализа."
      assert.throws(() => addContext(input), /base explanation does not match/)
    })
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
      await t.test(`${key}: ${name}`, () => {
        const input = createInput()
        input.sources.topCandidates[0][key] = container
        assert.throws(() => addContext(input), /must have an available, empty or failed status/)
      })
    }
  }
})
