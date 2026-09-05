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
    marketContext: {
      breadth4h: 0.199,
    },
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
      {
        coin: {
          symbol: "SOL",
          baseCurrencyId: "XTVCSOL",
          marketSymbol: "BINANCE:SOLUSDT.P",
        },
      },
      {
        coin: {
          symbol: "BTC",
          baseCurrencyId: "XTVCBTC",
          marketSymbol: "BINANCE:BTCUSDT.P",
        },
      },
    ],
  }
}

function createAgentResponse () {
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
        drivers: [
          { fields: ["rvRatio"], text: "волатильность сжата" },
        ],
        counterSignals: [],
      },
      {
        symbol: "BTC",
        movementProbability: 0.4,
        estimateConfidence: "low",
        directionBias: "up",
        drivers: [
          { fields: ["rvRatio"], text: "присутствует умеренное сжатие" },
        ],
        counterSignals: [
          { fields: ["volumeZ"], text: "свежий объёмный триггер слаб" },
        ],
      },
    ],
  }
}

function createAnalysis () {
  const analysis = createAgentResponse()

  analysis.assessments[0].drivers = ["rvRatio=0.6: волатильность сжата"]
  analysis.assessments[1].drivers = [
    "rvRatio=0.9: присутствует умеренное сжатие",
  ]
  analysis.assessments[1].counterSignals = [
    "volumeZ=0.2: свежий объёмный триггер слаб",
  ]

  return analysis
}

test("agent analysis parser inserts exact payload values into evidence", () => {
  assert.deepEqual(
    parseAgentAnalysis(JSON.stringify(createAgentResponse()), createPayload()),
    createAnalysis(),
  )
})

test("agent analysis parser inserts exact market context values into evidence", () => {
  const response = createAgentResponse()
  response.assessments[1].counterSignals = [
    {
      fields: ["volumeZ", "breadth4h"],
      text: "слабый объём совпадает с узким рынком",
    },
  ]

  const analysis = parseAgentAnalysis(JSON.stringify(response), createPayload())

  assert.deepEqual(
    analysis.assessments[1].counterSignals,
    ["volumeZ=0.2 и breadth4h=0.199: слабый объём совпадает с узким рынком"],
  )
})

test("agent analysis parser rejects invalid JSON and inconsistent top candidates", () => {
  assert.throws(
    () => parseAgentAnalysis("```json\n{}\n```", createPayload()),
    /not valid JSON/,
  )

  const analysis = createAgentResponse()
  analysis.topCandidates.reverse()

  assert.throws(
    () => parseAgentAnalysis(JSON.stringify(analysis), createPayload()),
    /does not match assessments/,
  )
})

test("agent analysis parser keeps explanations grounded and human-readable", () => {
  const analysis = createAgentResponse()
  analysis.topCandidates[0].explanation = "rvRatio=0.6 указывает на движение"

  assert.throws(
    () => parseAgentAnalysis(JSON.stringify(analysis), createPayload()),
    /invalid explanation/,
  )

  analysis.topCandidates[0].explanation = "Торговая активность оживает"
  analysis.assessments[0].drivers = [
    { fields: ["madeUpMetric"], text: "сильный сигнал" },
  ]

  assert.throws(
    () => parseAgentAnalysis(JSON.stringify(analysis), createPayload()),
    /unknown field madeUpMetric/,
  )

  analysis.assessments[0].drivers = [
    { fields: ["rvRatio", "rvRatio"], text: "волатильность сжата" },
  ]

  assert.throws(
    () => parseAgentAnalysis(JSON.stringify(analysis), createPayload()),
    /one to three unique payload fields/,
  )

  analysis.assessments[0].drivers = [
    { fields: ["rvRatio"], text: "rvRatio=0.7 означает сжатие" },
  ]

  assert.throws(
    () => parseAgentAnalysis(JSON.stringify(analysis), createPayload()),
    /short interpretation text/,
  )
})

test("candidate analysis uses GPT-5.6 Sol with medium reasoning and one safe tool", async () => {
  const payload = createPayload()
  const shortlist = createShortlist()
  const expected = createAnalysis()
  expected.candidateCount = 2
  expected.assessments[0].tradingViewUrl = "https://www.tradingview.com/chart/?symbol=BINANCE:SOLUSDT.P"
  expected.assessments[1].tradingViewUrl = "https://www.tradingview.com/chart/?symbol=BINANCE:BTCUSDT.P"
  expected.topCandidates[0].directionBias = "unclear"
  expected.topCandidates[0].estimateConfidence = "medium"
  expected.topCandidates[0].drivers = expected.assessments[0].drivers
  expected.topCandidates[0].counterSignals = expected.assessments[0].counterSignals
  expected.topCandidates[0].tradingViewUrl = expected.assessments[0].tradingViewUrl
  expected.topCandidates[1].directionBias = "up"
  expected.topCandidates[1].estimateConfidence = "low"
  expected.topCandidates[1].drivers = expected.assessments[1].drivers
  expected.topCandidates[1].counterSignals = expected.assessments[1].counterSignals
  expected.topCandidates[1].tradingViewUrl = expected.assessments[1].tradingViewUrl
  let captured
  const result = await analyzeCandidates(payload, shortlist, "system prompt", {
    callAgent: async (systemPrompt, userMessage, options) => {
      captured = { systemPrompt, userMessage, options }
      return JSON.stringify(createAgentResponse())
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

test("candidate analysis exposes one invalid response without retrying", async () => {
  const analysis = createAgentResponse()
  analysis.assessments[0].drivers[0].fields = ["madeUpMetric"]
  const response = JSON.stringify(analysis)
  let callCount = 0

  await assert.rejects(
    analyzeCandidates(createPayload(), createShortlist(), "system prompt", {
      callAgent: async () => {
        callCount += 1
        return response
      },
    }),
    (error) => {
      assert.match(error.message, /unknown field madeUpMetric/)
      assert.equal(error.response, response)
      return true
    },
  )

  assert.equal(callCount, 1)
})

test("candidate analysis requires market symbols before calling Copilot", async () => {
  const shortlist = createShortlist()
  delete shortlist.candidates[0].coin.marketSymbol

  await assert.rejects(
    analyzeCandidates(createPayload(), shortlist, "system prompt", {
      callAgent: async () => {
        throw new Error("Copilot must not be called")
      },
    }),
    /do not define market symbols/,
  )
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
