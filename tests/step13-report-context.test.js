import assert from "node:assert/strict"
import test from "node:test"

import { addReportContext } from "../src/steps/step13-report/add-report-context.js"

function createInput () {
  const report = {
    asOf: "2026-09-16T07:00:00.000Z",
    timeframe: "1h",
    objective: "P(|движение| > 2.5 ATR в следующие 4–12 часов)",
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
    candidates: report.coins.filter(coin => coin.topRank != null || coin.features.coingeckoTrending === true).map((coin, index) => ({
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
        recentTweetCount: [40, 12, 12, 24, 22, 8][index],
        tweets: Array.from({ length: [40, 12, 12, 24, 22, 8][index] }, (_, tweetIndex) => ({
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
      explanation: candidate.explanation,
      enrichedExplanation: [candidate.explanation, `Информационный фон ${candidate.symbol}.`].filter(Boolean).join(" "),
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

test("joins reordered top and trending coins by symbol without changing assessments, counts, order or inputs", () => {
  const input = createInput()
  input.report.coins.reverse()
  input.sources.candidates.reverse()
  input.context.candidates = [...input.context.candidates.slice(2), ...input.context.candidates.slice(0, 2)]
  input.context.candidates[0].enrichedExplanation += "  "
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
      if (coin.topRank == null && coin.features.coingeckoTrending !== true) {
        return coin
      }

      const source = input.sources.candidates.find(candidate => candidate.symbol === coin.symbol)
      const context = input.context.candidates.find(candidate => candidate.symbol === coin.symbol)

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

    if (coin.topRank != null || coin.features.coingeckoTrending === true) {
      const source = input.sources.candidates.find(candidate => candidate.symbol === coin.symbol)
      assert.equal(coin.information.news, source.news)
      assert.equal(coin.information.twitter, source.twitter)
      assert.equal(coin.information.twitter.tweets.length, source.twitter.recentTweetCount)
    }
  }

  assert.deepEqual(input, before)
})

test("enriches non-top trending coins without promoting them or duplicating trending tops", () => {
  const input = createInput()
  const result = addContext(input)
  const trending = result.coins.find(coin => coin.symbol === "DOGE")
  const top = result.coins.find(coin => coin.symbol === "XVG")

  assert.equal(input.sources.candidates.find(coin => coin.symbol === "DOGE").explanation, "")
  assert.equal(input.context.candidates.find(coin => coin.symbol === "DOGE").explanation, "")
  assert.equal(trending.explanation, "Информационный фон DOGE.")
  assert.equal(trending.topRank, null)
  assert.equal(trending.information.news.items.length, 1)
  assert.equal(trending.information.twitter.tweets.length, 8)
  assert.equal(top.explanation, "Исходное объяснение XVG. Информационный фон XVG.")
  assert.equal(top.topRank, 1)
  assert.equal(result.coins.filter(coin => coin.symbol === "XVG").length, 1)
  assert.equal(result.coins.filter(coin => coin.information).length, 6)
  assert.equal(result.coins.filter(coin => coin.topRank != null).length, 5)
  assert.equal(result.candidateCount, 7)
  assert.deepEqual(result.coins.map(coin => coin.symbol), input.report.coins.map(coin => coin.symbol))
})

test("leaves non-top coins without an exact trending flag untouched", () => {
  for (const features of [undefined, null, {}, { coingeckoTrending: false }, { coingeckoTrending: "true" }, { coingeckoTrending: 1 }]) {
    const input = createInput()
    input.report.coins.at(-1).features = features
    const result = addContext(input)

    assert.equal(result.coins.at(-1), input.report.coins.at(-1))
    assert.equal(Object.hasOwn(result.coins.at(-1), "information"), false)
  }
})

test("legacy enrichment direction predictions do not enter the report or change assessments and historical background", () => {
  const input = createInput()
  input.report.altMarketBackground = { status: "down", change4hPct: -1.5, breadth4h: 0.2, warning: null }
  const expected = addContext(input)
  for (const source of [input.sources, input.context]) {
    source.candidates.forEach((candidate) => {
      candidate.directionBias = "up"
    })
  }
  const before = structuredClone(input)
  const result = addContext(input)

  assert.deepEqual(result, expected)
  assert.doesNotMatch(JSON.stringify(result), /"directionBias"\s*:/)
  assert.deepEqual(result.altMarketBackground, input.report.altMarketBackground)
  for (const [index, coin] of result.coins.entries()) {
    for (const key of ["movementProbability", "estimateConfidence", "drivers", "counterSignals", "features"]) {
      assert.deepEqual(coin[key], input.report.coins[index][key])
    }
  }
  assert.deepEqual(input, before)
})

test("preserves empty and failed containers, errors, partial results and extra metadata", () => {
  const input = createInput()
  input.sources.candidates[0].news = { status: "empty", error: null, items: [], recentItemCount: 0 }
  input.sources.candidates[1].news = { status: "failed", error: "News unavailable", items: [] }
  input.sources.candidates[0].twitter.status = "failed"
  input.sources.candidates[0].twitter.error = "Second page unavailable"
  input.sources.candidates[1].twitter = { status: "empty", error: null, tweets: [], recentTweetCount: 0 }
  const trending = input.sources.candidates.find(coin => coin.symbol === "DOGE")
  trending.news.status = "failed"
  trending.news.error = "Partial news results"
  trending.twitter = { status: "empty", error: null, tweets: [], recentTweetCount: 0 }
  const before = structuredClone(input)
  const result = addContext(input)

  for (const coin of result.coins.filter(coin => coin.topRank != null || coin.features.coingeckoTrending === true)) {
    const source = input.sources.candidates.find(candidate => candidate.symbol === coin.symbol)
    assert.equal(coin.information.news, source.news)
    assert.equal(coin.information.twitter, source.twitter)
  }

  assert.equal(result.coins[0].information.twitter.tweets.length, 40)
  assert.equal(result.coins.find(coin => coin.symbol === "DOGE").information.news.items.length, 1)
  assert.deepEqual(input, before)
})

test("accepts trending-only enrichment when the report has no tops", () => {
  const input = createInput()
  input.report.coins = input.report.coins.filter(coin => coin.topRank == null)
  input.report.candidateCount = input.report.coins.length
  input.sources.candidates = input.sources.candidates.filter(coin => coin.symbol === "DOGE")
  input.context.candidates = input.context.candidates.filter(coin => coin.symbol === "DOGE")
  const result = addContext(input)

  assert.equal(result.candidateCount, 2)
  assert.equal(result.coins[0].topRank, null)
  assert.equal(result.coins[0].explanation, "Информационный фон DOGE.")
  assert.equal(result.coins[0].information.news, input.sources.candidates[0].news)
  assert.equal(result.coins[1], input.report.coins[1])
})

test("accepts an empty enrichment union with or without non-top coins", () => {
  for (const keepCoins of [true, false]) {
    const input = createInput()
    input.report.coins = keepCoins
      ? input.report.coins.map(coin => ({ ...coin, topRank: null, features: { ...coin.features, coingeckoTrending: false } }))
      : []
    input.report.candidateCount = input.report.coins.length
    input.sources.candidates = []
    input.context.candidates = []
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

test("rejects missing, extra, duplicate or malformed union members in either enrichment input", async (t) => {
  for (const source of ["sources", "context"]) {
    for (const [name, change, message] of [
      ["missing top", candidates => candidates.slice(1), /candidate set/],
      ["missing non-top trending", candidates => candidates.slice(0, -1), /candidate set/],
      ["extra plain non-top", candidates => [...candidates, { ...candidates[0], symbol: "BTC" }], /candidate set/],
      ["extra outsider", candidates => [...candidates, { ...candidates[0], symbol: "OTHER" }], /candidate set/],
      ["wrong top", candidates => [{ ...candidates[0], symbol: "OTHER" }, ...candidates.slice(1)], /candidate set/],
      ["wrong non-top trending", candidates => [...candidates.slice(0, -1), { ...candidates.at(-1), symbol: "BTC" }], /candidate set/],
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

test("rejects duplicate report union members", () => {
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

test("rejects missing or blank enriched explanations instead of falling back to the original", async (t) => {
  for (const symbol of ["XVG", "DOGE"]) {
    for (const value of [undefined, null, "", " \n ", 42, {}]) {
      await t.test(`${symbol}: ${String(value)}`, () => {
        const input = createInput()
        input.context.candidates.find(coin => coin.symbol === symbol).enrichedExplanation = value
        assert.throws(() => addContext(input), /enrichedExplanation must be a non-empty string/)
      })
    }
  }
})

test("rejects stale base explanations for tops and trending coins at any joining stage", async (t) => {
  for (const source of ["report", "sources", "context"]) {
    for (const symbol of ["XVG", "DOGE"]) {
      for (const value of [undefined, "Объяснение из другого анализа."]) {
        await t.test(`${source}: ${symbol}: ${value}`, () => {
          const input = createInput()
          const candidates = source === "report" ? input.report.coins : input[source].candidates
          candidates.find(coin => coin.symbol === symbol).explanation = value
          assert.throws(() => addContext(input), /base explanation does not match/)
        })
      }
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
