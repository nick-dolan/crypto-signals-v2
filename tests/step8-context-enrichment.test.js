import assert from "node:assert/strict"
import test from "node:test"

import { getModelSettings } from "../src/helpers/model-helper.js"
import modelsInUse from "../models-in-use.json" with { type: "json" }
import { enrichCandidatesWithContext } from "../src/steps/step8-context-enrichment/enrich-candidates-with-context.js"
import { InvalidContextEnrichmentError, parseContextEnrichment } from "../src/steps/step8-context-enrichment/parse-context-enrichment.js"

function createInput () {
  return {
    schemaVersion: 6,
    asOf: "2027-01-15T08:00:00.000Z",
    newsEnrichment: {
      source: "tradingview", from: "2027-01-14T08:00:00.000Z", asOf: "2027-01-15T08:00:00.000Z",
      lookbackHours: 24, maxItemsPerCandidate: 3,
    },
    twitterEnrichment: {
      source: "twitterapi.io", from: "2027-01-14T08:00:00.000Z", asOf: "2027-01-15T08:00:00.000Z",
      lookbackHours: 24, maxPagesPerCandidate: 2,
    },
    candidates: [
      {
        symbol: "SOL",
        name: "Solana",
        news: { status: "available", items: [{ id: "sol-news", title: "Network upgrade", publishedAt: "2027-01-15T07:00:00.000Z" }] },
        twitter: { status: "available", tweets: [{ id: "sol-tweet", text: "Upgrade launched", createdAt: "2027-01-15T07:10:00.000Z" }] },
      },
      {
        symbol: "BTC",
        name: "Bitcoin",
        news: { status: "empty", items: [] },
        twitter: { status: "empty", tweets: [] },
      },
    ],
  }
}

function createResponse (overrides = {}) {
  return {
    schemaVersion: 4,
    symbol: "SOL",
    newsSummary: "Объявлен запуск обновления сети.",
    twitterSummary: "Обсуждают объявленное обновление.",
    contextCaveat: "Твиты пересказывают одну новость, независимого подтверждения нет.",
    socialSignificant: true,
    socialReason: "Первичное сообщение подтверждает запуск существенного обновления.",
    socialSentiment: "bullish",
    ...overrides,
  }
}

test("summarizes before analysis, passes project identity and sampling limits, and skips empty sources", async () => {
  const input = createInput()
  input.candidates[0] = {
    ...input.candidates[0], movementProbability: 0.9, growthProbability: 0.8, explanation: "Must not be used",
    technicalSummary: { observation: "Must not be used", caveat: null },
    drivers: ["Must not be used"], counterSignals: ["Must not be used"],
    summary: { observation: "Old context", caveat: null }, enrichedExplanation: "Old context",
  }
  input.candidates.push({ ...input.candidates[0], symbol: "ETH", name: "Ethereum" })
  const before = structuredClone(input)
  const calls = []
  let active = 0
  let maximum = 0
  const result = await enrichCandidatesWithContext(input, "System prompt", {
    callAgent: async (systemPrompt, userMessage, options) => {
      active += 1
      maximum = Math.max(maximum, active)
      await new Promise(resolve => setImmediate(resolve))
      active -= 1
      const message = JSON.parse(userMessage)
      calls.push({ systemPrompt, message, options })
      return JSON.stringify(createResponse({ symbol: message.symbol }))
    },
  })
  const settings = getModelSettings("candidateContext")

  assert.equal(maximum, 1)
  assert.equal(calls.length, 2)
  assert.deepEqual(calls[0], {
    systemPrompt: "System prompt",
    message: {
      asOf: input.asOf, symbol: "SOL", name: "Solana",
      newsEnrichment: input.newsEnrichment, twitterEnrichment: input.twitterEnrichment,
      news: input.candidates[0].news, twitter: input.candidates[0].twitter,
    },
    options: settings,
  })
  assert.equal(result.schemaVersion, 9)
  assert.equal(result.asOf, input.asOf)
  assert.deepEqual(result.newsEnrichment, input.newsEnrichment)
  assert.deepEqual(result.twitterEnrichment, input.twitterEnrichment)
  assert.deepEqual(result.contextEnrichment, {
    source: `github-${settings.provider}`, model: settings.model,
    reasoningEffort: settings.reasoningEffort, candidateCallCount: 2,
  })
  const { schemaVersion, ...response } = createResponse()
  assert.equal(schemaVersion, 4)
  assert.deepEqual(result.candidates[0], {
    ...response, name: "Solana", newsStatus: "available", twitterStatus: "available",
  })
  assert.deepEqual(result.candidates.map(candidate => candidate.symbol), ["SOL", "BTC", "ETH"])
  assert.deepEqual(result.candidates[1], {
    symbol: "BTC", name: "Bitcoin", newsStatus: "empty", twitterStatus: "empty",
    newsSummary: null, twitterSummary: null,
    contextCaveat: "В доступной выборке за последние сутки публикаций нет.",
    socialSignificant: null, socialReason: null, socialSentiment: null,
  })
  assert.deepEqual(input, before)
})

test("follows the configured provider and model", async (t) => {
  const original = modelsInUse.candidateContext
  t.after(() => {
    modelsInUse.candidateContext = original
  })
  modelsInUse.candidateContext = { ...original, model: "configured-context-model", reasoningEffort: null }
  const settings = getModelSettings("candidateContext")
  const callAgent = t.mock.fn(async () => JSON.stringify(createResponse()))
  const result = await enrichCandidatesWithContext(createInput(), "System prompt", { callAgent })

  assert.equal(callAgent.mock.callCount(), 1)
  assert.deepEqual(callAgent.mock.calls[0].arguments[2], settings)
  assert.equal(result.contextEnrichment.model, "configured-context-model")
  assert.equal(result.contextEnrichment.reasoningEffort, null)
})

test("does not label absent or failed sources neutral and never calls the model without publications", async () => {
  for (const newsStatus of ["empty", "failed"]) {
    for (const twitterStatus of ["empty", "failed"]) {
      const input = createInput()
      input.candidates = [input.candidates[1]]
      input.candidates[0].news.status = newsStatus
      input.candidates[0].twitter.status = twitterStatus
      const result = await enrichCandidatesWithContext(input, "System prompt", {
        callAgent: async () => assert.fail("No source publications"),
      })
      const candidate = result.candidates[0]
      assert.equal(candidate.newsStatus, newsStatus)
      assert.equal(candidate.twitterStatus, twitterStatus)
      for (const field of ["newsSummary", "twitterSummary", "socialSignificant", "socialReason", "socialSentiment"]) {
        assert.equal(candidate[field], null)
      }
      assert.equal(result.contextEnrichment.candidateCallCount, 0)
      assert.match(candidate.contextCaveat, newsStatus === "failed" || twitterStatus === "failed" ? /ошибкой/ : /публикаций нет/)
    }
  }
})

test("allows a significant signal from one available source and retains the other source failure", async () => {
  for (const unavailable of ["news", "twitter"]) {
    const input = createInput()
    input.candidates = [input.candidates[0]]
    input.candidates[0][unavailable] = unavailable === "news"
      ? { status: "failed", items: [] }
      : { status: "failed", tweets: [] }
    const response = createResponse({ [`${unavailable}Summary`]: null, socialSentiment: "bearish" })
    const result = await enrichCandidatesWithContext(input, "System prompt", {
      callAgent: async () => JSON.stringify(response),
    })
    assert.equal(result.candidates[0][`${unavailable}Summary`], null)
    assert.equal(result.candidates[0][`${unavailable}Status`], "failed")
    assert.equal(result.candidates[0].socialSignificant, true)
    assert.equal(result.candidates[0].socialSentiment, "bearish")
    assert.equal(result.contextEnrichment.candidateCallCount, 1)
  }
})

test("preserves invalid responses for diagnostics and rejects invented missing-source summaries", async () => {
  for (const response of ["not JSON", JSON.stringify(createResponse({ symbol: "BTC" }))]) {
    await assert.rejects(enrichCandidatesWithContext(createInput(), "System prompt", {
      callAgent: async () => response,
    }), error => error instanceof InvalidContextEnrichmentError && error.symbol === "SOL" && error.response === response)
  }
  for (const unavailable of ["news", "twitter"]) {
    const input = createInput()
    input.candidates[0][unavailable] = unavailable === "news"
      ? { status: "empty", items: [] }
      : { status: "failed", tweets: [] }
    await assert.rejects(enrichCandidatesWithContext(input, "System prompt", {
      callAgent: async () => JSON.stringify(createResponse()),
    }), new RegExp(`${unavailable}Summary must be null without source publications`))
  }
})

test("assesses tone independently of significance and keeps unknown separate from neutral", () => {
  for (const socialSignificant of [true, false]) {
    for (const socialSentiment of ["bullish", "bearish", "mixed", "neutral"]) {
      const response = createResponse({ socialSignificant, socialSentiment })
      assert.deepEqual(parseContextEnrichment(JSON.stringify(response), "SOL"), response)
    }
  }
  const unknown = createResponse({ socialSignificant: null, socialReason: null, socialSentiment: null })
  assert.deepEqual(parseContextEnrichment(JSON.stringify(unknown), "SOL"), unknown)
})

test("trims summaries without losing publication timestamps", () => {
  const response = createResponse({ newsSummary: "я".repeat(300), twitterSummary: null, contextCaveat: null })
  assert.deepEqual(parseContextEnrichment(JSON.stringify(response), "SOL"), response)
  const padded = { ...createResponse(), newsSummary: " Новость.\n", twitterSummary: " Тема. ", contextCaveat: " Оговорка. " }
  assert.deepEqual(parseContextEnrichment(`\`\`\`json\n${JSON.stringify(padded)}\n\`\`\``, "SOL"), {
    ...padded, newsSummary: "Новость.", twitterSummary: "Тема.", contextCaveat: "Оговорка.",
  })
})

test("preserves complete text beyond the prompt length target without stopping later candidates", async () => {
  const input = createInput()
  input.candidates.push({ ...input.candidates[0], symbol: "RIVER", name: "River" })
  const twitterSummary = "В Twitter обсуждают получение и конвертацию баллов S6, сезон S7 и стейкинг RIVER; также встречаются рекламные описания Omni-CDP и разнонаправленные мнения о цене. Один пост от 6 октября 07:47 UTC утверждает, что открылись заявки S6 для 7 000 пользователей, но автор не проверял условия и результат конвертации."
  assert.equal(twitterSummary.length, 310)
  const longText = "Первичный источник не подтвердил событие. ".repeat(9)
  const response = createResponse({
    newsSummary: longText, twitterSummary, contextCaveat: longText, socialReason: longText,
  })
  const calls = []
  const output = await enrichCandidatesWithContext(input, "System prompt", {
    callAgent: async (_, userMessage) => {
      const { symbol } = JSON.parse(userMessage)
      calls.push(symbol)
      return JSON.stringify({ ...response, symbol })
    },
  })

  assert.deepEqual(calls, ["SOL", "RIVER"])
  for (const candidate of output.candidates.filter(candidate => candidate.symbol !== "BTC")) {
    for (const field of ["newsSummary", "twitterSummary", "contextCaveat", "socialReason"]) {
      assert.equal(candidate[field], response[field].trim())
    }
  }
})

test("rejects malformed summaries, legacy schema, missing fields and invalid significance", () => {
  for (const field of Object.keys(createResponse())) {
    const response = createResponse()
    delete response[field]
    assert.throws(() => parseContextEnrichment(JSON.stringify(response), "SOL"), /unexpected structure/)
  }
  for (const field of ["newsSummary", "twitterSummary", "contextCaveat"]) {
    for (const value of ["", " \n ", false, 42, {}, []]) {
      assert.throws(() => parseContextEnrichment(JSON.stringify(createResponse({ [field]: value })), "SOL"), new RegExp(field))
    }
  }
  for (const overrides of [
    { schemaVersion: 3 }, { extra: true }, { socialSentiment: "positive" }, { socialSentiment: "negative" },
    { socialSignificant: "true" }, { socialSentiment: null }, { socialReason: null },
    { socialReason: "" }, { socialReason: " \n " },
    { socialSignificant: null }, { socialSignificant: false, socialSentiment: null },
    { socialSignificant: false, socialSentiment: null, socialReason: null },
  ]) {
    assert.throws(() => parseContextEnrichment(JSON.stringify(createResponse(overrides)), "SOL"), InvalidContextEnrichmentError)
  }
})

test("retains event timing after the market cutoff for the main analysis", async () => {
  const input = createInput()
  input.newsEnrichment.asOf = "2027-01-15T09:30:00.000Z"
  input.twitterEnrichment.asOf = input.newsEnrichment.asOf
  input.candidates[0].news.items[0].publishedAt = "2027-01-15T09:15:00.000Z"
  const response = createResponse({
    newsSummary: "15 января 2027, 09:15 UTC: объявлен запуск обновления сети.",
    contextCaveat: "Публикация позже рыночного среза 09:00 UTC; реакция цены ещё не наблюдается в данных.",
  })
  const result = await enrichCandidatesWithContext(input, "System prompt", {
    callAgent: async (_, userMessage) => {
      const message = JSON.parse(userMessage)
      assert.equal(message.asOf, "2027-01-15T08:00:00.000Z")
      assert.equal(message.newsEnrichment.asOf, "2027-01-15T09:30:00.000Z")
      assert.equal(message.news.items[0].publishedAt, "2027-01-15T09:15:00.000Z")
      return JSON.stringify(response)
    },
  })
  assert.equal(result.candidates[0].newsSummary, response.newsSummary)
  assert.equal(result.candidates[0].contextCaveat, response.contextCaveat)
})

test("validates input candidates, source arrays, statuses, prompt and agent", async () => {
  await assert.rejects(enrichCandidatesWithContext({}, "Prompt"), /Step 7 enrichment candidates are required/)
  await assert.rejects(enrichCandidatesWithContext(createInput(), ""), /system prompt is required/)
  await assert.rejects(enrichCandidatesWithContext(createInput(), "Prompt", { callAgent: null }), /agent must be a function/)
  for (const source of ["news", "twitter"]) {
    const input = createInput()
    delete input.candidates[0][source]
    await assert.rejects(enrichCandidatesWithContext(input, "Prompt"), new RegExp(source))
    input.candidates[0][source] = source === "news" ? { status: "unknown", items: [] } : { status: "unknown", tweets: [] }
    await assert.rejects(enrichCandidatesWithContext(input, "Prompt"), /status is invalid/)
  }
  const input = createInput()
  input.candidates[1].symbol = "sol"
  await assert.rejects(enrichCandidatesWithContext(input, "Prompt"), /duplicate symbol SOL/)
})
