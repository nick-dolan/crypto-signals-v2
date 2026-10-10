import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import test from "node:test"

import modelsInUse from "../models-in-use.json" with { type: "json" }
import { buildCoinHistory } from "../src/helpers/coin-history-helper.js"
import { getModelSettings } from "../src/helpers/model-helper.js"
import { isError, isString } from "../src/helpers/utils.typed.js"
import { buildPatternData, validatePatternShortlist } from "../src/steps/step8.1-pattern-enrichment/build-pattern-data.js"
import { enrichCandidatesWithPatterns } from "../src/steps/step8.1-pattern-enrichment/enrich-candidates-with-patterns.js"
import { InvalidPatternEnrichmentError, parsePatternEnrichment } from "../src/steps/step8.1-pattern-enrichment/parse-pattern-enrichment.js"
import { preparePatternCandidates } from "../src/steps/step8.1-pattern-enrichment/prepare-pattern-candidates.js"
import { readPatternContext } from "../src/steps/step9-agent-payload/read-pattern-context.js"

function createShortlist (symbols = ["SOL", "BTC"]) {
  return {
    asOf: "2026-10-09T13:00:00.000Z",
    timeframe: "1h",
    candidateCount: symbols.length,
    candidates: symbols.map(symbol => ({
      coin: { symbol, name: `Coin ${symbol}`, baseCurrencyId: `XTVC${symbol}`, marketSymbol: `BINANCE:${symbol}USDT.P` },
      features: { derivatives: { oi_change_4h: 0.1 } },
      movementProbability: 0.99,
    })),
  }
}

function createHistory (coin, asOf) {
  const lastTime = Date.parse(asOf) / 1_000
  return {
    coin,
    timeframe: "1h",
    chart: {
      info: { fullName: coin.marketSymbol },
      periods: Array.from({ length: 200 }, (_, index) => ({
        time: lastTime - (198 - index) * 3_600,
        open: 100 + index, max: 102 + index, min: 99 + index, close: 101 + index, volume: 1_000 + index,
      })).reverse(),
    },
  }
}

function createPrepared (symbols = ["SOL", "BTC"]) {
  const input = createShortlist(symbols)
  return {
    ...input,
    from: "2026-10-02T14:00:00.000Z",
    to: "2026-10-09T14:00:00.000Z",
    directory: "pattern-enrichment-test",
    candidates: input.candidates.map(({ coin }) => ({
      ...coin,
      directory: `${coin.symbol}--${coin.baseCurrencyId}`,
      ready: true,
      coverage: { candles: 168, volume: 168 },
      caveat: null,
      files: { png: `tmp/pattern-enrichment-test/${coin.symbol}/chart.png` },
      features: { shouldNotBeSent: true },
      movementProbability: 0.99,
    })),
  }
}

function createResponse (symbol, overrides = {}) {
  return { symbol, summary: "Возможный бычий флаг; выход из канала не подтверждён. Уверенность средняя.", caveat: null, ...overrides }
}

test("prepares exactly 168 closed OHLCV points without other features or Open Interest", () => {
  const input = createShortlist(["SOL"])
  const { coin } = input.candidates[0]
  const source = createHistory(coin, input.asOf)
  const before = structuredClone(source)
  Object.defineProperty(source, "studies", { get: () => assert.fail("Must not read OI") })
  const history = buildCoinHistory(source, coin, Date.parse(input.asOf) / 1_000, { includeOpenInterest: false })
  const data = buildPatternData(coin, history, input.asOf)
  assert.equal(data.candles.length, 168)
  assert.deepEqual(data.coverage, { candles: 168, volume: 168 })
  assert.equal(data.from, "2026-10-02T14:00:00.000Z")
  assert.equal(data.to, "2026-10-09T14:00:00.000Z")
  assert.equal(data.candles.at(-1).time, Date.parse(input.asOf) / 1_000)
  assert.ok(data.candles.every((point, index) => point.time === Date.parse(data.from) / 1_000 + index * 3_600))
  assert.deepEqual(Object.keys(data.candles[0]), ["time", "open", "high", "low", "close", "volume"])
  assert.deepEqual(data.warnings, [])
  assert.deepEqual({ ...source }, before)
  assert.doesNotMatch(JSON.stringify(data), /openInterest|derivatives|movementProbability/)
})

test("serializes missing hours and invalid volume as null, not fabricated candles or zero volume", () => {
  const input = createShortlist(["SOL"])
  const { coin } = input.candidates[0]
  const source = createHistory(coin, input.asOf)
  source.chart.periods = source.chart.periods.filter(point => point.time !== Date.parse(input.asOf) / 1_000 - 3_600)
  source.chart.periods.find(point => point.time === Date.parse(input.asOf) / 1_000).volume = -1
  const history = buildCoinHistory(source, coin, Date.parse(input.asOf) / 1_000, { includeOpenInterest: false })
  const data = buildPatternData(coin, history, input.asOf)
  assert.deepEqual(data.coverage, { candles: 167, volume: 166 })
  assert.deepEqual(data.candles.at(-2), {
    time: Date.parse(input.asOf) / 1_000 - 3_600, open: null, high: null, low: null, close: null, volume: null,
  })
  assert.equal(data.candles.at(-1).volume, null)
  assert.match(data.warnings.join(" "), /пропуск/i)
})

test("validates the snapshot and candidate identity before preparing files", () => {
  for (const input of [null, {}, { ...createShortlist(), candidateCount: 1 }, { ...createShortlist(), timeframe: "15m" },
    { ...createShortlist(), asOf: "2026-10-09T13:05:00.000Z" }, createShortlist(["SOL", "sol"]),
    { ...createShortlist(), candidates: [{ coin: { symbol: "SOL" } }], candidateCount: 1 }]) {
    assert.throws(() => validatePatternShortlist(input))
  }
  assert.equal(validatePatternShortlist(createShortlist()), Date.parse("2026-10-09T13:00:00.000Z") / 1_000)
  assert.equal(validatePatternShortlist(createShortlist([])), Date.parse("2026-10-09T13:00:00.000Z") / 1_000)
})

test("writes per-candidate data, SVG and PNG plus a manifest from the same snapshot and resets only its folder", async (t) => {
  const input = createShortlist(["SOL", "BTC"])
  const directory = `pattern-preparation-test-${randomUUID()}`
  t.after(() => fs.rm(path.join("tmp", directory), { recursive: true, force: true }))
  const requests = []
  const readCoinData = async (filename) => {
    requests.push(filename)
    const candidate = input.candidates.find(({ coin }) => filename.includes(`${coin.symbol}--${coin.baseCurrencyId}`))
    if (candidate.coin.symbol === "BTC") {
      throw new Error("Missing bootstrap source")
    }
    return createHistory(candidate.coin, input.asOf)
  }
  const result = await preparePatternCandidates(input, { readCoinData, directory })
  assert.equal(requests.length, 2)
  assert.equal(result.candidateCount, 2)
  assert.deepEqual(result.candidates.map(candidate => candidate.ready), [true, false])
  assert.match(result.candidates[1].caveat, /Missing bootstrap source/)
  for (const candidate of result.candidates) {
    const data = JSON.parse(await fs.readFile(candidate.files.data, "utf8"))
    const svg = await fs.readFile(candidate.files.svg, "utf8")
    const png = await fs.readFile(candidate.files.png)
    assert.equal(data.asOf, input.asOf)
    assert.equal(data.candles.length, 168)
    assert.equal(data.coin.symbol, candidate.symbol)
    assert.deepEqual(data.coverage, candidate.coverage)
    assert.equal([...svg.matchAll(/class="candle"/g)].length, candidate.ready ? 168 : 0)
    assert.doesNotMatch(svg, /OPEN INTEREST|Оценка агента|Вероятность|ТОП /)
    assert.equal(png.toString("hex", 0, 8), "89504e470d0a1a0a")
  }
  assert.deepEqual(JSON.parse(await fs.readFile(path.join("tmp", directory, "manifest.json"), "utf8")), result)
  const marker = path.join("tmp", directory, "obsolete.txt")
  await fs.writeFile(marker, "old")
  await preparePatternCandidates(createShortlist([]), { directory })
  await assert.rejects(fs.access(marker))
  assert.deepEqual(await fs.readdir(path.join("tmp", directory)), ["manifest.json"])
})

test("one mini-agent per usable candidate receives only metadata and an absolute PNG attachment", async () => {
  const input = createPrepared(["SOL", "BTC", "ETH"])
  input.candidates[1].ready = false
  input.candidates[1].caveat = "История недоступна."
  input.candidates[2].caveat = "Есть пропуски."
  const before = structuredClone(input)
  const calls = []
  const writes = []
  let active = 0
  let maximum = 0
  const result = await enrichCandidatesWithPatterns(input, "System prompt", {
    callAgent: async (systemPrompt, message, options) => {
      active += 1
      maximum = Math.max(maximum, active)
      await new Promise(resolve => setImmediate(resolve))
      active -= 1
      const metadata = JSON.parse(message)
      calls.push({ systemPrompt, metadata, options })
      return JSON.stringify(createResponse(metadata.symbol))
    },
    writeJson: async (filename, value) => writes.push({ filename, value }),
  })
  assert.equal(maximum, 1)
  assert.deepEqual(calls.map(call => call.metadata.symbol), ["SOL", "ETH"])
  assert.deepEqual(calls[0].metadata, {
    symbol: "SOL", name: "Coin SOL", marketSymbol: "BINANCE:SOLUSDT.P", asOf: input.asOf,
    timeframe: "1h", from: input.from, to: input.to, coverage: { candles: 168, volume: 168 }, dataCaveat: null,
  })
  assert.deepEqual(calls[0].options, {
    ...getModelSettings("candidatePattern"),
    attachments: [{ type: "file", path: path.resolve(input.candidates[0].files.png), displayName: "chart.png" }],
  })
  assert.equal(result.patternEnrichment.candidateCallCount, 2)
  assert.deepEqual(result.candidates[1], { symbol: "BTC", status: "unavailable", summary: null, caveat: "История недоступна." })
  assert.equal(result.candidates[2].caveat, "Есть пропуски.")
  assert.deepEqual(result.candidates.map(candidate => candidate.symbol), ["SOL", "BTC", "ETH"])
  assert.equal(writes.length, 3)
  assert.ok(writes.every(write => write.filename.endsWith("analysis.json")))
  assert.deepEqual(input, before)
  assert.doesNotMatch(JSON.stringify(result), /files|\.png|candles|movementProbability/)
  assert.equal(readPatternContext(createShortlist(["SOL", "BTC", "ETH"]), result).bySymbol.size, 3)
})

test("no recognizable pattern is a valid assessment, not unavailable or bearish", async () => {
  const result = await enrichCandidatesWithPatterns(createPrepared(["SOL"]), "System prompt", {
    callAgent: async () => JSON.stringify(createResponse("SOL", { summary: "Выраженного паттерна нет; цена движется нерегулярно." })),
    writeJson: async () => {},
  })
  assert.equal(result.candidates[0].status, "available")
  assert.match(result.candidates[0].summary, /паттерна нет/)
  assert.equal(result.candidates[0].caveat, null)
})

test("unreadable images, malformed replies and API failures do not invent a pattern or stop other candidates", async (t) => {
  t.mock.method(console, "warn", () => {})
  const replies = [
    JSON.stringify(createResponse("SOL", { summary: null, caveat: "Изображение недоступно." })),
    "not JSON",
    JSON.stringify(createResponse("WRONG")),
    new Error("Image request failed"),
  ]
  for (const reply of replies) {
    const writes = []
    const result = await enrichCandidatesWithPatterns(createPrepared(), "System prompt", {
      callAgent: async (_, message) => {
        const { symbol } = JSON.parse(message)
        if (symbol === "BTC") {
          return JSON.stringify(createResponse(symbol))
        }
        if (isError(reply)) {
          throw reply
        }
        return reply
      },
      writeJson: async (filename, value) => writes.push({ filename, value }),
    })
    assert.equal(result.candidates[0].status, "unavailable")
    assert.equal(result.candidates[0].summary, null)
    assert.ok(result.candidates[0].caveat)
    assert.equal(result.candidates[1].status, "available")
    assert.equal(result.patternEnrichment.candidateCallCount, 2)
    if (reply === "not JSON" || (isString(reply) && reply.includes("WRONG"))) {
      assert.equal(writes.find(write => write.filename.endsWith("analysis.invalid.json")).value.response, reply)
    }
  }
})

test("uses the dedicated configured model without silently changing provider", async (t) => {
  const original = modelsInUse.candidatePattern
  t.after(() => {
    modelsInUse.candidatePattern = original
  })
  modelsInUse.candidatePattern = { ...original, model: "configured-pattern-model", reasoningEffort: null }
  const callAgent = t.mock.fn(async () => JSON.stringify(createResponse("SOL")))
  const result = await enrichCandidatesWithPatterns(createPrepared(["SOL"]), "System prompt", { callAgent, writeJson: async () => {} })
  assert.equal(callAgent.mock.calls[0].arguments[2].model, "configured-pattern-model")
  assert.equal(result.patternEnrichment.model, "configured-pattern-model")
  assert.equal(result.patternEnrichment.reasoningEffort, null)
  modelsInUse.candidatePattern = { ...original, provider: "openai-unofficial" }
  await assert.rejects(enrichCandidatesWithPatterns(createPrepared(["SOL"]), "System prompt", {
    callAgent: async () => assert.fail("No text-only fallback"), writeJson: async () => {},
  }), /requires copilot-sdk/)
})

test("empty shortlists do not call the model", async () => {
  const result = await enrichCandidatesWithPatterns(createPrepared([]), "System prompt", {
    callAgent: async () => assert.fail("No candidates"), writeJson: async () => assert.fail("No per-coin files"),
  })
  assert.deepEqual(result.candidates, [])
  assert.equal(result.candidateCount, 0)
  assert.equal(result.patternEnrichment.candidateCallCount, 0)
})

test("validates exact compact replies while retaining honest missing-image caveats", () => {
  const response = createResponse("SOL", { summary: " Наблюдение. ", caveat: " Не подтверждено. " })
  assert.deepEqual(parsePatternEnrichment(`\n\x60\x60\x60json\n${JSON.stringify(response)}\n\x60\x60\x60`, "SOL"), {
    summary: "Наблюдение.", caveat: "Не подтверждено.",
  })
  assert.deepEqual(parsePatternEnrichment(JSON.stringify(createResponse("SOL", { summary: null, caveat: "PNG недоступен." })), "SOL"), {
    summary: null, caveat: "PNG недоступен.",
  })
  for (const value of [null, "", "not JSON", "[]", JSON.stringify(createResponse("BTC")),
    JSON.stringify(createResponse("SOL", { summary: null, caveat: null })),
    JSON.stringify(createResponse("SOL", { summary: " ", extra: true })),
    JSON.stringify(createResponse("SOL", { summary: "я".repeat(601) })),
    JSON.stringify(createResponse("SOL", { caveat: "я".repeat(301) }))]) {
    assert.throws(() => parsePatternEnrichment(value, "SOL"), InvalidPatternEnrichmentError)
  }
})

test("pattern prompt requires visible evidence, latest state and permits no pattern without forecasting", async () => {
  const prompt = await fs.readFile(new URL("../src/prompts/candidate-pattern-enrichment.md", import.meta.url), "utf8")
  assert.match(prompt, /правого края/)
  assert.match(prompt, /выраженного паттерна нет/)
  assert.match(prompt, /пропуски|Пропуски/)
  assert.match(prompt, /не оценивай вероятность/)
  assert.match(prompt, /не прогноз/)
  assert.match(prompt, /PNG недоступен/)
  const pipeline = await fs.readFile(new URL("../src/index.js", import.meta.url), "utf8")
  assert.ok(pipeline.indexOf("\"step8-context-enrichment.js\"") < pipeline.indexOf("\"step8.1-pattern-enrichment.js\""))
  assert.ok(pipeline.indexOf("\"step8.1-pattern-enrichment.js\"") < pipeline.indexOf("\"step9-agent-payload.js\""))
})
