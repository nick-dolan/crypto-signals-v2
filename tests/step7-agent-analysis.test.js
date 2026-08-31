import assert from "node:assert/strict"
import test from "node:test"

import { analyzeCandidates } from "../src/steps/step7-agent-analysis/analyze-candidates.js"
import { parseAgentAnalysis } from "../src/steps/step7-agent-analysis/parse-agent-analysis.js"

function createPayload () {
  return {
    schemaVersion: 2,
    asOf: "2026-08-31T09:00:00.000Z",
    timeframe: "1h",
    candidateCount: 2,
    schema: ["symbol", "rvRatio", "volumeZ"],
    candidates: [
      ["SOL", 0.6, 1.4],
      ["BTC", 0.9, 0.2],
    ],
  }
}

function createShortlist () {
  return {
    asOf: "2026-08-31T09:00:00.000Z",
    timeframe: "1h",
    candidateCount: 2,
    candidates: [
      { coin: { symbol: "SOL", baseCurrencyId: "XTVCSOL" } },
      { coin: { symbol: "BTC", baseCurrencyId: "XTVCBTC" } },
    ],
  }
}

function createAnalysis () {
  return {
    schemaVersion: 1,
    asOf: "2026-08-31T09:00:00.000Z",
    topCandidates: [
      {
        symbol: "SOL",
        movementProbability: 0.7,
        explanation: "После затишья торговая активность оживает одновременно с накоплением позиций. Это повышает вероятность резкого выхода из диапазона.",
      },
      {
        symbol: "BTC",
        movementProbability: 0.4,
        explanation: "Активность участников усиливается, но подтверждение пока остаётся неполным. Резкое движение возможно, хотя сигнал выглядит слабее лидера.",
      },
    ],
    assessments: [
      {
        symbol: "SOL",
        movementProbability: 0.7,
        estimateConfidence: "medium",
        directionBias: "unclear",
        drivers: ["rvRatio=0.6: волатильность сжата"],
        counterSignals: [],
      },
      {
        symbol: "BTC",
        movementProbability: 0.4,
        estimateConfidence: "low",
        directionBias: "up",
        drivers: ["rvRatio=0.9: присутствует умеренное сжатие"],
        counterSignals: ["volumeZ=0.2: свежий объёмный триггер слаб"],
      },
    ],
  }
}

test("agent analysis parser accepts the exact response contract", () => {
  const analysis = createAnalysis()

  assert.deepEqual(
    parseAgentAnalysis(JSON.stringify(analysis), createPayload()),
    analysis,
  )
})

test("agent analysis parser rejects invalid JSON and inconsistent top candidates", () => {
  assert.throws(
    () => parseAgentAnalysis("```json\n{}\n```", createPayload()),
    /not valid JSON/,
  )

  const analysis = createAnalysis()
  analysis.topCandidates.reverse()

  assert.throws(
    () => parseAgentAnalysis(JSON.stringify(analysis), createPayload()),
    /does not match assessments/,
  )
})

test("agent analysis parser keeps explanations grounded and human-readable", () => {
  const analysis = createAnalysis()
  analysis.topCandidates[0].explanation = "rvRatio=0.6 указывает на движение"

  assert.throws(
    () => parseAgentAnalysis(JSON.stringify(analysis), createPayload()),
    /invalid explanation/,
  )

  analysis.topCandidates[0].explanation = "Торговая активность оживает"
  analysis.assessments[0].drivers = ["madeUpMetric=999: сильный сигнал"]

  assert.throws(
    () => parseAgentAnalysis(JSON.stringify(analysis), createPayload()),
    /known field/,
  )

  analysis.assessments[0].drivers = ["rvRatio=0.7: волатильность сжата"]

  assert.throws(
    () => parseAgentAnalysis(JSON.stringify(analysis), createPayload()),
    /does not match rvRatio/,
  )

  analysis.assessments[0].drivers = ["openInterest=999999: позиции растут"]

  assert.throws(
    () => parseAgentAnalysis(JSON.stringify(analysis), createPayload()),
    /unknown field openInterest/,
  )

  analysis.assessments[0].drivers = [
    "rvRatio=0.6; madeUpMetric=999: сильный сигнал",
  ]

  assert.throws(
    () => parseAgentAnalysis(JSON.stringify(analysis), createPayload()),
    /unknown field madeUpMetric/,
  )
})

test("candidate analysis uses GPT-5.6 Sol with medium reasoning and one safe tool", async () => {
  const payload = createPayload()
  const shortlist = createShortlist()
  const expected = createAnalysis()
  let captured
  const result = await analyzeCandidates(payload, shortlist, "system prompt", {
    callAgent: async (systemPrompt, userMessage, options) => {
      captured = { systemPrompt, userMessage, options }
      return JSON.stringify(expected)
    },
  })

  assert.deepEqual(result, expected)
  assert.equal(captured.systemPrompt, "system prompt")
  assert.deepEqual(JSON.parse(captured.userMessage), payload)
  assert.equal(captured.options.model, "GPT-5.6 Sol")
  assert.equal(captured.options.reasoningEffort, "medium")
  assert.equal(captured.options.tools.length, 1)
  assert.equal(captured.options.tools[0].name, "get_coin_history")
})

test("candidate analysis rejects mismatched step 5 and step 6 snapshots", async () => {
  const shortlist = createShortlist()
  shortlist.asOf = "2026-08-31T08:00:00.000Z"

  await assert.rejects(
    analyzeCandidates(createPayload(), shortlist, "system prompt", {
      callAgent: async () => {
        throw new Error("Copilot must not be called")
      },
    }),
    /different market snapshots/,
  )
})
