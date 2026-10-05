import assert from "node:assert/strict"
import test from "node:test"
import { CopilotClient } from "@github/copilot-sdk"

import { callCopilot } from "../src/api/copilot/chat.js"

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
