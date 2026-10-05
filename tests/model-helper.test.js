import assert from "node:assert/strict"
import test from "node:test"

import modelsInUse from "../models-in-use.json" with { type: "json" }
import { callModel, getModelSettings } from "../src/helpers/model-helper.js"
import { isString } from "../src/helpers/utils.typed.js"

function createSettings (overrides = {}) {
  return {
    provider: "copilot-sdk",
    model: "custom-model",
    reasoningEffort: "custom-reasoning",
    description: "Описание монеты",
    ...overrides,
  }
}

test("model registry contains exactly five tasks with Russian descriptions", () => {
  assert.deepEqual(Object.keys(modelsInUse).sort(), [
    "candidateAnalysis",
    "candidateContext",
    "coinDescription",
    "marketBrief",
    "peerRadarAnalysis",
  ])

  for (const [task, entry] of Object.entries(modelsInUse)) {
    assert.ok(isString(entry.description), task)
    assert.match(entry.description.trim(), /[а-яё]{2,}\s+.*[а-яё]{2,}/i, task)

    const { provider, model, reasoningEffort } = entry
    assert.deepEqual(getModelSettings(task), { provider, model, reasoningEffort })
  }
})

test("model settings return fresh objects without descriptions and reflect registry edits", () => {
  const registry = { coinDescription: createSettings() }
  const first = getModelSettings("coinDescription", registry)
  const second = getModelSettings("coinDescription", registry)

  assert.deepEqual(first, {
    provider: "copilot-sdk",
    model: "custom-model",
    reasoningEffort: "custom-reasoning",
  })
  assert.notEqual(first, second)
  assert.notEqual(first, registry.coinDescription)
  first.model = "local-change"
  assert.equal(second.model, "custom-model")
  assert.equal(registry.coinDescription.model, "custom-model")

  Object.assign(registry.coinDescription, {
    provider: "copilot-unofficial",
    model: "future-model",
    reasoningEffort: "future-reasoning",
  })
  assert.deepEqual(getModelSettings("coinDescription", registry), {
    provider: "copilot-unofficial",
    model: "future-model",
    reasoningEffort: "future-reasoning",
  })
})

test("model settings allow null reasoning for either provider", () => {
  for (const provider of ["copilot-sdk", "copilot-unofficial"]) {
    assert.deepEqual(getModelSettings("candidateContext", {
      candidateContext: createSettings({ provider, reasoningEffort: null }),
    }), { provider, model: "custom-model", reasoningEffort: null })
  }
})

test("missing tasks and non-object entries report the registry and task", () => {
  assert.throws(
    () => getModelSettings("unknownTask"),
    /models-in-use\.json.*unknownTask.*missing/,
  )
  assert.throws(
    () => getModelSettings(),
    /models-in-use\.json.*undefined.*missing/,
  )
  assert.throws(
    () => getModelSettings("coinDescription", {}),
    /models-in-use\.json.*coinDescription.*missing/,
  )

  for (const entry of [undefined, null, [], "text", 42, false]) {
    assert.throws(
      () => getModelSettings("coinDescription", { coinDescription: entry }),
      /models-in-use\.json.*coinDescription.*object/,
    )
  }
})

test("invalid fields report the registry, task and field", () => {
  for (const [field, values] of [
    ["provider", [undefined, null, "", " ", "other-provider", 42, [], {}]],
    ["model", [undefined, null, "", " \n\t ", 42, false, [], {}]],
    ["reasoningEffort", [undefined, "", " \n\t ", 42, false, [], {}]],
  ]) {
    for (const value of values) {
      assert.throws(
        () => getModelSettings("coinDescription", {
          coinDescription: createSettings({ [field]: value }),
        }),
        new RegExp(`models-in-use\\.json.*coinDescription.*${field}`),
      )
    }
  }
})

for (const [provider, client, options] of [
  ["copilot-sdk", "callSdk", {
    model: "future-sdk-model",
    reasoningEffort: "arbitrary-sdk-reasoning",
    tools: [{ name: "read_coin" }],
  }],
  ["copilot-unofficial", "callUnofficial", {
    model: "future-unofficial-model",
    reasoningEffort: "arbitrary-unofficial-reasoning",
  }],
]) {
  test(`${provider} receives exactly the prompts and supported options`, async (context) => {
    const clients = {
      callSdk: context.mock.fn(async () => "sdk response"),
      callUnofficial: context.mock.fn(async () => "unofficial response"),
    }
    const response = await callModel("system prompt", "user message", { provider, ...options }, clients)

    assert.equal(response, client === "callSdk" ? "sdk response" : "unofficial response")
    assert.equal(clients[client].mock.callCount(), 1)
    assert.deepEqual(clients[client].mock.calls[0].arguments, [
      "system prompt", "user message", options,
    ])
    assert.equal(clients[client === "callSdk" ? "callUnofficial" : "callSdk"].mock.callCount(), 0)

    if (provider === "copilot-sdk") {
      assert.equal(clients.callSdk.mock.calls[0].arguments[2].tools, options.tools)
    }
  })
}

test("routing preserves null reasoning and defaults to empty SDK tools", async (context) => {
  const clients = {
    callSdk: context.mock.fn(async () => "sdk response"),
    callUnofficial: context.mock.fn(async () => "unofficial response"),
  }

  for (const provider of ["copilot-sdk", "copilot-unofficial"]) {
    await callModel("system", "user", { provider, model: "custom-model", reasoningEffort: null }, clients)
  }

  assert.deepEqual(clients.callSdk.mock.calls[0].arguments, [
    "system", "user", { model: "custom-model", reasoningEffort: null, tools: [] },
  ])
  assert.deepEqual(clients.callUnofficial.mock.calls[0].arguments, [
    "system", "user", { model: "custom-model", reasoningEffort: null },
  ])
  assert.equal(clients.callSdk.mock.callCount(), 1)
  assert.equal(clients.callUnofficial.mock.callCount(), 1)
})

test("unofficial routing accepts empty tools without forwarding them", async (context) => {
  const callSdk = context.mock.fn(() => assert.fail("Unexpected SDK invocation"))
  const callUnofficial = context.mock.fn(async () => "response")

  assert.equal(await callModel("system", "user", {
    provider: "copilot-unofficial",
    model: "custom-model",
    reasoningEffort: "custom-reasoning",
    tools: [],
  }, { callSdk, callUnofficial }), "response")
  assert.deepEqual(callUnofficial.mock.calls[0].arguments, [
    "system", "user", { model: "custom-model", reasoningEffort: "custom-reasoning" },
  ])
  assert.equal(callUnofficial.mock.callCount(), 1)
  assert.equal(callSdk.mock.callCount(), 0)
})

test("unsupported providers and unofficial tools fail before invoking either client", async (context) => {
  const clients = {
    callSdk: context.mock.fn(() => assert.fail("Unexpected SDK invocation")),
    callUnofficial: context.mock.fn(() => assert.fail("Unexpected unofficial invocation")),
  }

  await assert.rejects(callModel("system", "user", {
    provider: "copilot-unofficial",
    model: "custom-model",
    reasoningEffort: null,
    tools: [{ name: "read_coin" }],
  }, clients), /copilot-unofficial.*tools/)
  await assert.rejects(callModel("system", "user", {
    provider: "other-provider",
    tools: [{ name: "read_coin" }],
  }, clients), /Unknown model provider.*other-provider/)
  await assert.rejects(
    callModel("system", "user", undefined, clients),
    /Unknown model provider.*undefined/,
  )
  assert.equal(clients.callSdk.mock.callCount(), 0)
  assert.equal(clients.callUnofficial.mock.callCount(), 0)
})

for (const provider of ["copilot-sdk", "copilot-unofficial"]) {
  test(`${provider} errors propagate without retry or fallback`, async (context) => {
    const error = new Error("Client failure")
    const failingClient = context.mock.fn(async () => {
      throw error
    })
    const unusedClient = context.mock.fn(() => assert.fail("Unexpected fallback"))
    const clients = provider === "copilot-sdk"
      ? { callSdk: failingClient, callUnofficial: unusedClient }
      : { callSdk: unusedClient, callUnofficial: failingClient }

    await assert.rejects(
      callModel("system", "user", { provider, model: "custom-model", reasoningEffort: null }, clients),
      thrown => thrown === error,
    )
    assert.equal(failingClient.mock.callCount(), 1)
    assert.equal(unusedClient.mock.callCount(), 0)
  })
}
