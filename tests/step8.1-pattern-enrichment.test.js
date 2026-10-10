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
import { buildPatternChartData } from "../src/steps/step8.1-pattern-enrichment/render-pattern-chart.js"
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
    candidates: input.candidates.map(({ coin }) => {
      const directory = `${coin.symbol}--${coin.baseCurrencyId}`
      const files = {
        data: path.join("tmp", "pattern-enrichment-test", directory, "data.json"),
        svg: path.join("tmp", "pattern-enrichment-test", directory, "chart.svg"),
        png: path.join("tmp", "pattern-enrichment-test", directory, "chart.png"),
        recentSvg: path.join("tmp", "pattern-enrichment-test", directory, "chart-48h.svg"),
        recentPng: path.join("tmp", "pattern-enrichment-test", directory, "chart-48h.png"),
      }
      return {
        ...coin,
        directory,
        ready: true,
        coverage: { candles: 168, volume: 168 },
        caveat: null,
        files,
        views: [168, 48].map(hours => ({
          name: hours === 168 ? "week-168h.png" : "recent-48h.png",
          file: hours === 168 ? files.png : files.recentPng,
          hours,
          from: new Date(Date.parse(input.asOf) - (hours - 1) * 3_600_000).toISOString(),
          to: "2026-10-09T14:00:00.000Z",
          coverage: { candles: hours, volume: hours },
        })),
        features: { shouldNotBeSent: true },
        movementProbability: 0.99,
      }
    }),
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

test("week and recent views share the same closed OHLCV history and latest close", () => {
  const input = createShortlist(["SOL"])
  const { coin } = input.candidates[0]
  const history = buildCoinHistory(createHistory(coin, input.asOf), coin, Date.parse(input.asOf) / 1_000, { includeOpenInterest: false })
  const week = buildPatternChartData(input, { ...coin, history })
  const recent = buildPatternChartData(input, { ...coin, history }, { hours: 48 })
  const data = buildPatternData(coin, history, input.asOf)
  assert.equal(week.points.length, 168)
  assert.equal(recent.points.length, 48)
  assert.deepEqual(recent.points, week.points.slice(-48))
  assert.deepEqual(week.coverage, { candles: 168, volume: 168 })
  assert.deepEqual(recent.coverage, { candles: 48, volume: 48 })
  assert.equal(week.points.at(-1).time, Date.parse(input.asOf) / 1_000)
  assert.equal(recent.points.at(-1).time, week.points.at(-1).time)
  assert.equal(week.price, data.candles.at(-1).close)
  assert.equal(recent.price, week.price)
  assert.equal(week.closedAt, Date.parse(data.to) / 1_000)
  assert.equal(recent.closedAt, week.closedAt)
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

test("writes per-candidate data, week/recent SVG and PNG plus a manifest from the same snapshot and resets only its folder", async (t) => {
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
  const charts = []
  for (const candidate of result.candidates) {
    const data = JSON.parse(await fs.readFile(candidate.files.data, "utf8"))
    assert.equal(data.asOf, input.asOf)
    assert.equal(data.candles.length, 168)
    assert.equal(data.coin.symbol, candidate.symbol)
    assert.deepEqual(data.coverage, candidate.coverage)
    assert.deepEqual(candidate.files, {
      data: path.join("tmp", directory, candidate.directory, "data.json"),
      svg: path.join("tmp", directory, candidate.directory, "chart.svg"),
      png: path.join("tmp", directory, candidate.directory, "chart.png"),
      recentSvg: path.join("tmp", directory, candidate.directory, "chart-48h.svg"),
      recentPng: path.join("tmp", directory, candidate.directory, "chart-48h.png"),
    })
    assert.equal(new Set(Object.values(candidate.files)).size, 5)
    assert.deepEqual(candidate.views, [168, 48].map(hours => ({
      name: hours === 168 ? "week-168h.png" : "recent-48h.png",
      file: hours === 168 ? candidate.files.png : candidate.files.recentPng,
      hours,
      from: new Date(Date.parse(input.asOf) - (hours - 1) * 3_600_000).toISOString(),
      to: result.to,
      coverage: { candles: candidate.ready ? hours : 0, volume: candidate.ready ? hours : 0 },
    })))
    const svgs = []
    for (const [index, view] of candidate.views.entries()) {
      const svg = await fs.readFile(index === 0 ? candidate.files.svg : candidate.files.recentSvg, "utf8")
      const png = await fs.readFile(view.file)
      assert.equal([...svg.matchAll(/class="candle"/g)].length, candidate.ready ? view.hours : 0)
      assert.deepEqual([...svg.matchAll(/class="candle" data-time="(\d+)"/g)].map(([, time]) => Number(time)),
        data.candles.slice(-view.hours).filter(point => point.close !== null).map(point => point.time))
      assert.doesNotMatch(svg, /OPEN INTEREST|Оценка агента|Вероятность|ТОП /)
      assert.match(svg, /width="1400" height="800" viewBox="0 0 1400 800"/)
      const metadata = JSON.parse(svg.match(/<desc>(.*?)<\/desc>/s)[1].replaceAll("&quot;", "\""))
      assert.equal(metadata.asOf, input.asOf)
      assert.equal(metadata.hours, view.hours)
      assert.equal(metadata.from, view.from)
      assert.equal(metadata.closedAt, view.to)
      assert.deepEqual(metadata.coverage, view.coverage)
      assert.equal(png.toString("hex", 0, 8), "89504e470d0a1a0a")
      assert.equal(png.readUInt32BE(16), 1400)
      assert.equal(png.readUInt32BE(20), 800)
      svgs.push(svg)
    }
    charts.push(svgs)
  }
  assert.notEqual(charts[0][0], charts[0][1])
  const widths = charts[0].map(svg => Number(svg.match(/class="body"[^>]* width="([^"]+)"/)[1]))
  assert.ok(widths[1] > widths[0])
  assert.deepEqual(JSON.parse(await fs.readFile(path.join("tmp", directory, "manifest.json"), "utf8")), result)
  const marker = path.join("tmp", directory, "obsolete.txt")
  await fs.writeFile(marker, "old")
  await preparePatternCandidates(createShortlist([]), { directory })
  await assert.rejects(fs.access(marker))
  assert.deepEqual(await fs.readdir(path.join("tmp", directory)), ["manifest.json"])
})

test("one mini-agent per usable candidate receives only metadata and two absolute PNG attachments", async () => {
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
    views: [
      { name: "week-168h.png", hours: 168, from: "2026-10-02T14:00:00.000Z", to: input.to, coverage: { candles: 168, volume: 168 } },
      { name: "recent-48h.png", hours: 48, from: "2026-10-07T14:00:00.000Z", to: input.to, coverage: { candles: 48, volume: 48 } },
    ],
  })
  for (const call of calls) {
    const candidate = input.candidates.find(candidate => candidate.symbol === call.metadata.symbol)
    assert.equal(call.systemPrompt, "System prompt")
    assert.deepEqual(call.metadata.views, candidate.views.map(({ name, hours, from, to, coverage }) => ({ name, hours, from, to, coverage })))
    assert.ok(call.metadata.views.every(view => view.to === input.to))
    assert.doesNotMatch(JSON.stringify(call.metadata), /"(?:files|file|path)"|tmp|features|movementProbability/)
    assert.deepEqual(call.options, {
      ...getModelSettings("candidatePattern"),
      attachments: candidate.views.map(view => ({ type: "file", path: path.resolve(view.file), displayName: view.name })),
    })
    assert.ok(call.options.attachments.every(attachment => path.isAbsolute(attachment.path)))
    assert.equal(new Set(call.options.attachments.map(attachment => attachment.path)).size, 2)
  }
  assert.equal(result.patternEnrichment.candidateCallCount, 2)
  assert.deepEqual(result.candidates[1], { symbol: "BTC", status: "unavailable", summary: null, caveat: "История недоступна." })
  assert.equal(result.candidates[2].caveat, "Есть пропуски.")
  assert.deepEqual(result.candidates.map(candidate => candidate.symbol), ["SOL", "BTC", "ETH"])
  assert.equal(writes.length, 3)
  assert.ok(writes.every(write => write.filename.endsWith("analysis.json")))
  assert.deepEqual(writes.map(write => write.value), result.candidates)
  assert.deepEqual(input, before)
  assert.doesNotMatch(JSON.stringify(result), /"(?:files|file|views|attachments|path|coverage|candles)"|\.png|\.svg|movementProbability/)
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
    JSON.stringify(createResponse("SOL", { summary: null, caveat: "Оба PNG недоступны." })),
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
  assert.deepEqual(parsePatternEnrichment(JSON.stringify(createResponse("SOL", { summary: null, caveat: "Оба PNG недоступны." })), "SOL"), {
    summary: null, caveat: "Оба PNG недоступны.",
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
  assert.match(prompt, /Два вложенных PNG показывают одну OHLCV-историю/)
  assert.match(prompt, /`week-168h\.png` — 168 закрытых часовых свечей/)
  assert.match(prompt, /`recent-48h\.png` — последние 48 свечей крупнее/)
  assert.match(prompt, /Рассматривай актуальную структуру на `recent-48h\.png`, сверяя её с недельным контекстом/)
  assert.match(prompt, /два масштаба одних данных, не независимые подтверждения/)
  assert.match(prompt, /выраженного паттерна нет/)
  assert.match(prompt, /Пропущенные часы остаются пустыми/)
  assert.match(prompt, /Отличай формирующуюся фигуру от уже состоявшегося выхода/)
  assert.match(prompt, /не оценивай вероятность/)
  assert.match(prompt, /не давай торговых рекомендаций/)
  assert.match(prompt, /не прогноз/)
  assert.match(prompt, /словами, а не процентом/)
  assert.match(prompt, /Выделяй также формирующиеся фигуры: завершение и пробой не обязательны/)
  assert.match(prompt, /Начинай `summary` с актуальной структуры/)
  assert.match(prompt, /роль объёма в `summary`/)
  assert.match(prompt, /она относится к конкретной фигуре, а не к очевидному тренду или отскоку/)
  assert.match(prompt, /Если конкретную фигуру не выделяешь, не назначай уверенность/)
  assert.match(prompt, /В `caveat` укажи только конкретное ограничение интерпретации/)
  assert.match(prompt, /Не добавляй стандартные оговорки о неизвестном будущем или отсутствии данных после последней свечи/)
  assert.match(prompt, /если дополнительного ограничения нет, верни `null`/)
  assert.match(prompt, /оба PNG недоступны/)
  const pipeline = await fs.readFile(new URL("../src/index.js", import.meta.url), "utf8")
  assert.ok(pipeline.indexOf("\"step8-context-enrichment.js\"") < pipeline.indexOf("\"step8.1-pattern-enrichment.js\""))
  assert.ok(pipeline.indexOf("\"step8.1-pattern-enrichment.js\"") < pipeline.indexOf("\"step9-agent-payload.js\""))
})
