import assert from "node:assert/strict"
import test from "node:test"

import { buildMarketBrief } from "../src/steps/step12.1-market-brief/build-market-brief.js"
import { InvalidMarketBriefError, parseMarketBrief } from "../src/steps/step12.1-market-brief/parse-market-brief.js"

const collection = {
  from: "2026-10-20T06:00:00.000Z",
  asOf: "2026-10-20T12:00:00.000Z",
  sources: [{
    id: "source-1", channel: "tradingview", title: "Exchange reports an outage",
    text: "The exchange is investigating a technical outage.",
    url: "https://example.com/news/outage", publishedAt: "2026-10-20T11:00:00.000Z",
    author: null, publisher: null,
  }],
  coverage: [
    { source: "tradingview", status: "available", fetchedCount: 1, error: null },
    { source: "twitter", status: "empty", fetchedCount: 0, error: null },
  ],
  warnings: [],
}
const item = {
  title: "Exchange outage",
  text: "The exchange is investigating a technical outage.",
  sentiment: "bearish",
  sourceIds: ["source-1"],
}

function response (items) {
  return JSON.stringify({ schemaVersion: 5, asOf: collection.asOf, items })
}

test("brief title word count is advisory but content and source checks remain strict", () => {
  for (const title of ["Outage", "The exchange is investigating a new technical outage"]) {
    assert.equal(parseMarketBrief(response([{ ...item, title }]), collection.asOf, collection.sources)[0].title, title)
  }

  for (const change of [
    { title: "" }, { title: "x".repeat(61) }, { title: "Exchange\noutage" },
    { title: "**Exchange outage**" }, { text: "x".repeat(251) }, { text: "<b>Outage</b>" },
    { sourceIds: ["unknown"] }, { sourceIds: ["source-1", "source-1"] },
    { sentiment: "positive" }, { extra: true },
  ]) {
    assert.throws(
      () => parseMarketBrief(response([item, { ...item, ...change }]), collection.asOf, collection.sources),
      error => error instanceof InvalidMarketBriefError && /item 2:/.test(error.message),
    )
  }
})

test("brief repairs one invalid response using the same sources and saves its diagnostic", async (t) => {
  t.mock.method(console, "warn", () => {})
  const invalid = response([{ ...item, sourceIds: ["unknown"] }])
  const collectSources = t.mock.fn(async () => collection)
  const callAgent = t.mock.fn(async () => callAgent.mock.callCount() === 0 ? invalid : response([item]))
  const writeJson = t.mock.fn(async () => {})
  const reportError = t.mock.fn(async () => {})

  const output = await buildMarketBrief("Summarize the sources", { collectSources, callAgent, writeJson, reportError })

  assert.equal(collectSources.mock.callCount(), 1)
  assert.equal(callAgent.mock.callCount(), 2)
  assert.equal(output.analysis.callCount, 2)
  assert.equal(output.analysis.status, "complete")
  assert.equal(output.status, "available")
  assert.deepEqual(output.items, [item])
  assert.equal(reportError.mock.callCount(), 0)
  const initial = JSON.parse(callAgent.mock.calls[0].arguments[1])
  const { correction, ...original } = JSON.parse(callAgent.mock.calls[1].arguments[1])
  assert.deepEqual(original, initial)
  assert.equal(correction.previousResponse, invalid)
  assert.match(correction.error, /item 1:.*collected sources/)
  const [filename, diagnostic] = writeJson.mock.calls[0].arguments
  assert.equal(filename, "step12.1-market-brief.invalid.json")
  assert.equal(diagnostic.asOf, collection.asOf)
  assert.equal(diagnostic.attempts.length, 1)
  assert.equal(diagnostic.attempts[0].response, invalid)
})

test("brief stops after one unsuccessful repair and retains both invalid responses", async (t) => {
  t.mock.method(console, "warn", () => {})
  const responses = ["not JSON", response([{ ...item, text: "x".repeat(251) }])]
  const callAgent = t.mock.fn(async () => responses[callAgent.mock.callCount()])
  const diagnostics = []
  const reportError = t.mock.fn(async () => {})

  const output = await buildMarketBrief("Summarize the sources", {
    collectSources: async () => collection,
    callAgent,
    writeJson: async (filename, data) => diagnostics.push(structuredClone(data)),
    reportError,
  })

  assert.equal(callAgent.mock.callCount(), 2)
  assert.equal(output.analysis.callCount, 2)
  assert.equal(output.status, "unavailable")
  assert.equal(output.analysis.status, "failed")
  assert.deepEqual(output.items, [])
  assert.equal(output.sources, collection.sources)
  assert.equal(diagnostics.length, 2)
  assert.deepEqual(diagnostics[1].attempts.map(attempt => attempt.response), responses)
  assert.deepEqual(diagnostics[1].attempts.map(attempt => attempt.attempt), [1, 2])
  assert.equal(reportError.mock.callCount(), 1)
  assert.equal(reportError.mock.calls[0].arguments[0].message, output.analysis.error)
  assert.match(output.analysis.error, /item 1:.*250 characters/)
})

test("diagnostic write failure is reported without preventing brief repair", async (t) => {
  t.mock.method(console, "warn", () => {})
  const writeError = Object.assign(new Error("Disk is full"), { code: "ENOSPC" })
  const callAgent = t.mock.fn(async () => callAgent.mock.callCount() === 0 ? "not JSON" : response([item]))
  const reportError = t.mock.fn(async () => {})

  const output = await buildMarketBrief("Summarize the sources", {
    collectSources: async () => collection,
    callAgent,
    writeJson: async () => {
      throw writeError
    },
    reportError,
  })

  assert.equal(output.status, "available")
  assert.equal(reportError.mock.callCount(), 1)
  assert.equal(reportError.mock.calls[0].arguments[0], writeError)
  assert.equal(reportError.mock.calls[0].arguments[1].operation, "write_invalid_response")
})

test("transport failure during repair keeps sources and the first diagnostic", async (t) => {
  t.mock.method(console, "warn", () => {})
  const error = new Error("Model request timed out")
  const callAgent = t.mock.fn(async () => {
    if (callAgent.mock.callCount() === 0) {
      return "not JSON"
    }
    throw error
  })
  const writeJson = t.mock.fn(async () => {})
  const reportError = t.mock.fn(async () => {})

  const output = await buildMarketBrief("Summarize the sources", {
    collectSources: async () => collection, callAgent, writeJson, reportError,
  })

  assert.equal(callAgent.mock.callCount(), 2)
  assert.equal(output.status, "unavailable")
  assert.equal(output.analysis.error, error.message)
  assert.equal(output.sources, collection.sources)
  assert.equal(writeJson.mock.callCount(), 1)
  assert.equal(reportError.mock.callCount(), 1)
  assert.equal(reportError.mock.calls[0].arguments[0], error)
})
