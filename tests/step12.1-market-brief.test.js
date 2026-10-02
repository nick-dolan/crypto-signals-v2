import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test, { beforeEach } from "node:test"
import { promisify } from "node:util"

import { buildMarketBrief } from "../src/steps/step12.1-market-brief/build-market-brief.js"
import { collectMarketSources } from "../src/steps/step12.1-market-brief/collect-market-sources.js"
import { InvalidMarketBriefError, parseMarketBrief } from "../src/steps/step12.1-market-brief/parse-market-brief.js"
import { readMarketBriefReport } from "../src/steps/step13-report/read-market-brief-report.js"

beforeEach((context) => {
  context.mock.method(globalThis, "fetch", async () => assert.fail("Unexpected network request"))
})

function collection () {
  const sources = ["tradingview", "tradingview", "twitter"].map((channel, index) => ({
    id: `source-${index + 1}`, channel,
    url: `https://publisher.example/${index === 2 ? "tweet" : "article"}`,
    title: "Exchange reports a security incident",
    text: index === 1 ? "Updated report: deposits are suspended, investigation continues." : "Exchange says it is investigating an incident.",
    publishedAt: "2026-09-29T12:00:00.000Z", author: index === 2 ? "reporter" : null,
    publisher: index === 2 ? null : "Original publisher",
  }))
  return {
    from: "2026-09-29T06:30:00.000Z", asOf: "2026-09-29T12:30:00.000Z", sources,
    coverage: ["tradingview", "twitter"].map(source => ({ source, status: "available", fetchedCount: source === "tradingview" ? 2 : 1, error: null })),
    warnings: ["Limited keyword sample"],
  }
}

function paragraph (overrides = {}) {
  return {
    text: "По сообщению биржи, проводится расследование инцидента.",
    sentiment: "neutral",
    sourceIds: ["source-1"], ...overrides,
  }
}

function response (items = [paragraph()]) {
  return { schemaVersion: 4, asOf: collection().asOf, items }
}

function build (overrides = {}) {
  return buildMarketBrief("System prompt", {
    marketAsOf: "2026-09-29T11:00:00.000Z",
    referenceTimestamp: Date.parse(collection().asOf) / 1_000,
    collectSources: async () => collection(),
    callAgent: async () => JSON.stringify(response()),
    ...overrides,
  })
}

test("builds one compact grounded Gemini digest with a six-hour cutoff, dedup and retained alternative details", async () => {
  let calls = 0
  const original = collection()
  const result = await build({
    collectSources: async (options) => {
      assert.deepEqual(options, { referenceTimestamp: Date.parse(original.asOf) / 1_000 })
      return original
    },
    callAgent: async (prompt, message, options) => {
      calls += 1
      assert.equal(prompt, "System prompt")
      assert.deepEqual(options, { model: "gemini-3.7-flash", reasoningEffort: "medium" })
      const payload = JSON.parse(message)
      assert.equal(payload.asOf, original.asOf)
      assert.equal(Date.parse(payload.asOf) - Date.parse(payload.from), 6 * 60 * 60 * 1_000)
      assert.deepEqual(payload.coverage, original.coverage)
      assert.deepEqual(payload.warnings, original.warnings)
      assert.equal(payload.groups.length, 2)
      assert.equal(payload.groups[0].sources.length, 2)
      assert.equal(payload.groups[0].sources[0].publisher, "Original publisher")
      const texts = [payload.groups[0].text, ...payload.groups[0].sources.map(source => source.text)]
      assert.ok(texts.includes(original.sources[0].text))
      assert.ok(texts.includes(original.sources[1].text))
      return JSON.stringify(response())
    },
  })
  assert.equal(calls, 1)
  assert.equal(result.schemaVersion, 4)
  assert.equal(result.status, "available")
  assert.equal(result.marketAsOf, "2026-09-29T11:00:00.000Z")
  assert.notEqual(result.asOf, result.marketAsOf)
  assert.deepEqual(result.items, [paragraph()])
  assert.equal(Object.hasOwn(result, "events"), false)
  assert.equal(Object.hasOwn(result, "paragraphs"), false)
  assert.deepEqual(result.sources, original.sources)
  assert.deepEqual(original, collection())
  assert.equal(result.analysis.callCount, 1)
  assert.equal(result.analysis.groupCount, 2)
  assert.equal(result.analysis.status, "complete")
  assert.ok(Date.parse(result.generatedAt))
})

test("a correction does not acquire contradictory earlier versions as supporting citations", async () => {
  const input = collection()
  input.sources[0].text = "Withdrawals were suspended."
  input.sources[1].text = "Correction: withdrawals were not suspended."
  const result = await build({
    collectSources: async () => input,
    callAgent: async () => JSON.stringify(response([paragraph({
      text: "По исправленному сообщению, вывод средств не приостанавливался.", sourceIds: ["source-2"],
    })])),
  })
  assert.deepEqual(result.items[0].sourceIds, ["source-2"])
  assert.deepEqual(result.sources, input.sources)
  assert.equal(result.analysis.groupCount, 2)
})

test("handles source failures without throwing away usable evidence or exposing technical errors", async () => {
  const input = collection()
  input.sources = input.sources.slice(0, 2)
  input.coverage[1] = { source: "twitter", status: "failed", fetchedCount: 0, error: "HTTP 429" }
  const result = await build({ collectSources: async () => input })
  assert.equal(result.status, "partial")
  assert.equal(result.items.length, 1)
  assert.equal(result.warning, "Не все источники удалось загрузить.")
  assert.equal(result.coverage[1].error, "HTTP 429")
  assert.equal(result.analysis.status, "complete")
})

test("an empty Twitter page with broken pagination is unavailable, not a healthy empty brief", async () => {
  const result = await build({
    collectSources: options => collectMarketSources({
      ...options,
      fetchNews: async () => ({ items: [] }),
      fetchTweets: async () => ({ tweets: [], has_next_page: true, next_cursor: "" }),
    }),
    callAgent: async () => assert.fail("Gemini must not run without publications"),
  })
  assert.equal(result.status, "unavailable")
  assert.equal(result.coverage[1].status, "partial")
  assert.match(result.coverage[1].error, /pagination cursor/)
  assert.match(result.warning, /не означает/)
  assert.deepEqual(await readMarketBriefReport(result.marketAsOf, { readJson: async () => result }), result)
})

test("ordinary collection limits remain metadata, not failure warnings, including empty samples", async () => {
  for (const empty of [false, true]) {
    const input = collection()
    input.coverage.forEach((source) => {
      source.status = "partial"
    })
    if (empty) {
      input.sources = []
      input.coverage.forEach((source) => {
        source.fetchedCount = 0
      })
    }
    const result = await build({ collectSources: async () => input })
    assert.equal(result.status, "partial")
    assert.equal(result.warning, null)
    assert.deepEqual(result.warnings, input.warnings)
    assert.equal(result.analysis.callCount, empty ? 0 : 1)
    assert.deepEqual(await readMarketBriefReport(result.marketAsOf, { readJson: async () => result }), result)
  }
})

for (const failed of [false, true]) {
  test(`empty input skips Gemini and distinguishes ${failed ? "unavailable" : "empty"}`, async () => {
    const input = collection()
    input.sources = []
    input.coverage = input.coverage.map(source => ({ ...source, status: failed ? "failed" : "empty", fetchedCount: 0 }))
    const result = await build({
      collectSources: async () => input,
      callAgent: async () => assert.fail("Gemini must not run without publications"),
    })
    assert.equal(result.status, failed ? "unavailable" : "empty")
    assert.equal(result.analysis.callCount, 0)
    assert.deepEqual(result.items, [])
    assert.ok(!failed || result.warning.includes("не означает"))
  })
}

test("Gemini may return no items without filling a quota; partial coverage remains partial", async () => {
  const result = await build({ callAgent: async () => JSON.stringify(response([])) })
  assert.equal(result.status, "empty")
  assert.equal(result.analysis.status, "complete")
  const input = collection()
  input.coverage[0].status = "partial"
  const partial = await build({ collectSources: async () => input, callAgent: async () => JSON.stringify(response([])) })
  assert.equal(partial.status, "partial")
  assert.equal(partial.warning, null)
})

test("accepts fenced JSON and preserves attribution and uncertainty in prose", () => {
  const item = paragraph({ text: "По сообщению reporter, возможен инцидент; пока не подтверждено.", sourceIds: ["source-3"] })
  const output = parseMarketBrief(`\`\`\`json\n${JSON.stringify(response([item]))}\n\`\`\``, collection().asOf, collection().sources)
  assert.deepEqual(output, [item])
})

test("preserves each model sentiment without changing text, ordering or source evidence", async () => {
  const items = ["bearish", "bullish", "neutral"].map((sentiment, index) => paragraph({
    text: `Новость ${index + 1}`, sentiment, sourceIds: [`source-${index + 1}`],
  }))
  const result = await build({ callAgent: async () => JSON.stringify(response(items)) })
  assert.equal(result.status, "available")
  assert.deepEqual(result.items, items)
  assert.deepEqual(result.sources, collection().sources)
  assert.deepEqual(await readMarketBriefReport(result.marketAsOf, { readJson: async () => result }), result)
})

test("missing and invalid sentiments are rejected instead of silently becoming neutral", async () => {
  const original = await build()
  for (const sentiment of [undefined, null, "", "positive", "BULLISH", "neutral ", "🟢", "__proto__", 1, true, ["neutral"], {}]) {
    const item = paragraph({ sentiment })
    const data = response([item])
    assert.throws(() => parseMarketBrief(JSON.stringify(data), collection().asOf, collection().sources), InvalidMarketBriefError)
    const result = await build({ callAgent: async () => JSON.stringify(data) })
    assert.equal(result.status, "unavailable")
    assert.deepEqual(result.items, [])
    assert.deepEqual(result.sources, collection().sources)
    const saved = { ...original, items: [item] }
    const report = await readMarketBriefReport(original.marketAsOf, { readJson: async () => saved })
    assert.equal(report.status, "unavailable")
    assert.deepEqual(report.items, [])
    assert.deepEqual(saved.items, [item])
  }
})

test("accepts up to five 250-character items and ten distinct citations without a minimum quota", async () => {
  const input = collection()
  input.sources = Array.from({ length: 10 }, (_, index) => ({
    ...input.sources[0], id: `source-${index + 1}`, url: `https://publisher.example/${index + 1}`,
  }))
  input.coverage = [
    { source: "tradingview", status: "available", fetchedCount: 10, error: null },
    { source: "twitter", status: "empty", fetchedCount: 0, error: null },
  ]
  const items = Array.from({ length: 5 }, (_, index) => paragraph({
    text: `${index} ${"x".repeat(248)}`,
    sourceIds: [`source-${index * 2 + 1}`, `source-${index * 2 + 2}`],
  }))
  for (const count of [0, 1, 2, 3, 4, 5]) {
    const data = response(items.slice(0, count))
    assert.deepEqual(parseMarketBrief(JSON.stringify(data), input.asOf, input.sources), data.items)
    const result = await build({ collectSources: async () => input, callAgent: async () => JSON.stringify(data) })
    assert.equal(result.status, count ? "available" : "empty")
    assert.deepEqual(result.items, data.items)
    assert.deepEqual(await readMarketBriefReport(result.marketAsOf, { readJson: async () => result }), result)
  }
})

test("allows shared citations and trims text without changing news order or attribution", () => {
  const items = [
    paragraph({ text: "  По сообщению биржи, вывод приостановлен.  ", sourceIds: ["source-1", "source-2"] }),
    paragraph({ text: "По сообщению биржи, расследование продолжается.", sourceIds: ["source-2", "source-3"] }),
  ]
  const result = parseMarketBrief(JSON.stringify(response(items)), collection().asOf, collection().sources)
  assert.deepEqual(result, items.map(item => ({ ...item, text: item.text.trim() })))
})

for (const [label, mutate] of [
  ["more than five items", (data) => {
    data.items = Array.from({ length: 6 }, (_, index) => paragraph({ text: `News ${index}` }))
  }],
  ["unknown source", (data) => {
    data.items[0].sourceIds = ["invented"]
  }],
  ["missing sources", (data) => {
    data.items[0].sourceIds = []
  }],
  ["duplicate source", (data) => {
    data.items[0].sourceIds = ["source-1", "source-1"]
  }],
  ["more than two sources per item", (data) => {
    data.items[0].sourceIds = ["source-1", "source-2", "source-3"]
  }],
  ["invented URL field", (data) => {
    data.items[0].url = "https://fake.example"
  }],
  ["unexpected heading", (data) => {
    data.items[0].title = "Heading"
  }],
  ["wrong snapshot", (data) => {
    data.asOf = "2026-09-29T11:00:00.000Z"
  }],
  ["wrong version", (data) => {
    data.schemaVersion = 3
  }],
  ["legacy response shape", (data) => {
    data.paragraphs = data.items
    delete data.items
  }],
  ["empty text", (data) => {
    data.items[0].text = " "
  }],
  ["251-character item", (data) => {
    data.items[0].text = "x".repeat(251)
  }],
  ["non-string text", (data) => {
    data.items[0].text = 123
  }],
  ["duplicate text", (data) => {
    data.items.push(paragraph({ text: `  ${data.items[0].text.toUpperCase()}  ` }))
  }],
  ["not an object", (data) => {
    data.items[0] = null
  }],
  ["not an array", (data) => {
    data.items = null
  }],
]) {
  test(`rejects ${label}; retains collected sources and marks digest unavailable`, async () => {
    const data = response()
    mutate(data)
    assert.throws(() => parseMarketBrief(JSON.stringify(data), collection().asOf, collection().sources), InvalidMarketBriefError)
    const result = await build({ callAgent: async () => JSON.stringify(data) })
    assert.equal(result.status, "unavailable")
    assert.equal(result.analysis.status, "failed")
    assert.match(result.analysis.error, /Invalid market brief/)
    assert.deepEqual(result.sources, collection().sources)
    assert.deepEqual(result.items, [])
  })
}

test("network/auth failures and malformed responses do not leak API error bodies or stop the report", async () => {
  for (const callAgent of [
    async () => {
      throw new Error("secret-token: credential and upstream body")
    },
    async () => "Not JSON",
    async () => "",
  ]) {
    const result = await build({ callAgent })
    assert.equal(result.status, "unavailable")
    assert.doesNotMatch(JSON.stringify(result), /secret-token/)
    assert.equal(result.sources.length, 3)
  }
})

test("validates required prompt and market timestamp before collecting", async () => {
  await assert.rejects(buildMarketBrief(""), /system prompt/)
  await assert.rejects(build({ marketAsOf: "invalid" }), /marketAsOf/)
})

test("report reader accepts the matching market snapshot with a distinct news cutoff", async () => {
  const brief = await build()
  const result = await readMarketBriefReport(brief.marketAsOf, { readJson: async (filename) => {
    assert.equal(filename, "step12.1-market-brief.json")
    return brief
  } })
  assert.deepEqual(result, brief)
})

test("report reader preserves valid v1 day-long event briefs and validates their original citations", async () => {
  const brief = await build()
  brief.schemaVersion = 1
  brief.from = "2026-09-28T12:30:00.000Z"
  brief.sources[0].channel = "tavily"
  brief.coverage = ["tavily", "tradingview", "twitter"].map(source => ({ source, status: "available", fetchedCount: 1, error: null }))
  brief.events = [{
    title: "Архивная новость", summary: "По сообщению биржи, проводится расследование.",
    whyItMatters: "Возможны ограничения инфраструктуры.", verification: "unconfirmed", sourceIds: ["source-1"],
  }]
  delete brief.items
  assert.deepEqual(await readMarketBriefReport(brief.marketAsOf, { readJson: async () => brief }), brief)
  brief.events[0].sourceIds = ["invented"]
  const invalid = await readMarketBriefReport(brief.marketAsOf, { readJson: async () => brief })
  assert.equal(invalid.status, "unavailable")
  assert.deepEqual(invalid.sources, [])
})

test("report reader preserves v2 paragraphs and their original 800-character and three-source limits", async () => {
  const brief = await build()
  brief.schemaVersion = 2
  brief.paragraphs = [
    { text: "x".repeat(400), sourceIds: ["source-1", "source-2"] },
    { text: "y".repeat(400), sourceIds: ["source-2", "source-3"] },
  ]
  delete brief.items
  assert.deepEqual(await readMarketBriefReport(brief.marketAsOf, { readJson: async () => brief }), brief)
  for (const mutate of [
    data => data.paragraphs.push({ text: "Третий абзац", sourceIds: ["source-1"] }),
    data => data.paragraphs[0].text += "x",
    (data) => {
      data.sources.push({ ...data.sources[0], id: "source-4" })
      data.coverage[0].fetchedCount += 1
      data.paragraphs[1].sourceIds.push("source-4")
    },
  ]) {
    const invalid = structuredClone(brief)
    mutate(invalid)
    const result = await readMarketBriefReport(brief.marketAsOf, { readJson: async () => invalid })
    assert.equal(result.status, "unavailable")
    assert.deepEqual(result.items, [])
  }
})

test("report reader preserves all five v3 items without inventing sentiment or changing their original limits", async () => {
  const brief = await build()
  brief.schemaVersion = 3
  brief.items = Array.from({ length: 5 }, (_, index) => ({
    text: `${index} ${"x".repeat(248)}`, sourceIds: ["source-1", "source-2"],
  }))
  const before = structuredClone(brief)
  assert.deepEqual(await readMarketBriefReport(brief.marketAsOf, { readJson: async () => brief }), before)
  assert.deepEqual(brief, before)
  for (const mutate of [
    data => data.items.push({ text: "Шестая новость", sourceIds: ["source-1"] }),
    data => data.items[0].text += "x",
    data => data.items[0].sourceIds.push("source-3"),
  ]) {
    const invalid = structuredClone(brief)
    mutate(invalid)
    assert.equal((await readMarketBriefReport(brief.marketAsOf, { readJson: async () => invalid })).status, "unavailable")
  }
})

test("report reader rejects stale, malformed, unsafe and ungrounded saved briefs", async () => {
  const original = await build()
  for (const mutate of [
    (data) => {
      data.marketAsOf = "2026-09-29T10:00:00.000Z"
    },
    (data) => {
      data.schemaVersion = 5
    },
    (data) => {
      data.sources[0].url = "javascript:alert(1)"
    },
    (data) => {
      data.sources[0].publishedAt = "2026-09-30T12:00:00.000Z"
    },
    (data) => {
      data.sources[0].publishedAt = "2026-09-29T06:29:59.000Z"
    },
    (data) => {
      data.sources[0].channel = "tavily"
    },
    (data) => {
      data.sources[1].id = data.sources[0].id
    },
    (data) => {
      data.items[0].sourceIds = ["invented"]
    },
    (data) => {
      data.items[0].text = "x".repeat(251)
    },
    (data) => {
      data.coverage[0].fetchedCount = 100
    },
    (data) => {
      data.coverage[0].status = "failed"
    },
    (data) => {
      data.coverage.push({ source: "tavily", status: "empty", fetchedCount: 0, error: null })
    },
    (data) => {
      data.coverage[1].source = "tradingview"
    },
    (data) => {
      data.status = "empty"
    },
    (data) => {
      data.status = "unavailable"
    },
    (data) => {
      data.items = null
    },
    (data) => {
      data.analysis.status = "failed"
    },
    (data) => {
      data.from = "2026-09-28T12:30:00.000Z"
    },
  ]) {
    const input = structuredClone(original)
    mutate(input)
    const result = await readMarketBriefReport(original.marketAsOf, { readJson: async () => input })
    assert.equal(result.status, "unavailable")
    assert.deepEqual(result.items, [])
    assert.deepEqual(result.sources, [])
    assert.ok(result.warning)
  }
})

test("missing or corrupt optional brief never prevents report assembly", async () => {
  for (const error of [Object.assign(new Error("Missing"), { code: "ENOENT" }), new SyntaxError("Bad JSON")]) {
    const result = await readMarketBriefReport("2026-09-29T11:00:00.000Z", { readJson: async () => {
      throw error
    } })
    assert.equal(result.status, "unavailable")
    assert.equal(result.asOf, null)
    assert.deepEqual(result.items, [])
    assert.match(result.warning, /сводк/i)
  }
})

test("standalone step saves a brief and removes obsolete output before a failed rerun", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "market-brief-step-"))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  await fs.mkdir(path.join(directory, "tmp"))
  await fs.writeFile(path.join(directory, "tmp", "step7-agent-analysis.json"), JSON.stringify({ asOf: "2026-09-29T11:00:00.000Z" }))
  const brief = await build()
  const result = await promisify(execFile)(process.execPath, ["--input-type=module", "--eval", `
    import assert from "node:assert/strict"
    import fs from "node:fs/promises"
    import { runMarketBriefStep } from ${JSON.stringify(new URL("../src/step12.1-market-brief.js", import.meta.url).href)}
    const brief = ${JSON.stringify(brief)}
    await runMarketBriefStep({ buildBrief: async (prompt, options) => {
      assert.match(prompt, /недоверенные данные/)
      assert.equal(options.marketAsOf, brief.marketAsOf)
      return brief
    } })
    assert.deepEqual(JSON.parse(await fs.readFile("tmp/step12.1-market-brief.json", "utf8")), brief)
    await assert.rejects(runMarketBriefStep({ buildBrief: async () => { throw new Error("Unexpected failure") } }), /Unexpected failure/)
    await assert.rejects(fs.access("tmp/step12.1-market-brief.json"), { code: "ENOENT" })
  `], { cwd: directory, timeout: 10_000 })
  assert.match(result.stdout, /Market brief: 1 news items/)
})

test("prompt enforces concise news items, six-hour freshness, grounding, attribution and no trading advice", async () => {
  const prompt = await fs.readFile(new URL("../src/prompts/market-brief.md", import.meta.url), "utf8")
  for (const text of ["недоверенные данные", "последние 6 часов", "не означает отсутствия событий", "не меняет рейтинг", "перепечаток", "не подтверждено", "Headline only", "время самого события", "Не создавай собственные URL", "от нуля до пяти", "3–5", "250 символов с пробелами", "торговые рекомендации", "без заголовка", "Не более двух различных", "по убыванию значимости", "меньше трёх", "Не заполняй объём ради количества", "не добирай вчерашние новости"]) {
    assert.ok(prompt.includes(text), text)
  }
  assert.doesNotMatch(prompt, /Tavily|whyItMatters|Главное за сутки|800 символов|paragraphs/)
  const example = JSON.parse(prompt.match(/```json\n([\s\S]*?)\n```/)[1])
  assert.equal(example.schemaVersion, 4)
  assert.deepEqual(Object.keys(example), ["schemaVersion", "asOf", "items"])
  assert.equal(example.items[0].sentiment, "neutral")
  for (const text of ["bullish", "neutral", "bearish", "При сомнениях выбирай `neutral`", "не настроение всего рынка", "не прогноз цены", "Не вставляй эмодзи", "без учёта эмодзи и ссылок"]) {
    assert.ok(prompt.includes(text), text)
  }
})
