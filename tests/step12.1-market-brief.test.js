import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test, { beforeEach } from "node:test"
import { promisify } from "node:util"

import { buildMarketBrief } from "../src/steps/step12.1-market-brief/build-market-brief.js"
import { InvalidMarketBriefError, parseMarketBrief } from "../src/steps/step12.1-market-brief/parse-market-brief.js"
import { readMarketBriefReport } from "../src/steps/step13-report/read-market-brief-report.js"

beforeEach((context) => {
  context.mock.method(globalThis, "fetch", async () => assert.fail("Unexpected network request"))
})

function collection () {
  const sources = ["tavily", "tradingview", "twitter"].map((channel, index) => ({
    id: `source-${index + 1}`, channel,
    url: `https://publisher.example/${index === 2 ? "tweet" : "article"}`,
    title: "Exchange reports a security incident",
    text: index === 1 ? "Updated report: deposits are suspended, investigation continues." : "Exchange says it is investigating an incident.",
    publishedAt: "2026-09-29T12:00:00.000Z", author: index === 2 ? "reporter" : null,
    publisher: index === 2 ? null : "Original publisher",
  }))
  return {
    from: "2026-09-28T12:30:00.000Z", asOf: "2026-09-29T12:30:00.000Z", sources,
    coverage: ["tavily", "tradingview", "twitter"].map(source => ({ source, status: "available", fetchedCount: 1, error: null })),
    warnings: ["Limited keyword sample"],
  }
}

function event (overrides = {}) {
  return {
    title: "Биржа расследует инцидент",
    summary: "По сообщению биржи, проводится расследование инцидента.",
    whyItMatters: "Возможны ограничения доступности инфраструктуры.",
    verification: "reported", sourceIds: ["source-1"], ...overrides,
  }
}

function response (events = [event()]) {
  return { schemaVersion: 1, asOf: collection().asOf, events }
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

test("builds one grounded Gemini digest with its own cutoff, dedup and retained alternative details", async () => {
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
  assert.equal(result.status, "available")
  assert.equal(result.marketAsOf, "2026-09-29T11:00:00.000Z")
  assert.notEqual(result.asOf, result.marketAsOf)
  assert.deepEqual(result.events[0].sourceIds, ["source-1"])
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
    callAgent: async () => JSON.stringify(response([event({
      summary: "По исправленному сообщению, вывод средств не приостанавливался.", sourceIds: ["source-2"],
    })])),
  })
  assert.deepEqual(result.events[0].sourceIds, ["source-2"])
  assert.deepEqual(result.sources, input.sources)
  assert.equal(result.analysis.groupCount, 2)
})

test("handles partial sources without throwing away usable evidence or pretending full coverage", async () => {
  const input = collection()
  input.sources = input.sources.slice(0, 2)
  input.coverage[2] = { source: "twitter", status: "failed", fetchedCount: 0, error: "HTTP 429" }
  const result = await build({ collectSources: async () => input })
  assert.equal(result.status, "partial")
  assert.equal(result.events.length, 1)
  assert.match(result.warning, /Часть источников/)
  assert.equal(result.coverage[2].error, "HTTP 429")
  assert.equal(result.analysis.status, "complete")
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
    assert.deepEqual(result.events, [])
    assert.ok(!failed || result.warning.includes("не означает"))
  })
}

test("Gemini may select zero events without filling a quota; partial coverage remains partial", async () => {
  const result = await build({ callAgent: async () => JSON.stringify(response([])) })
  assert.equal(result.status, "empty")
  assert.equal(result.analysis.status, "complete")
  const input = collection()
  input.coverage[0].status = "partial"
  const partial = await build({ collectSources: async () => input, callAgent: async () => JSON.stringify(response([])) })
  assert.equal(partial.status, "partial")
})

test("accepts fenced JSON and preserves uncertainty rather than upgrading a tweet to fact", () => {
  const output = parseMarketBrief(`\`\`\`json\n${JSON.stringify(response([event({ verification: "unconfirmed", sourceIds: ["source-3"] })]))}\n\`\`\``, collection().asOf, collection().sources)
  assert.equal(output[0].verification, "unconfirmed")
  assert.deepEqual(output[0].sourceIds, ["source-3"])
})

for (const [label, mutate] of [
  ["more than five events", (data) => {
    data.events = Array.from({ length: 6 }, (_, index) => event({ title: `Event ${index}` }))
  }],
  ["unknown source", (data) => {
    data.events[0].sourceIds = ["invented"]
  }],
  ["missing sources", (data) => {
    data.events[0].sourceIds = []
  }],
  ["duplicate source", (data) => {
    data.events[0].sourceIds = ["source-1", "source-1"]
  }],
  ["invented URL field", (data) => {
    data.events[0].url = "https://fake.example"
  }],
  ["wrong snapshot", (data) => {
    data.asOf = "2026-09-29T11:00:00.000Z"
  }],
  ["wrong version", (data) => {
    data.schemaVersion = 2
  }],
  ["confirmed claim", (data) => {
    data.events[0].verification = "confirmed"
  }],
  ["empty title", (data) => {
    data.events[0].title = " "
  }],
  ["long summary", (data) => {
    data.events[0].summary = "x".repeat(601)
  }],
  ["duplicate title", (data) => {
    data.events.push(event())
  }],
  ["not an object", (data) => {
    data.events[0] = null
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
    assert.deepEqual(result.events, [])
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

test("report reader rejects stale, malformed, unsafe and ungrounded saved briefs", async () => {
  const original = await build()
  for (const mutate of [
    (data) => {
      data.marketAsOf = "2026-09-29T10:00:00.000Z"
    },
    (data) => {
      data.schemaVersion = 2
    },
    (data) => {
      data.sources[0].url = "javascript:alert(1)"
    },
    (data) => {
      data.sources[0].publishedAt = "2026-09-30T12:00:00.000Z"
    },
    (data) => {
      data.sources[1].id = data.sources[0].id
    },
    (data) => {
      data.events[0].sourceIds = ["invented"]
    },
    (data) => {
      data.coverage[0].fetchedCount = 100
    },
    (data) => {
      data.coverage[0].status = "failed"
    },
    (data) => {
      data.status = "empty"
    },
    (data) => {
      data.status = "unavailable"
    },
    (data) => {
      data.events = null
    },
    (data) => {
      data.analysis.status = "failed"
    },
    (data) => {
      data.from = "2026-09-28T11:30:00.000Z"
    },
  ]) {
    const input = structuredClone(original)
    mutate(input)
    const result = await readMarketBriefReport(original.marketAsOf, { readJson: async () => input })
    assert.equal(result.status, "unavailable")
    assert.deepEqual(result.events, [])
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
    assert.deepEqual(result.events, [])
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
  assert.match(result.stdout, /Market brief: 1 events/)
})

test("prompt states source trust, freshness, uncertainty, attribution and no trading advice", async () => {
  const prompt = await fs.readFile(new URL("../src/prompts/market-brief.md", import.meta.url), "utf8")
  for (const text of ["недоверенные данные", "4–6 часов", "не означает отсутствия событий", "не меняет рейтинг", "перепечаток", "unconfirmed", "Headline only", "время самого события", "Не создавай собственные URL", "от нуля до пяти", "торговых рекомендаций"]) {
    assert.ok(prompt.includes(text), text)
  }
})
