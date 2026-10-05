import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test, { beforeEach } from "node:test"
import { promisify } from "node:util"

import modelsInUse from "../models-in-use.json" with { type: "json" }
import { getModelSettings } from "../src/helpers/model-helper.js"
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
    title: "Биржа — расследование инцидента",
    text: "По сообщению биржи, проводится расследование инцидента.",
    sentiment: "neutral",
    sourceIds: ["source-1"], ...overrides,
  }
}

function response (items = [paragraph()]) {
  return { schemaVersion: 5, asOf: collection().asOf, items }
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

test("builds one compact grounded digest with a six-hour cutoff, dedup and retained alternative details", async () => {
  const settings = getModelSettings("marketBrief")
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
      assert.deepEqual(options, settings)
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
  assert.equal(result.schemaVersion, 5)
  assert.equal(result.status, "available")
  assert.equal(result.from, original.from)
  assert.equal(result.asOf, original.asOf)
  assert.equal(result.marketAsOf, "2026-09-29T11:00:00.000Z")
  assert.notEqual(result.asOf, result.marketAsOf)
  assert.deepEqual(result.items, [paragraph()])
  assert.equal(Object.hasOwn(result, "events"), false)
  assert.equal(Object.hasOwn(result, "paragraphs"), false)
  assert.deepEqual(result.sources, original.sources)
  assert.deepEqual(original, collection())
  assert.deepEqual(result.analysis, {
    source: `github-${settings.provider}`,
    model: settings.model,
    reasoningEffort: settings.reasoningEffort,
    callCount: 1,
    groupCount: 2,
    status: "complete",
    error: null,
  })
  assert.ok(Date.parse(result.generatedAt))
})

test("market brief follows registry edits and remains readable with a changed model", async (t) => {
  const original = modelsInUse.marketBrief
  t.after(() => {
    modelsInUse.marketBrief = original
  })
  modelsInUse.marketBrief = {
    ...original,
    provider: original.provider === "copilot-sdk" ? "copilot-unofficial" : "copilot-sdk",
    model: "configured-brief-model",
    reasoningEffort: null,
  }
  const settings = getModelSettings("marketBrief")
  const callAgent = t.mock.fn(async () => JSON.stringify(response()))
  const brief = await build({ callAgent })

  assert.equal(callAgent.mock.callCount(), 1)
  assert.deepEqual(callAgent.mock.calls[0].arguments[2], settings)
  assert.equal(brief.status, "available")
  assert.deepEqual(brief.analysis, {
    source: `github-${settings.provider}`,
    model: settings.model,
    reasoningEffort: settings.reasoningEffort,
    callCount: 1,
    groupCount: 2,
    status: "complete",
    error: null,
  })
  assert.strictEqual(await readMarketBriefReport(brief.marketAsOf, { readJson: async () => brief }), brief)
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
    callAgent: async () => assert.fail("Agent must not run without publications"),
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
  test(`empty input skips the agent and distinguishes ${failed ? "unavailable" : "empty"}`, async () => {
    const input = collection()
    input.sources = []
    input.coverage = input.coverage.map(source => ({ ...source, status: failed ? "failed" : "empty", fetchedCount: 0 }))
    const result = await build({
      collectSources: async () => input,
      callAgent: async () => assert.fail("Agent must not run without publications"),
    })
    assert.equal(result.schemaVersion, 5)
    assert.equal(result.status, failed ? "unavailable" : "empty")
    assert.equal(result.analysis.callCount, 0)
    assert.deepEqual(result.items, [])
    assert.ok(!failed || result.warning.includes("не означает"))
  })
}

test("the model may return no items without filling a quota; partial coverage remains partial", async () => {
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

test("accepts short plain titles with two to six words without counting standalone dashes", async () => {
  for (const title of [
    "Взлом биржи", "SEC — правила хранения", "Bitcoin ETF — приток средств", "Layer-2 — сбой сети",
    "SEC — новые правила хранения для кастодианов",
  ]) {
    const item = paragraph({ title, text: "По сообщению @reporter_news, потери < 5%; сведения ещё проверяются." })
    const result = await build({ callAgent: async () => JSON.stringify(response([item])) })
    assert.equal(result.status, "available", title)
    assert.deepEqual(result.items, [item])
    assert.deepEqual(await readMarketBriefReport(result.marketAsOf, { readJson: async () => result }), result)
  }
})

test("rejects missing, non-string, oversized, multiline and wrong-word-count titles without inferring replacements", async () => {
  const original = await build()
  for (const title of [
    undefined, null, "", "  ", 12, true, [], {},
    `${"Я".repeat(30)} ${"Я".repeat(30)}`, "SEC", "SEC —", "— —", "один два три четыре пять шесть семь",
    "SEC\nправила хранения", "SEC\rправила хранения", "SEC\u2028правила хранения", "SEC\u2029правила хранения",
  ]) {
    const item = paragraph({ title })
    const data = JSON.stringify(response([item]))
    assert.throws(() => parseMarketBrief(data, collection().asOf, collection().sources), InvalidMarketBriefError)
    const result = await build({ callAgent: async () => data })
    assert.equal(result.schemaVersion, 5)
    assert.equal(result.status, "unavailable")
    assert.deepEqual(result.items, [])
    assert.deepEqual(result.sources, collection().sources)
    const saved = { ...original, items: [item] }
    const before = structuredClone(saved)
    const report = await readMarketBriefReport(original.marketAsOf, { readJson: async () => saved })
    assert.equal(report.status, "unavailable")
    assert.deepEqual(report.items, [])
    assert.deepEqual(report.sources, [])
    assert.deepEqual(saved, before)
  }
})

test("v5 titles and text reject markup and inline citations rather than silently stripping it", async () => {
  const original = await build()
  for (const value of [
    "**SEC — правила хранения**", "*SEC — правила хранения*", "__SEC — правила хранения__",
    "_SEC — правила хранения_", "~~SEC — правила хранения~~", "`SEC — правила хранения`",
    "[SEC — правила хранения](https://fake.example)", "SEC — правила хранения [1]",
    "<b>SEC — правила хранения</b>", "SEC <br> правила хранения", "<script>alert(1)</script> правила хранения",
    "# SEC — правила хранения", "> SEC — правила хранения", "• SEC — правила хранения",
    "- SEC — правила хранения", "+ SEC — правила хранения", "1. SEC — правила хранения",
  ]) {
    for (const field of ["title", "text"]) {
      const item = paragraph({ [field]: value })
      const data = JSON.stringify(response([item]))
      assert.throws(() => parseMarketBrief(data, collection().asOf, collection().sources), InvalidMarketBriefError)
      const saved = { ...original, items: [item] }
      const result = await readMarketBriefReport(original.marketAsOf, { readJson: async () => saved })
      assert.equal(result.status, "unavailable")
      assert.deepEqual(result.items, [])
      assert.deepEqual(result.sources, [])
      assert.equal(saved.items[0][field], value)
    }
  }
})

test("accepts five 60-character titles, independent 250-character texts and ten citations without a minimum quota", async () => {
  const input = collection()
  input.sources = Array.from({ length: 10 }, (_, index) => ({
    ...input.sources[0], id: `source-${index + 1}`, url: `https://publisher.example/${index + 1}`,
  }))
  input.coverage = [
    { source: "tradingview", status: "available", fetchedCount: 10, error: null },
    { source: "twitter", status: "empty", fetchedCount: 0, error: null },
  ]
  const items = Array.from({ length: 5 }, (_, index) => paragraph({
    title: `${"Я".repeat(58)} ${index}`,
    text: `${index} ${"x".repeat(248)}`,
    sourceIds: [`source-${index * 2 + 1}`, `source-${index * 2 + 2}`],
  }))
  for (const count of [0, 1, 5]) {
    const data = response(items.slice(0, count))
    assert.deepEqual(parseMarketBrief(JSON.stringify(data), input.asOf, input.sources), data.items)
    const result = await build({ collectSources: async () => input, callAgent: async () => JSON.stringify(data) })
    assert.equal(result.status, count ? "available" : "empty")
    assert.deepEqual(result.items, data.items)
    assert.deepEqual(await readMarketBriefReport(result.marketAsOf, { readJson: async () => result }), result)
  }
})

test("allows shared citations and trims titles and text without changing order, attribution or inputs", () => {
  const items = [
    paragraph({ title: "  Биржа — пауза вывода  ", text: "  По сообщению биржи, вывод приостановлен.  ", sourceIds: ["source-1", "source-2"] }),
    paragraph({ text: "По сообщению биржи, расследование продолжается.", sourceIds: ["source-2", "source-3"] }),
  ]
  const before = structuredClone(items)
  const result = parseMarketBrief(JSON.stringify(response(items)), collection().asOf, collection().sources)
  assert.deepEqual(result, items.map(item => ({ ...item, title: item.title.trim(), text: item.text.trim() })))
  assert.deepEqual(items, before)
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
  ["wrong snapshot", (data) => {
    data.asOf = "2026-09-29T11:00:00.000Z"
  }],
  ["legacy generation version", (data) => {
    data.schemaVersion = 4
    delete data.items[0].title
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
  assert.strictEqual(result, brief)
  assert.equal(result.from, collection().from)
  assert.equal(result.asOf, collection().asOf)
})

test("report reader rejects missing, blank and non-string saved models", async () => {
  const original = await build()

  for (const model of [undefined, null, "", " \n\t ", 42, false, [], {}]) {
    const brief = structuredClone(original)
    brief.analysis.model = model
    const result = await readMarketBriefReport(brief.marketAsOf, { readJson: async () => brief })

    assert.equal(result.status, "unavailable")
    assert.deepEqual(result.items, [])
    assert.deepEqual(result.sources, [])
    assert.ok(result.warning)
  }
})

test("report reader preserves valid v1 day-long event briefs and validates their original citations", async () => {
  const brief = await build()
  brief.schemaVersion = 1
  brief.from = "2026-09-28T12:30:00.000Z"
  brief.sources[0].channel = "tavily"
  brief.coverage = ["tavily", "tradingview", "twitter"].map(source => ({ source, status: "available", fetchedCount: 1, error: null }))
  brief.events = [{
    title: "Архивное событие ".repeat(8).trim(), summary: "По сообщению биржи, проводится расследование.",
    whyItMatters: "Возможны ограничения инфраструктуры.", verification: "unconfirmed", sourceIds: ["source-1"],
  }]
  delete brief.items
  const before = structuredClone(brief)
  assert.deepEqual(await readMarketBriefReport(brief.marketAsOf, { readJson: async () => brief }), before)
  assert.deepEqual(brief, before)
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

for (const schemaVersion of [3, 4]) {
  test(`report reader preserves all five v${schemaVersion} items without adding titles or changing original fields and limits`, async () => {
    const brief = await build()
    brief.schemaVersion = schemaVersion
    brief.items = Array.from({ length: 5 }, (_, index) => ({
      text: `${index} ${"x".repeat(248)}`,
      ...(schemaVersion === 4 ? { sentiment: ["bearish", "bullish", "neutral"][index % 3] } : {}),
      sourceIds: ["source-1", "source-2"],
    }))
    const before = structuredClone(brief)
    assert.deepEqual(await readMarketBriefReport(brief.marketAsOf, { readJson: async () => brief }), before)
    assert.deepEqual(brief, before)
    for (const mutate of [
      data => data.items.push({ ...data.items[0], text: "Шестая новость" }),
      data => data.items[0].text += "x",
      data => data.items[0].sourceIds.push("source-3"),
      data => data.items[0].sourceIds = ["invented"],
      data => data.items[0].sentiment = "unknown",
      data => data.items[0].title = "Неожиданный заголовок",
    ]) {
      const invalid = structuredClone(brief)
      mutate(invalid)
      assert.equal((await readMarketBriefReport(brief.marketAsOf, { readJson: async () => invalid })).status, "unavailable")
    }
    if (schemaVersion === 4) {
      delete brief.items[0].sentiment
      assert.equal((await readMarketBriefReport(brief.marketAsOf, { readJson: async () => brief })).status, "unavailable")
    }
  })
}

for (const schemaVersion of [2, 3, 4]) {
  test(`v${schemaVersion} archives retain original prose, source evidence and exact timestamps without guessed titles`, async () => {
    const brief = await build()
    brief.schemaVersion = schemaVersion
    brief.from = "2026-09-29T09:30:00.000+03:00"
    brief.asOf = "2026-09-29T15:30:00.000+03:00"
    const entries = [{
      text: "  **Архивная формулировка**. <b>Сохранённые детали</b>.  ",
      ...(schemaVersion === 4 ? { sentiment: "bearish" } : {}),
      sourceIds: ["source-2", "source-1"],
    }]
    if (schemaVersion === 2) {
      brief.paragraphs = entries
      delete brief.items
    } else {
      brief.items = entries
    }
    const before = structuredClone(brief)
    const result = await readMarketBriefReport(brief.marketAsOf, { readJson: async () => brief })
    assert.deepEqual(result, before)
    assert.deepEqual(brief, before)
    assert.equal(Object.hasOwn((result.paragraphs ?? result.items)[0], "title"), false)
  })
}

test("report reader rejects stale, malformed, unsafe and ungrounded saved briefs", async () => {
  const original = await build()
  for (const mutate of [
    (data) => {
      data.marketAsOf = "2026-09-29T10:00:00.000Z"
    },
    (data) => {
      data.schemaVersion = 6
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
    assert.equal(result.schemaVersion, 5)
    assert.equal(result.status, "unavailable")
    assert.equal(result.asOf, null)
    assert.equal(result.from, null)
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
  await promisify(execFile)(process.execPath, ["--input-type=module", "--eval", `
    import assert from "node:assert/strict"
    import fs from "node:fs/promises"
    import { runMarketBriefStep } from ${JSON.stringify(new URL("../src/step12.1-market-brief.js", import.meta.url).href)}
    const brief = ${JSON.stringify(brief)}
    await runMarketBriefStep({ buildBrief: async (_prompt, options) => {
      assert.equal(brief.schemaVersion, 5)
      assert.equal(options.marketAsOf, brief.marketAsOf)
      return brief
    } })
    assert.deepEqual(JSON.parse(await fs.readFile("tmp/step12.1-market-brief.json", "utf8")), brief)
    await assert.rejects(runMarketBriefStep({ buildBrief: async () => { throw new Error("Unexpected failure") } }), /Unexpected failure/)
    await assert.rejects(fs.access("tmp/step12.1-market-brief.json"), { code: "ENOENT" })
  `], { cwd: directory, timeout: 10_000 })
})

test("market brief prompt response example satisfies the parser contract", async () => {
  const prompt = await fs.readFile(new URL("../src/prompts/market-brief.md", import.meta.url), "utf8")
  const example = JSON.parse(prompt.match(/```json\n([\s\S]*?)\n```/)[1])

  assert.deepEqual(parseMarketBrief(JSON.stringify(example), example.asOf, collection().sources), example.items)
})
