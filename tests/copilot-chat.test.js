import assert from "node:assert/strict"
import test from "node:test"
import { CopilotClient } from "@github/copilot-sdk"

import { callCopilot, callCopilotWithTools } from "../src/api/copilot/chat.js"
import { callModel } from "../src/helpers/model-helper.js"

function mockClient (context) {
  const start = context.mock.method(CopilotClient.prototype, "start", async () => {})
  const stop = context.mock.method(CopilotClient.prototype, "stop", async () => [])
  const listModels = context.mock.method(CopilotClient.prototype, "listModels", () => {
    assert.fail("Model IDs must be passed directly without listModels()")
  })
  const sendAndWait = context.mock.fn(async () => ({ data: { content: "OK" } }))
  const createSession = context.mock.method(CopilotClient.prototype, "createSession", async () => ({ sendAndWait }))

  return { start, stop, listModels, createSession, sendAndWait }
}

for (const [model, reasoningEffort] of [
  ["gemini-3.7-flash", "medium"],
  ["gpt-6-luna", "low"],
  ["gpt-6.1-sol", "high"],
  ["future-model", null],
]) {
  test(`Copilot passes ${model} and reasoning directly to the SDK`, async (context) => {
    const client = mockClient(context)

    assert.equal(await callCopilot("system", "user", { model, reasoningEffort }), "OK")

    assert.equal(client.start.mock.callCount(), 1)
    assert.equal(client.listModels.mock.callCount(), 0)
    assert.equal(client.createSession.mock.callCount(), 1)
    const [sessionSettings] = client.createSession.mock.calls[0].arguments
    assert.equal(sessionSettings.model, model)
    assert.equal(sessionSettings.reasoningEffort, reasoningEffort ?? undefined)
    assert.deepEqual(sessionSettings.availableTools, [])
    assert.equal(sessionSettings.systemMessage.content, "system")
    assert.deepEqual(client.sendAndWait.mock.calls[0].arguments, [{ prompt: "user" }, 10 * 60 * 1000])
    assert.equal(client.stop.mock.callCount(), 1)
  })
}

for (const [name, call] of [
  ["callCopilot", callCopilot],
  ["callCopilotWithTools", callCopilotWithTools],
]) {
  test(`${name} sends PNG file attachments to the SDK unchanged`, async (context) => {
    const client = mockClient(context)
    const attachments = [
      { type: "file", path: "/tmp/coin-chart.png", displayName: "coin-chart.png" },
      { type: "file", path: "/tmp/market-chart.png" },
    ]

    assert.equal(await call("system", "user", {
      model: "custom-model", reasoningEffort: "medium", attachments,
    }), "OK")

    assert.deepEqual(client.sendAndWait.mock.calls[0].arguments, [
      { prompt: "user", attachments }, 10 * 60 * 1000,
    ])
    assert.equal(client.sendAndWait.mock.calls[0].arguments[0].attachments, attachments)
    assert.equal(client.createSession.mock.calls[0].arguments[0].model, "custom-model")
    assert.equal(client.createSession.mock.calls[0].arguments[0].reasoningEffort, "medium")
    assert.equal(client.listModels.mock.callCount(), 0)
    assert.equal(client.stop.mock.callCount(), 1)
  })

  test(`${name} omits empty attachments from text requests`, async (context) => {
    const client = mockClient(context)

    for (const options of [{}, { attachments: [] }]) {
      assert.equal(await call("system", "user", { model: "custom-model", ...options }), "OK")
      assert.deepEqual(client.sendAndWait.mock.calls.at(-1).arguments, [
        { prompt: "user" }, 10 * 60 * 1000,
      ])
    }

    assert.equal(client.stop.mock.callCount(), 2)
  })
}

test("callModel sends PNG attachments through the SDK wrapper without changing tools or security", async (context) => {
  const client = mockClient(context)
  const tools = [{ name: "read_coin" }]
  const attachments = [{ type: "file", path: "/tmp/coin-chart.png", displayName: "coin-chart.png" }]

  assert.equal(await callModel("system", "user", {
    provider: "copilot-sdk",
    model: "custom-model",
    reasoningEffort: "medium",
    tools,
    attachments,
  }), "OK")

  assert.deepEqual(client.sendAndWait.mock.calls[0].arguments, [
    { prompt: "user", attachments }, 10 * 60 * 1000,
  ])
  const [settings] = client.createSession.mock.calls[0].arguments
  assert.equal(settings.model, "custom-model")
  assert.equal(settings.reasoningEffort, "medium")
  assert.equal(settings.tools, tools)
  assert.deepEqual(settings.availableTools, ["custom:read_coin"])
  assert.deepEqual(settings.toolSearch, { enabled: false })
  assert.equal(settings.enableConfigDiscovery, false)
  assert.equal(settings.enableSessionStore, false)
  assert.deepEqual(settings.infiniteSessions, { enabled: false })
  assert.deepEqual(settings.memory, { enabled: false })
  assert.deepEqual(settings.onPermissionRequest(), {
    kind: "reject",
    feedback: "Only explicitly registered read-only tools are allowed.",
  })
  assert.deepEqual(settings.systemMessage, {
    mode: "customize",
    sections: {
      identity: { action: "remove" },
      code_change_rules: { action: "remove" },
    },
    content: "system",
  })
  assert.equal(client.listModels.mock.callCount(), 0)
  assert.equal(client.stop.mock.callCount(), 1)
})

test("Copilot propagates attachment request errors and stops the client", async (context) => {
  const client = mockClient(context)
  const error = new Error("Image attachment is not available")
  client.sendAndWait.mock.mockImplementation(async () => {
    throw error
  })

  await assert.rejects(
    callCopilot("system", "user", {
      model: "custom-model",
      attachments: [{ type: "file", path: "/tmp/coin-chart.png" }],
    }),
    thrown => thrown === error,
  )

  assert.equal(client.sendAndWait.mock.callCount(), 1)
  assert.equal(client.createSession.mock.callCount(), 1)
  assert.equal(client.listModels.mock.callCount(), 0)
  assert.equal(client.stop.mock.callCount(), 1)
})

test("Copilot propagates SDK model errors and stops the client", async (context) => {
  const client = mockClient(context)
  const error = new Error("Model is not available")
  client.createSession.mock.mockImplementation(async () => {
    throw error
  })

  await assert.rejects(
    callCopilot("system", "user", { model: "unsupported-model", reasoningEffort: "medium" }),
    thrown => thrown === error,
  )

  assert.equal(client.listModels.mock.callCount(), 0)
  assert.equal(client.sendAndWait.mock.callCount(), 0)
  assert.equal(client.stop.mock.callCount(), 1)
})
