import assert from "node:assert/strict"
import test from "node:test"

import { resolveCopilotModel } from "../src/api/copilot/chat.js"

function createModel (overrides = {}) {
  return {
    id: "gpt-5.6-sol",
    name: "GPT-5.6 Sol",
    capabilities: {
      supports: {
        vision: true,
        reasoningEffort: true,
      },
      limits: {
        max_context_window_tokens: 272_000,
      },
    },
    policy: {
      state: "enabled",
      terms: "",
    },
    supportedReasoningEfforts: ["low", "medium", "high"],
    ...overrides,
  }
}

test("Copilot model resolver uses the runtime model ID and supported reasoning", () => {
  const model = createModel()

  assert.equal(
    resolveCopilotModel([model], "GPT-5.6 Sol", "medium"),
    model,
  )
  assert.equal(
    resolveCopilotModel([model], "gpt-5.6-sol", "medium"),
    model,
  )
})

test("Copilot model resolver rejects unavailable model settings", () => {
  assert.throws(
    () => resolveCopilotModel([], "GPT-5.6 Sol", "medium"),
    /unavailable/,
  )
  assert.throws(
    () => resolveCopilotModel([
      createModel({ policy: { state: "disabled", terms: "" } }),
    ], "GPT-5.6 Sol", "medium"),
    /disabled/,
  )
  assert.throws(
    () => resolveCopilotModel([
      createModel({ supportedReasoningEfforts: ["low"] }),
    ], "GPT-5.6 Sol", "medium"),
    /does not support reasoning effort medium/,
  )
})
