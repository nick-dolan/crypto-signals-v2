import assert from "node:assert/strict"
import { registerHooks } from "node:module"
import test, { after, afterEach, beforeEach, mock } from "node:test"

const state = {}
globalThis[Symbol.for("crypto-signals-v2.model-errors")] = state

// Only external backends and dotenv are stubbed; the error helper is real.
const hooks = registerHooks({
  resolve (specifier, context, nextResolve) {
    if (["dotenv/config", "@github/copilot-sdk"].includes(specifier)) {
      return { url: `model-errors:${specifier}`, shortCircuit: true }
    }

    return nextResolve(specifier, context)
  },
  load (url, context, nextLoad) {
    let source

    if (url === "model-errors:dotenv/config") {
      source = "export {}"
    } else if (url === "model-errors:@github/copilot-sdk") {
      source = "export class CopilotClient { constructor() { return state.client } }"
    } else if (url === new URL("../src/api/copilot-unofficial/auth.js", import.meta.url).href) {
      source = "export const getUnofficialCopilotSession = () => state.copilotAuth()"
    } else if (url === new URL("../src/api/openai-unofficial/auth.js", import.meta.url).href) {
      source = "export const getUnofficialOpenAISession = () => state.openaiAuth()"
    }

    return source == null
      ? nextLoad(url, context)
      : {
          format: "module",
          source: `const state = globalThis[Symbol.for("crypto-signals-v2.model-errors")];\n${source}`,
          shortCircuit: true,
        }
  },
})

const { callModel } = await import("../src/helpers/model-helper.js")
const { formatStepError } = await import("../src/helpers/step-error-helper.js")

after(() => {
  hooks.deregister()
  delete globalThis[Symbol.for("crypto-signals-v2.model-errors")]
})

beforeEach(() => {
  mock.method(globalThis, "fetch", async () => {
    throw new Error("Unexpected fetch in an isolated test")
  })
  mock.method(console, "log", () => {})
  state.copilotAuth = async () => ({ token: "test-copilot-token", baseUrl: "https://copilot.invalid" })
  state.openaiAuth = async () => ({
    token: "test-openai-token", refreshToken: "test-refresh-token", accountId: "test-account",
  })
})

afterEach(() => mock.restoreAll())

function requestModel (provider) {
  return callModel("system", "user", { provider, model: "test-model", reasoningEffort: null })
}

test("SDK errors retain original identity, cause and session metadata despite cleanup failure", async () => {
  const cause = new Error("Upstream rejected")
  const failure = Object.assign(new Error("Rate limited", { cause }), { code: "SDK_ERROR" })
  const cleanup = new Error("Stop failed")
  const stack = failure.stack
  state.client = {
    start: async () => {},
    createSession: async () => ({
      on: (type, handler) => {
        state.onSessionError = handler
      },
      sendAndWait: async () => {
        state.onSessionError({ data: {
          errorCode: "user_model_rate_limited", errorType: "rate_limit", statusCode: 429,
          providerCallId: "provider-request", serviceRequestId: "service-request",
        } })
        throw failure
      },
    }),
    stop: async () => {
      throw cleanup
    },
  }

  await assert.rejects(requestModel("copilot-sdk"), (error) => {
    assert.equal(error, failure)
    assert.equal(error.cause, cause)
    assert.equal(error.stack, stack)
    assert.equal(error.name, "Error")
    assert.equal(error.code, "SDK_ERROR")
    assert.equal(error.context.provider, "copilot-sdk")
    assert.equal(error.context.model, "test-model")
    assert.equal(error.context.operation, "send-and-wait")
    assert.equal(error.context.code, "user_model_rate_limited")
    assert.equal(error.context.type, "rate_limit")
    assert.equal(error.context.status, 429)
    assert.equal(error.context.providerCallId, "provider-request")
    assert.equal(error.context.serviceRequestId, "service-request")
    assert.equal(error.cleanupErrors[0], cleanup)
    const text = formatStepError(error, { step: "step10-agent-analysis.js" }, {})
    assert.match(text, /Сбой: step10-agent-analysis\.js/u)
    assert.match(text, /Тип: Лимит запросов \(HTTP 429\)/u)
    assert.match(text, /Провайдер: copilot-sdk\nМодель: test-model/u)
    assert.match(text, /Операция: send-and-wait/u)
    assert.match(text, /Код: user_model_rate_limited\nТип провайдера: rate_limit/u)
    assert.match(text, /Ошибка: Error: Rate limited \[SDK_ERROR\]/u)
    assert.match(text, /Причина: Error: Upstream rejected/u)
    assert.match(text, /Ошибка очистки: Stop failed/u)
    return true
  })
})

test("timeout context matches the actual request limit and is absent during auth", async () => {
  const authFailure = new Error("Cannot load session")
  const timeoutFailure = new DOMException("The operation timed out", "TimeoutError")
  const controller = new AbortController()
  const timeout = mock.method(AbortSignal, "timeout", () => controller.signal)
  const authenticate = state.openaiAuth
  state.openaiAuth = async () => {
    throw authFailure
  }

  await assert.rejects(requestModel("openai-unofficial"), (error) => {
    assert.equal(error, authFailure)
    assert.equal(error.context.operation, "auth")
    assert.equal("timeoutMs" in error.context, false)
    assert.doesNotMatch(formatStepError(error, {}, {}), /Лимит ожидания:/u)
    return true
  })
  assert.equal(timeout.mock.callCount(), 0)
  assert.equal(globalThis.fetch.mock.callCount(), 0)

  state.openaiAuth = authenticate
  mock.method(globalThis, "fetch", async (url, options) => {
    assert.equal(options.signal, controller.signal)
    controller.abort(timeoutFailure)
    throw timeoutFailure
  })

  await assert.rejects(requestModel("openai-unofficial"), (error) => {
    assert.equal(error, timeoutFailure)
    assert.equal(error.name, "TimeoutError")
    assert.equal(error.context.operation, "responses")
    assert.equal(error.context.type, "timeout")
    assert.equal(error.context.timeoutMs, 600000)
    assert.equal(error.context.timeoutMs, timeout.mock.calls[0].arguments[0])
    assert.ok(error.context.elapsedMs >= 0)
    const text = formatStepError(error, {}, {})
    assert.match(text, /Тип: Таймаут/u)
    assert.match(text, /Лимит ожидания: 600 с/u)
    assert.match(text, /Ошибка: TimeoutError: The operation timed out/u)
    return true
  })
  assert.equal(timeout.mock.callCount(), 1)
})

test("Copilot HTTP errors preserve safe provider reasons without raw bodies or session tokens", async () => {
  mock.method(globalThis, "fetch", async () => Response.json({
    error: { message: "Quota exceeded test-copilot-token", code: "quota_exceeded", type: "quota_error" },
    internal: "raw-body-must-not-be-copied",
  }, { status: 429 }))

  await assert.rejects(requestModel("copilot-unofficial"), (error) => {
    assert.equal(error.context.status, 429)
    assert.equal(error.context.code, "quota_exceeded")
    assert.equal(error.context.type, "quota_error")
    assert.match(error.message, /Quota exceeded/)
    assert.doesNotMatch(error.message, /test-copilot-token|raw-body-must-not-be-copied/)
    assert.doesNotMatch(error.stack, /test-copilot-token|raw-body-must-not-be-copied/)
    const text = formatStepError(error, {}, {})
    assert.match(text, /Тип: Лимит запросов \(HTTP 429\)/u)
    assert.match(text, /Код: quota_exceeded\nТип провайдера: quota_error/u)
    assert.match(text, /HTTP 429: Quota exceeded/u)
    assert.doesNotMatch(text, /test-copilot-token|raw-body-must-not-be-copied/)
    return true
  })
})

test("OpenAI SSE failures retain provider code, type and response status", async () => {
  mock.method(globalThis, "fetch", async () => new Response(`data: ${JSON.stringify({
    type: "response.failed",
    response: {
      status: "failed",
      error: { code: "server_error", type: "upstream_error", message: "Capacity exhausted test-openai-token" },
    },
  })}\n\n`))

  await assert.rejects(requestModel("openai-unofficial"), (error) => {
    assert.equal(error.context.code, "server_error")
    assert.equal(error.context.type, "upstream_error")
    assert.equal(error.context.eventType, "response.failed")
    assert.equal(error.context.responseStatus, "failed")
    assert.equal(error.context.status, 200)
    assert.match(error.message, /Capacity exhausted/)
    assert.doesNotMatch(error.message, /test-openai-token/)
    const text = formatStepError(error, {}, {})
    assert.match(text, /Тип: Ошибка агента/u)
    assert.match(text, /Код: server_error\nТип провайдера: upstream_error/u)
    assert.match(text, /OpenAI response failed: Capacity exhausted/u)
    assert.doesNotMatch(text, /test-openai-token/)
    return true
  })
})

test("malformed OpenAI SSE preserves the original parsing error as cause", async () => {
  mock.method(globalThis, "fetch", async () => new Response("data: invalid-json\n\n"))

  await assert.rejects(requestModel("openai-unofficial"), (error) => {
    assert.match(error.message, /invalid SSE event/)
    assert.ok(error.cause instanceof SyntaxError)
    assert.ok(error.cause.stack)
    assert.match(formatStepError(error, {}, {}), /Причина: SyntaxError:/u)
    return true
  })
})
