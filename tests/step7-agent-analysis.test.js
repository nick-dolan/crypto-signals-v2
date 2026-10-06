import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"
import vm from "node:vm"

import modelsInUse from "../models-in-use.json" with { type: "json" }
import { getModelSettings } from "../src/helpers/model-helper.js"
import { analyzeCandidates } from "../src/steps/step7-agent-analysis/analyze-candidates.js"
import { parseAgentAnalysis } from "../src/steps/step7-agent-analysis/parse-agent-analysis.js"

function createPayload () {
  return {
    schemaVersion: 12,
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

function createStructuredAgentResponse () {
  const response = createAgentResponse()

  return {
    ...response,
    schemaVersion: 2,
    topCandidates: response.topCandidates.map(({ symbol, movementProbability }, index) => ({
      symbol,
      movementProbability,
      technicalSummary: {
        observation: "После затишья торговая активность начинает оживать.",
        caveat: index === 0 ? null : "Свежий объёмный триггер слаб.",
      },
    })),
  }
}

function createAllCandidateResponse () {
  const response = createStructuredAgentResponse()

  return {
    ...response,
    schemaVersion: 4,
    topCandidates: response.topCandidates.map(({ symbol, movementProbability }) => ({ symbol, movementProbability })),
    assessments: response.assessments.map((assessment, index) => ({
      ...assessment,
      technicalSummary: response.topCandidates[index].technicalSummary,
    })),
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

test("analysis prompt example follows the structured response schema", async () => {
  const prompt = await readFile(new URL("../src/prompts/strong-move-probability.md", import.meta.url), "utf8")
  const example = JSON.parse(prompt.match(/```json\n([\s\S]*?)\n```/)[1])

  assert.equal(example.schemaVersion, 4)
  assert.deepEqual(Object.keys(example.topCandidates[0]).sort(), ["movementProbability", "symbol"])
  assert.deepEqual(Object.keys(example.assessments[0]).sort(), [
    "counterSignals", "drivers", "estimateConfidence", "movementProbability", "symbol", "technicalSummary",
  ])
  assert.deepEqual(Object.keys(example.assessments[0].technicalSummary).sort(), ["caveat", "observation"])
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

test("growth analysis uses information evidence and preserves the combined explanation", async () => {
  const payload = createPayload()
  payload.schemaVersion = 14
  payload.candidates.forEach(candidate => delete candidate.selectionRank)
  payload.objective = "P(рост > 2.5 ATR в следующие 4–12 часов)"
  payload.schema.informationContext = ["newsSummary", "twitterSummary", "socialSentiment"]
  payload.candidates[0].informationContext = ["Обновление V2: запущено в сети.", "Разработчики подтвердили запуск.", "bullish"]
  payload.candidates[1].informationContext = [null, null, null]
  const response = createAllCandidateResponse()
  response.assessments[0].technicalSummary.observation = "Покупки оживают после выхода обновления V2. Это поддерживает сценарий роста."
  response.assessments[0].drivers = [{
    fields: ["volumeZ", "newsSummary", "socialSentiment"],
    text: "Свежий запуск сопровождается оживлением торговой активности",
  }]
  const result = await analyzeCandidates(payload, createShortlist(), "System prompt", {
    callAgent: async (_, userMessage) => {
      assert.deepEqual(JSON.parse(userMessage), payload)
      return JSON.stringify(response)
    },
  })

  assert.equal(result.objective, payload.objective)
  assert.equal(result.schemaVersion, 4)
  assert.equal(result.topCandidates[0].explanation, response.assessments[0].technicalSummary.observation)
  assert.deepEqual(result.assessments[0].drivers, [
    "volumeZ=1.4 и newsSummary=\"Обновление V2: запущено в сети.\" и socialSentiment=bullish: Свежий запуск сопровождается оживлением торговой активности",
  ])
  assert.throws(() => parseAgentAnalysis(JSON.stringify(createStructuredAgentResponse()), payload), /growth analysis requires schemaVersion 4/)
})

test("one analysis call explains every candidate with the existing paragraph style regardless of top selection", async () => {
  for (const selected of [[], [0], [0, 1]]) {
    const response = createAllCandidateResponse()
    response.topCandidates = selected.map(index => response.topCandidates[index])
    response.assessments[1].technicalSummary = {
      observation: "После относительно спокойного периода усилились покупки и приток новых позиций. Свежий всплеск объёма и внимания сопровождает давление на верхнюю границу диапазона.",
      caveat: "Пробой ещё не подтверждён, а последний час не продолжил рост; обсуждения в основном спекулятивны.",
    }
    let calls = 0
    const result = await analyzeCandidates(createPayload(), createShortlist(), "System prompt", {
      callAgent: async () => {
        calls += 1
        return JSON.stringify(response)
      },
    })

    assert.equal(calls, 1)
    assert.equal(result.assessments.length, 2)
    for (const [index, assessment] of result.assessments.entries()) {
      assert.deepEqual(assessment.technicalSummary, response.assessments[index].technicalSummary)
      assert.equal(assessment.explanation, Object.values(assessment.technicalSummary).filter(Boolean).join(" "))
    }
    for (const top of result.topCandidates) {
      const assessment = result.assessments.find(item => item.symbol === top.symbol)
      assert.deepEqual(top.technicalSummary, assessment.technicalSummary)
      assert.equal(top.explanation, assessment.explanation)
    }
  }
})

test("all 50 candidate assessments retain summaries even with no selected top", () => {
  const payload = createPayload()
  payload.candidates = Array.from({ length: 50 }, (_, index) => ({
    ...payload.candidates[0], symbol: `COIN${index}`, selectionRank: index + 1,
  }))
  payload.candidateCount = payload.candidates.length
  const response = createAllCandidateResponse()
  response.topCandidates = []
  response.assessments = payload.candidates.map(({ symbol }) => ({ ...response.assessments[0], symbol }))
  const analysis = parseAgentAnalysis(JSON.stringify(response), payload)

  assert.equal(analysis.assessments.length, 50)
  assert.deepEqual(analysis.assessments.map(item => item.symbol), payload.candidates.map(item => item.symbol))
  assert.ok(analysis.assessments.every(item => item.explanation === "После затишья торговая активность начинает оживать."))
})

test("schema 4 requires a valid summary for every assessment and rejects duplicated top prose", () => {
  for (const value of [undefined, null, {}, { observation: "", caveat: null }, { observation: "volumeZ слабый.", caveat: null }]) {
    const response = createAllCandidateResponse()
    response.topCandidates = []
    response.assessments[1].technicalSummary = value
    assert.throws(() => parseAgentAnalysis(JSON.stringify(response), createPayload()), /assessment.*(unexpected structure|technicalSummary)/)
  }
  for (const field of ["technicalSummary", "explanation"]) {
    const response = createAllCandidateResponse()
    response.topCandidates[0][field] = "Не дублировать объяснение."
    assert.throws(() => parseAgentAnalysis(JSON.stringify(response), createPayload()), /top candidate.*unexpected structure/)
  }
})

test("agent analysis parser inserts exact payload values into evidence", () => {
  assert.deepEqual(
    parseAgentAnalysis(JSON.stringify(createAgentResponse()), createPayload()),
    createAnalysis(),
  )
})

test("schema 13 evidence preserves signed moves, compact peers and nested market context without removed fields", () => {
  const payload = createPayload()
  payload.schemaVersion = 13
  payload.peerRegistryGeneratedAt = "2026-08-30T09:00:00.000Z"
  payload.marketContext = {
    altMarketBackground: { status: "down", change4hPct: -1.5, breadth4h: 0.199, warning: null },
  }
  payload.schema.lifecycle = ["priorMoveAtr72h"]
  payload.schema.peerContext = ["peerStatus", "peerLeaders"]
  const leaders = [{ symbol: "VET", ageHours: 2, status: "fresh", retainedPct: 80.125 }]
  payload.candidates.forEach((candidate, index) => {
    delete candidate.selectionRank
    candidate.lifecycle = [index === 0 ? -2.5 : null]
    candidate.peerContext = index === 0 ? ["partial", leaders] : ["no_peers", []]
  })
  const response = createAgentResponse()
  response.assessments[0].drivers = [{
    fields: ["priorMoveAtr72h", "peerStatus", "peerLeaders"],
    text: "Предыдущее падение и соседи учитываются отдельно от собственного триггера",
  }]
  response.assessments[0].counterSignals = [{
    fields: ["altMarketBackground"], text: "Рыночный фон ограничивает уверенность",
  }]
  response.assessments[1].drivers = [{ fields: ["priorMoveAtr72h", "peerLeaders"], text: "Пустые связи не заполняют пробелы истории" }]
  const before = structuredClone(payload)
  const result = parseAgentAnalysis(JSON.stringify(response), payload)

  assert.deepEqual(result.assessments[0].drivers, [
    `priorMoveAtr72h=-2.5 и peerStatus=partial и peerLeaders=${JSON.stringify(leaders)}: Предыдущее падение и соседи учитываются отдельно от собственного триггера`,
  ])
  assert.deepEqual(result.assessments[0].counterSignals, [
    `altMarketBackground=${JSON.stringify(payload.marketContext.altMarketBackground)}: Рыночный фон ограничивает уверенность`,
  ])
  assert.deepEqual(result.assessments[1].drivers, ["priorMoveAtr72h=null и peerLeaders=[]: Пустые связи не заполняют пробелы истории"])
  assert.deepEqual(payload, before)

  for (const field of [
    "selectionRank", "priorRunupAtr72h", "priorDrawdownAtr72h", "quietOi", "coinLeadAtr", "coingeckoId",
    "peerRegistryGeneratedAt", "peerFreshLeaderCount", "peerFadingLeaderCount", "breadth4h", "stablesRotation4hPct",
  ]) {
    response.assessments[0].drivers[0].fields = [field]
    assert.throws(() => parseAgentAnalysis(JSON.stringify(response), payload), /references unknown field/)
  }
})

test("structured analysis normalizes only top summaries and derives their legacy explanations in one agent call", async () => {
  const response = createStructuredAgentResponse()
  response.topCandidates = [response.topCandidates[0]]
  response.topCandidates[0].technicalSummary.observation = "  После затишья активность оживает.\n"
  response.topCandidates[0].technicalSummary.caveat = "  Свежий объёмный триггер слаб.  "
  const payload = createPayload()
  const shortlist = createShortlist()
  const before = structuredClone([response, payload, shortlist])
  let callCount = 0
  const result = await analyzeCandidates(payload, shortlist, "System prompt", {
    callAgent: async () => {
      callCount += 1
      return JSON.stringify(response)
    },
  })

  assert.equal(result.schemaVersion, 2)
  assert.equal(result.candidateCount, 2)
  assert.equal(callCount, 1)
  assert.deepEqual(result.topCandidates[0].technicalSummary, {
    observation: "После затишья активность оживает.", caveat: "Свежий объёмный триггер слаб.",
  })
  assert.deepEqual(result.topCandidates.map(({ symbol, movementProbability }) => ({ symbol, movementProbability })), [
    { symbol: response.topCandidates[0].symbol, movementProbability: response.topCandidates[0].movementProbability },
  ])
  assert.equal(result.topCandidates[0].explanation, "После затишья активность оживает. Свежий объёмный триггер слаб.")
  for (const [index, assessment] of result.assessments.entries()) {
    for (const key of ["movementProbability", "estimateConfidence", "drivers", "counterSignals"]) {
      assert.deepEqual(assessment[key], createAnalysis().assessments[index][key])
    }
    assert.equal(Object.hasOwn(assessment, "explanation"), false)
    assert.equal(Object.hasOwn(assessment, "technicalSummary"), false)
  }
  assert.deepEqual([response, payload, shortlist], before)
})

test("structured analysis validates exact summary fields, lengths and readable technical prose", () => {
  for (const technicalSummary of [
    undefined, null, [], "text", {},
    { observation: "Наблюдение." },
    { observation: "Наблюдение.", caveat: null, extra: true },
    { observation: "", caveat: null },
    { observation: " \n ", caveat: null },
    { observation: 42, caveat: null },
    { observation: "я".repeat(301), caveat: null },
    { observation: "Наблюдение.", caveat: "" },
    { observation: "Наблюдение.", caveat: " \n " },
    { observation: "Наблюдение.", caveat: false },
    { observation: "Наблюдение.", caveat: "я".repeat(181) },
    { observation: "Объём вырос в 2 раза.", caveat: null },
    { observation: "Наблюдение.", caveat: "Ограничение 1." },
    { observation: "rvRatio снижается.", caveat: null },
    { observation: "Наблюдение.", caveat: "volumeZ слабый." },
    { observation: "Наблюдение.", caveat: "breadth4h узкий." },
  ]) {
    const response = createStructuredAgentResponse()
    response.topCandidates[0].technicalSummary = technicalSummary
    assert.throws(
      () => parseAgentAnalysis(JSON.stringify(response), createPayload()),
      /Invalid Copilot analysis: .*(technicalSummary|unexpected structure)/,
    )
  }

  for (const caveat of [null, "я".repeat(180)]) {
    const response = createStructuredAgentResponse()
    response.topCandidates[0].technicalSummary = { observation: "я".repeat(300), caveat }
    const parsed = parseAgentAnalysis(JSON.stringify(response), createPayload())
    assert.deepEqual(parsed.topCandidates[0].technicalSummary, response.topCandidates[0].technicalSummary)
    assert.equal(parsed.topCandidates[0].explanation, ["я".repeat(300), caveat].filter(Boolean).join(" "))
  }
})

test("summary schema keeps top selection validation and accepts legacy responses without inventing structure", () => {
  const legacy = parseAgentAnalysis(JSON.stringify(createAgentResponse()), createPayload())
  assert.equal(Object.hasOwn(legacy.topCandidates[0], "technicalSummary"), false)
  assert.equal(Object.hasOwn(legacy.assessments[0], "technicalSummary"), false)

  for (const selected of [[], [0], [1]]) {
    const response = createStructuredAgentResponse()
    response.topCandidates = selected.map(index => response.topCandidates[index])
    const result = parseAgentAnalysis(JSON.stringify(response), createPayload())
    assert.deepEqual(result.topCandidates, response.topCandidates.map(candidate => ({
      ...candidate,
      explanation: [candidate.technicalSummary.observation, candidate.technicalSummary.caveat].filter(Boolean).join(" "),
    })))
    assert.deepEqual(result.assessments, createAnalysis().assessments)
  }

  for (const change of [
    response => response.topCandidates.reverse(),
    response => response.topCandidates.push(response.topCandidates[0]),
    response => response.topCandidates[0].movementProbability = 0.9,
    response => response.topCandidates[0].explanation = "Не дублировать текст.",
    response => response.schemaVersion = 5,
  ]) {
    const response = createStructuredAgentResponse()
    change(response)
    assert.throws(() => parseAgentAnalysis(JSON.stringify(response), createPayload()), /Invalid Copilot analysis/)
  }
})

test("both response versions reject extra assessment prose even for selected coins", () => {
  for (const responseOf of [createAgentResponse, createStructuredAgentResponse]) {
    for (const index of [0, 1]) {
      for (const [field, value] of [
        ["technicalSummary", { observation: "Не дублировать резюме.", caveat: null }],
        ["explanation", "Не добавлять текст оценки."],
      ]) {
        const response = responseOf()
        response.topCandidates = [response.topCandidates[0]]
        response.assessments[index][field] = value
        assert.throws(() => parseAgentAnalysis(JSON.stringify(response), createPayload()), /assessment .*unexpected structure/)
      }
    }
  }
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

test("agent evidence hydrates complete peer leader objects, empty observations and unavailable data", () => {
  for (const [status, freshCount, leaders] of [
    ["unavailable", null, null],
    ["no_peers", 0, []],
    ["insufficient_data", null, null],
    ["partial", 0, []],
    ["partial", 1, [{
      symbol: "VET",
      type: "adjacent",
      basis: "Связь: общая экосистема",
      caveat: "Не независимый сигнал",
      detectedAt: "2026-08-31T08:00:00.000Z",
      windowStartedAt: "2026-08-31T04:00:00.000Z",
      ageHours: 2,
      status: "fresh",
      return4hPct: 3.123,
      move4hAtr: 2.568,
      marketExcess4hAtr: 1.235,
      relativeVolume4h: 1.877,
      retainedPct: 87.654,
      returnSinceStartPct: 3.568,
      coinReturnSinceStartPct: -0.123,
      coinMoveSinceStartAtr: null,
    }]],
  ]) {
    const payload = createPayload()
    payload.schema.peerContext = ["peerStatus", "peerFreshLeaderCount", "peerLeaders"]
    for (const candidate of payload.candidates) {
      candidate.peerContext = [status, freshCount, leaders]
    }
    const before = structuredClone(payload)
    const response = createAgentResponse()
    response.assessments[0].drivers = [{
      fields: ["peerStatus", "peerFreshLeaderCount", "peerLeaders"],
      text: "Контекст соседей не заменяет собственный триггер",
    }]
    const analysis = parseAgentAnalysis(JSON.stringify(response), JSON.parse(JSON.stringify(payload)))

    assert.deepEqual(analysis.assessments[0].drivers, [
      `peerStatus=${status} и peerFreshLeaderCount=${freshCount} и peerLeaders=${JSON.stringify(leaders)}: Контекст соседей не заменяет собственный триггер`,
    ])
    assert.deepEqual(payload, before)
    for (const field of ["peerContext", "peerContext.peerLeaders", "peerLeaders[0].symbol", "coinMoveSinceStartAtr"]) {
      response.assessments[0].drivers[0].fields = [field]
      assert.throws(() => parseAgentAnalysis(JSON.stringify(response), payload), /references unknown field/)
    }
  }
})

test("report renders nested peer evidence without object coercion or splitting JSON string values", async () => {
  const source = await readFile(new URL("../src/web/report.js", import.meta.url), "utf8")
  const featureValue = vm.runInNewContext(`(${source.match(/^ {2}function featureValue [\s\S]*?^ {2}}/m)[0]})`)
  const list = {
    children: [],
    replaceChildren (...children) {
      this.children = children
    },
  }
  const renderSignals = vm.runInNewContext(`(${source.match(/^ {2}function renderSignals [\s\S]*?^ {2}}/m)[0]})`, {
    byId: () => list,
    element: (tag, className = "", text = "") => ({
      tag, className, textContent: text,
      append (...children) {
        this.children = children
      },
    }),
  })

  for (const leaders of [null, [], [{ symbol: "VET", basis: "Связь: \"общая: экосистема\"", caveat: "VET/VTHO: один импульс" }]]) {
    assert.equal(featureValue("peerLeaders", leaders), leaders === null ? "Нет данных / события" : JSON.stringify(leaders))
    const values = `peerStatus=partial и peerLeaders=${JSON.stringify(leaders)}`
    const interpretation = "Контекст: не независимый триггер"
    renderSignals("drivers", [`${values}: ${interpretation}`])

    assert.equal(list.children.length, 1)
    assert.deepEqual(list.children[0].children.map(node => node.textContent), [interpretation, values])
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

test("candidate analysis uses registry settings and one safe tool", async () => {
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
  assert.deepEqual(captured.options, {
    ...getModelSettings("candidateAnalysis"),
    tools: captured.options.tools,
  })
  assert.equal(captured.options.tools.length, 1)
  assert.equal(captured.options.tools[0].name, "get_coin_history")
})

test("candidate analysis follows registry edits while retaining its SDK history tool", async (t) => {
  const original = modelsInUse.candidateAnalysis
  t.after(() => {
    modelsInUse.candidateAnalysis = original
  })
  modelsInUse.candidateAnalysis = {
    ...original,
    provider: "copilot-sdk",
    model: "configured-analysis-model",
    reasoningEffort: "low",
  }
  const settings = getModelSettings("candidateAnalysis")
  const callAgent = t.mock.fn(async () => JSON.stringify(createAgentResponse()))
  const result = await analyzeCandidates(createPayload(), createShortlist(), "System prompt", { callAgent })

  assert.equal(callAgent.mock.callCount(), 1)
  const options = callAgent.mock.calls[0].arguments[2]
  assert.deepEqual(options, { ...settings, tools: options.tools })
  assert.deepEqual(options.tools.map(tool => tool.name), ["get_coin_history"])
  assert.equal(result.candidateCount, createPayload().candidateCount)
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
