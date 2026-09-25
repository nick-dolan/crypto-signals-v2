import assert from "node:assert/strict"
import test from "node:test"

import { isNaN } from "../src/helpers/utils.typed.js"
import { enrichTopCandidatesWithContext } from "../src/steps/step10-context-enrichment/enrich-top-candidates-with-context.js"
import {
  InvalidContextEnrichmentError,
  parseContextEnrichment,
} from "../src/steps/step10-context-enrichment/parse-context-enrichment.js"

function createInput () {
  return {
    schemaVersion: 5,
    generatedAt: "2027-01-15T08:02:00.000Z",
    asOf: "2027-01-15T08:00:00.000Z",
    newsEnrichment: { source: "tradingview", lookbackHours: 24 },
    twitterEnrichment: { source: "twitterapi.io", lookbackHours: 24 },
    candidates: [
      {
        symbol: "SOL",
        movementProbability: 0.7,
        explanation: "После затишья торговая активность начинает оживать.",
        drivers: ["Торговая активность растёт."],
        counterSignals: ["Пробоя ещё нет."],
        news: {
          status: "available",
          items: [{ title: "Solana update", content: "A network update shipped." }],
        },
        twitter: {
          status: "available",
          tweets: [{ text: "Developers discuss the update.", viewCount: 500 }],
        },
      },
      {
        symbol: "BTC",
        movementProbability: 0.6,
        explanation: "Рынок готовится к возможному выходу из диапазона.",
        news: { status: "empty", items: [] },
        twitter: { status: "empty", tweets: [] },
      },
    ],
  }
}

function createResponse (overrides = {}) {
  return {
    schemaVersion: 2,
    symbol: "SOL",
    informationBackground: "Информационный фон частично подтверждает картину.",
    socialSignificant: true,
    socialReason: "Запущено важное обновление сети, его обсуждают независимые разработчики.",
    socialSentiment: "positive",
    ...overrides,
  }
}

test("uses one sequential Gemini call per candidate and adds explanations and social assessments", async () => {
  const input = createInput()
  const before = structuredClone(input)
  const calls = []
  let activeCallCount = 0
  let maximumActiveCallCount = 0
  const result = await enrichTopCandidatesWithContext(
    input,
    "System prompt",
    {
      callAgent: async (systemPrompt, userMessage, options) => {
        activeCallCount += 1
        maximumActiveCallCount = Math.max(maximumActiveCallCount, activeCallCount)
        await new Promise(resolve => setImmediate(resolve))

        const message = JSON.parse(userMessage)
        const informationBackground = message.symbol === "SOL"
          ? "Свежие сообщения о техническом обновлении частично подтверждают рост внимания."
          : "Свежий информационный фон пока не подтверждает исходную картину."

        calls.push({ systemPrompt, message, options })
        activeCallCount -= 1

        return JSON.stringify(createResponse({
          symbol: message.symbol,
          informationBackground,
          ...(message.symbol === "BTC"
            ? {
                socialSignificant: null,
                socialReason: "Свежих публикаций нет.",
                socialSentiment: null,
              }
            : {}),
        }))
      },
    },
  )

  assert.equal(maximumActiveCallCount, 1)
  assert.equal(calls.length, 2)
  assert.deepEqual(calls.map(call => call.options), [
    { model: "gemini-3.7-flash", reasoningEffort: "medium" },
    { model: "gemini-3.7-flash", reasoningEffort: "medium" },
  ])
  assert.deepEqual(calls[0], {
    systemPrompt: "System prompt",
    message: {
      asOf: input.asOf,
      symbol: "SOL",
      explanation: input.candidates[0].explanation,
      news: input.candidates[0].news,
      twitter: input.candidates[0].twitter,
    },
    options: { model: "gemini-3.7-flash", reasoningEffort: "medium" },
  })
  assert.equal(result.schemaVersion, 7)
  assert.ok(!isNaN(Date.parse(result.generatedAt)))
  assert.deepEqual(result.contextEnrichment, {
    source: "github-copilot-unofficial",
    model: "gemini-3.7-flash",
    reasoningEffort: "medium",
    candidateCallCount: 2,
  })
  assert.equal(
    result.candidates[0].enrichedExplanation,
    `${input.candidates[0].explanation} Свежие сообщения о техническом обновлении частично подтверждают рост внимания.`,
  )
  assert.equal(
    result.candidates[1].enrichedExplanation,
    `${input.candidates[1].explanation} Свежий информационный фон пока не подтверждает исходную картину.`,
  )
  assert.equal(Object.hasOwn(result.candidates[0], "news"), false)
  assert.equal(Object.hasOwn(result.candidates[0], "twitter"), false)
  assert.deepEqual(result.candidates.map(({ socialSignificant, socialReason, socialSentiment }) => (
    { socialSignificant, socialReason, socialSentiment }
  )), [
    { socialSignificant: true, socialReason: createResponse().socialReason, socialSentiment: "positive" },
    { socialSignificant: null, socialReason: "Свежих публикаций нет.", socialSentiment: null },
  ])
  for (const [index, candidate] of result.candidates.entries()) {
    for (const field of ["movementProbability", "explanation", "drivers", "counterSignals"]) {
      assert.deepEqual(candidate[field], input.candidates[index][field])
    }
  }
  assert.deepEqual(input, before)
})

test("uses assessment arguments for a trending coin without a top explanation", async () => {
  const input = createInput()
  input.candidates = [{
    ...input.candidates[0],
    explanation: "",
    drivers: ["Внимание растёт раньше цены."],
    counterSignals: ["Объём ещё не подтверждает интерес."],
  }]
  const before = structuredClone(input)
  const messages = []
  const result = await enrichTopCandidatesWithContext(input, "System prompt", {
    callAgent: async (_, userMessage) => {
      const message = JSON.parse(userMessage)
      messages.push(message)
      return JSON.stringify(createResponse({
        symbol: message.symbol,
        informationBackground: "Обсуждения обновления подтверждают рост внимания, но не торговой активности.",
      }))
    },
  })

  assert.deepEqual(messages, [{
    asOf: input.asOf,
    symbol: "SOL",
    explanation: "",
    drivers: input.candidates[0].drivers,
    counterSignals: input.candidates[0].counterSignals,
    news: input.candidates[0].news,
    twitter: input.candidates[0].twitter,
  }])
  assert.deepEqual(result.candidates, [{
    symbol: "SOL",
    movementProbability: 0.7,
    explanation: "",
    drivers: input.candidates[0].drivers,
    counterSignals: input.candidates[0].counterSignals,
    enrichedExplanation: "Обсуждения обновления подтверждают рост внимания, но не торговой активности.",
    socialSignificant: true,
    socialReason: createResponse().socialReason,
    socialSentiment: "positive",
  }])
  assert.equal(result.contextEnrichment.candidateCallCount, 1)
  assert.deepEqual(input, before)
})

test("accepts JSON wrapped in one Markdown fence and trims both explanations", () => {
  const response = createResponse()
  const padded = {
    ...response,
    informationBackground: ` ${response.informationBackground}\n`,
    socialReason: ` ${response.socialReason}\n`,
  }
  assert.deepEqual(
    parseContextEnrichment(`\`\`\`json\n${JSON.stringify(padded)}\n\`\`\``, "SOL"),
    response,
  )
})

test("rejects an invalid agent response and preserves it for diagnostics", async () => {
  await assert.rejects(
    enrichTopCandidatesWithContext(createInput(), "System prompt", {
      callAgent: async () => "not JSON",
    }),
    (error) => {
      assert.ok(error instanceof InvalidContextEnrichmentError)
      assert.equal(error.symbol, "SOL")
      assert.equal(error.response, "not JSON")
      assert.match(error.message, /not valid JSON/)
      return true
    },
  )

  assert.throws(
    () => parseContextEnrichment(JSON.stringify(createResponse({ symbol: "BTC" })), "SOL"),
    /symbol does not match/,
  )
})

test("accepts all four significant sentiments and keeps noise separate from unknown", () => {
  for (const socialSentiment of ["positive", "negative", "mixed", "neutral"]) {
    const response = createResponse({ socialSentiment })
    assert.deepEqual(parseContextEnrichment(JSON.stringify(response), "SOL"), response)
  }
  for (const socialSignificant of [false, null]) {
    const response = createResponse({ socialSignificant, socialSentiment: null })
    assert.deepEqual(parseContextEnrichment(JSON.stringify(response), "SOL"), response)
  }
  const unknown = createResponse({ socialSignificant: null, socialReason: null, socialSentiment: null })
  assert.deepEqual(parseContextEnrichment(JSON.stringify(unknown), "SOL"), unknown)
})

test("rejects missing, extra or malformed social assessment fields", async (t) => {
  for (const field of ["socialSignificant", "socialReason", "socialSentiment"]) {
    await t.test(`missing ${field}`, () => {
      const response = createResponse()
      delete response[field]
      assert.throws(() => parseContextEnrichment(JSON.stringify(response), "SOL"), /unexpected structure/)
    })
  }
  for (const [overrides, message] of [
    [{ schemaVersion: 1 }, /schemaVersion must equal 2/],
    [{ extra: true }, /unexpected structure/],
    [{ socialSignificant: "true" }, /socialSignificant/],
    [{ socialSignificant: 1 }, /socialSignificant/],
    [{ socialSignificant: {} }, /socialSignificant/],
    [{ socialReason: null }, /socialReason/],
    [{ socialReason: 42 }, /socialReason/],
    [{ socialReason: " \n " }, /socialReason/],
    [{ socialReason: "a".repeat(301) }, /socialReason/],
    [{ socialSentiment: null }, /socialSentiment/],
    [{ socialSentiment: "bullish" }, /socialSentiment/],
    [{ socialSentiment: "Positive" }, /socialSentiment/],
    [{ socialSignificant: false }, /socialSentiment/],
    [{ socialSignificant: null }, /socialSentiment/],
    [{ socialSignificant: false, socialSentiment: null, socialReason: null }, /socialReason/],
    [{ socialSignificant: null, socialSentiment: null, socialReason: "" }, /socialReason/],
  ]) {
    await t.test(JSON.stringify(overrides), () => {
      assert.throws(
        () => parseContextEnrichment(JSON.stringify(createResponse(overrides)), "SOL"),
        error => error instanceof InvalidContextEnrichmentError && message.test(error.message),
      )
    })
  }
})

test("keeps unknown significance when both sources are empty or failed", async () => {
  for (const status of ["empty", "failed"]) {
    const input = createInput()
    input.candidates = [input.candidates[1]]
    input.candidates[0].news.status = status
    input.candidates[0].twitter.status = status
    let callCount = 0
    const result = await enrichTopCandidatesWithContext(input, "System prompt", {
      callAgent: async () => {
        callCount += 1
        return JSON.stringify(createResponse({
          symbol: "BTC",
          socialSignificant: null,
          socialReason: "Свежие публикации недоступны.",
          socialSentiment: null,
        }))
      },
    })
    assert.equal(callCount, 1)
    assert.equal(result.candidates[0].socialSignificant, null)
    assert.equal(result.candidates[0].socialSentiment, null)
    assert.equal(result.candidates[0].socialReason, "Свежие публикации недоступны.")
  }
})

test("rejects a definite significance assessment without source publications and preserves the response", async () => {
  for (const socialSignificant of [true, false]) {
    const input = createInput()
    input.candidates = [input.candidates[1]]
    const response = JSON.stringify(createResponse({
      symbol: "BTC", socialSignificant, socialSentiment: socialSignificant ? "positive" : null,
    }))
    await assert.rejects(enrichTopCandidatesWithContext(input, "System prompt", {
      callAgent: async () => response,
    }), (error) => {
      assert.ok(error instanceof InvalidContextEnrichmentError)
      assert.match(error.message, /must be null without source publications/)
      assert.equal(error.symbol, "BTC")
      assert.equal(error.response, response)
      return true
    })
  }
})

test("one usable source is enough and social sentiment never changes technical assessments", async () => {
  for (const socialSentiment of ["positive", "negative", "mixed", "neutral"]) {
    for (const unavailable of ["news", "twitter"]) {
      const input = createInput()
      input.candidates = [input.candidates[0]]
      input.candidates[0][unavailable] = unavailable === "news"
        ? { status: "failed", items: [] }
        : { status: "failed", tweets: [] }
      const before = structuredClone(input)
      const response = createResponse({ socialSentiment })
      const result = await enrichTopCandidatesWithContext(input, "System prompt", {
        callAgent: async () => JSON.stringify(response),
      })
      assert.equal(result.candidates[0].socialSignificant, true)
      assert.equal(result.candidates[0].socialSentiment, socialSentiment)
      assert.equal(result.candidates[0].socialReason, response.socialReason)
      assert.equal(result.candidates[0].movementProbability, input.candidates[0].movementProbability)
      assert.deepEqual(result.candidates[0].drivers, input.candidates[0].drivers)
      assert.deepEqual(result.candidates[0].counterSignals, input.candidates[0].counterSignals)
      assert.equal(result.contextEnrichment.candidateCallCount, 1)
      assert.deepEqual(input, before)
    }
  }
})

test("validates the step 9 input, prompt, and agent", async () => {
  await assert.rejects(
    enrichTopCandidatesWithContext({}, "System prompt", {
      callAgent: async () => "{}",
    }),
    /Step 9 enrichment candidates are required/,
  )

  const input = createInput()
  delete input.candidates[0].twitter

  await assert.rejects(
    enrichTopCandidatesWithContext(input, "System prompt", {
      callAgent: async () => "{}",
    }),
    /twitter data are required/,
  )

  await assert.rejects(
    enrichTopCandidatesWithContext(createInput(), "", {
      callAgent: async () => "{}",
    }),
    /system prompt is required/,
  )

  await assert.rejects(
    enrichTopCandidatesWithContext(createInput(), "System prompt", {
      callAgent: null,
    }),
    /agent must be a function/,
  )
})
