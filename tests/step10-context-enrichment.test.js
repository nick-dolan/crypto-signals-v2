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

test("uses one sequential Gemini call per candidate and adds enriched explanations", async () => {
  const input = createInput()
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

        return JSON.stringify({
          schemaVersion: 1,
          symbol: message.symbol,
          informationBackground,
        })
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
  assert.equal(result.schemaVersion, 6)
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
      return JSON.stringify({
        schemaVersion: 1,
        symbol: message.symbol,
        informationBackground: "Обсуждения обновления подтверждают рост внимания, но не торговой активности.",
      })
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
  }])
  assert.equal(result.contextEnrichment.candidateCallCount, 1)
  assert.deepEqual(input, before)
})

test("accepts JSON wrapped in one Markdown fence", () => {
  assert.deepEqual(
    parseContextEnrichment(`\`\`\`json
{
  "schemaVersion": 1,
  "symbol": "SOL",
  "informationBackground": "Информационный фон частично подтверждает картину."
}
\`\`\``, "SOL"),
    {
      schemaVersion: 1,
      symbol: "SOL",
      informationBackground: "Информационный фон частично подтверждает картину.",
    },
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
    () => parseContextEnrichment(JSON.stringify({
      schemaVersion: 1,
      symbol: "BTC",
      informationBackground: "Фон отсутствует.",
    }), "SOL"),
    /symbol does not match/,
  )
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
