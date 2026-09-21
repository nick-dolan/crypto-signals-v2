import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

import { analyzeCandidates } from "../src/steps/step7-agent-analysis/analyze-candidates.js"
import { parseAgentAnalysis } from "../src/steps/step7-agent-analysis/parse-agent-analysis.js"

function createPayload () {
  return {
    schemaVersion: 10,
    asOf: "2026-08-31T09:00:00.000Z",
    timeframe: "1h",
    candidateCount: 2,
    marketContext: {
      breadth4h: 0.199,
    },
    schema: { volatility: ["rvRatio"], volume: ["volumeZ"] },
    candidates: [
      { symbol: "SOL", name: "Solana", selectionRank: 1, volatility: [0.6], volume: [1.4], flags: [] },
      { symbol: "BTC", name: "Bitcoin", selectionRank: 2, volatility: [0.9], volume: [0.2], flags: [] },
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
        drivers: [
          { fields: ["rvRatio"], text: "волатильность сжата" },
        ],
        counterSignals: [],
      },
      {
        symbol: "BTC",
        movementProbability: 0.4,
        estimateConfidence: "low",
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

test("analysis and context prompts do not request a direction forecast", async () => {
  const [analysisPrompt, contextPrompt] = await Promise.all([
    readFile(new URL("../src/prompts/strong-move-probability.md", import.meta.url), "utf8"),
    readFile(new URL("../src/prompts/candidate-context-enrichment.md", import.meta.url), "utf8"),
  ])

  assert.ok(analysisPrompt.includes("P(|движение| > 2.5 ATR в следующие 4–12 часов)"))
  for (const prompt of [analysisPrompt, contextPrompt]) {
    assert.match(prompt, /[Нн]е прогнозируй рост или падение/)
    assert.doesNotMatch(prompt, /directionBias|не меняй направление прогноза/)
  }

  const example = JSON.parse(analysisPrompt.match(/```json\n([\s\S]*?)\n```/)[1])
  assert.deepEqual(Object.keys(example.assessments[0]), [
    "symbol", "movementProbability", "estimateConfidence", "drivers", "counterSignals",
  ])
})

test("agent analysis parser rejects a direction forecast as an extra field", () => {
  for (const group of ["assessments", "topCandidates"]) {
    const response = createAgentResponse()
    response[group][0].directionBias = "up"

    assert.throws(
      () => parseAgentAnalysis(JSON.stringify(response), createPayload()),
      /unexpected structure/,
    )
  }
})

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

test("agent analysis parser preserves the structured alt-market background in evidence", () => {
  for (const background of [
    { status: "down", change4hPct: -0.000000001, breadth4h: 0.449999999, warning: null },
    { status: "unavailable", change4hPct: null, breadth4h: 0.2, warning: "TOTAL3ES недоступен" },
    null,
  ]) {
    const payload = createPayload()
    payload.marketContext.altMarketBackground = background
    const response = createAgentResponse()
    response.assessments[1].counterSignals = [
      { fields: ["altMarketBackground"], text: "общий фон учитывается отдельно от признаков монеты" },
    ]
    const analysis = parseAgentAnalysis(JSON.stringify(response), payload)

    assert.deepEqual(analysis.assessments[1].counterSignals, [
      `altMarketBackground=${JSON.stringify(background)}: общий фон учитывается отдельно от признаков монеты`,
    ])
  }
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

test("agent analysis allows no alerts or a shorter top without losing assessments", () => {
  for (const selected of [[], [0], [1]]) {
    const response = createAgentResponse()
    response.topCandidates = selected.map(index => response.topCandidates[index])
    const parsed = parseAgentAnalysis(JSON.stringify(response), createPayload())

    assert.equal(parsed.topCandidates.length, selected.length)
    assert.deepEqual(parsed.assessments, createAnalysis().assessments)
  }
})

test("top candidates reject unknown symbols, duplicates and more than five entries", () => {
  const response = createAgentResponse()
  response.topCandidates[0].symbol = "UNKNOWN"
  assert.throws(() => parseAgentAnalysis(JSON.stringify(response), createPayload()), /unique assessed symbols/)

  response.topCandidates = Array(2).fill(createAgentResponse().topCandidates[0])
  assert.throws(() => parseAgentAnalysis(JSON.stringify(response), createPayload()), /unique assessed symbols/)

  const payload = createPayload()
  payload.candidateCount = 6
  payload.candidates = Array.from({ length: 6 }, (_, index) => ({
    ...createPayload().candidates[0], symbol: `COIN${index}`, selectionRank: index + 1,
  }))
  response.assessments = payload.candidates.map(({ symbol }) => ({ ...createAgentResponse().assessments[0], symbol }))
  response.topCandidates = payload.candidates.map(({ symbol }) => ({ ...createAgentResponse().topCandidates[0], symbol }))
  assert.throws(() => parseAgentAnalysis(JSON.stringify(response), payload), /unexpected length/)
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

test("group names, nested paths and selection rank are not evidence fields", () => {
  for (const field of ["volume", "volume.volumeZ", "selectionRank"]) {
    const response = createAgentResponse()
    response.assessments[0].drivers = [{ fields: [field], text: "подтверждение сигнала" }]
    assert.throws(
      () => parseAgentAnalysis(JSON.stringify(response), createPayload()),
      /references unknown field/,
    )
  }
})

test("malformed grouped payload is rejected before calling the agent", async () => {
  const payload = createPayload()
  payload.candidates[0].volume = []

  await assert.rejects(analyzeCandidates(payload, createShortlist(), "system prompt", {
    callAgent: async () => assert.fail("Malformed payload must not reach the agent"),
  }), /schema length/)
})

test("candidate analysis uses GPT-6-Astra with high reasoning and one safe tool", async () => {
  const payload = createPayload()
  const shortlist = createShortlist()
  const expected = createAnalysis()
  expected.candidateCount = 2
  expected.assessments[0].tradingViewUrl = "https://www.tradingview.com/chart/?symbol=BINANCE:SOLUSDT.P"
  expected.assessments[1].tradingViewUrl = "https://www.tradingview.com/chart/?symbol=BINANCE:BTCUSDT.P"

  expected.topCandidates[0].estimateConfidence = "medium"
  expected.topCandidates[0].drivers = expected.assessments[0].drivers
  expected.topCandidates[0].counterSignals = expected.assessments[0].counterSignals
  expected.topCandidates[0].tradingViewUrl = expected.assessments[0].tradingViewUrl

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
  for (const candidate of [...result.assessments, ...result.topCandidates]) {
    assert.equal(Object.hasOwn(candidate, "directionBias"), false)
  }
  assert.equal(captured.systemPrompt, "system prompt")
  assert.equal(captured.userMessage, JSON.stringify(payload))
  assert.equal(captured.options.model, "GPT-6-Astra")
  assert.equal(captured.options.reasoningEffort, "high")
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
