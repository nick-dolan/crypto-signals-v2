import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import test from "node:test"

import { createTelegramClient } from "../src/api/telegram-api.js"
import { withErrorContext } from "../src/helpers/error-helper.js"
import { runStepProcess } from "../src/helpers/run-step-process.js"
import { formatStepError, reportStepError, sendErrorNotification } from "../src/helpers/step-error-helper.js"

function runChild (source, notify, stderr = { write () {} }) {
  return runStepProcess("src/test-step.js", {
    notify,
    stderr,
    spawnProcess: (executable, args, options) => spawn(executable, ["--input-type=module", "-e", source], {
      ...options,
      env: { ...options.env, TELEGRAM_ERRORS_BOT_TOKEN: "", TELEGRAM_MY_ID: "", DOTENV_CONFIG_PATH: "/dev/null" },
    }),
  })
}

test("reports preserve technical causes and redact secrets before truncating or sending IPC", async () => {
  const env = { TELEGRAM_ERRORS_BOT_TOKEN: "123456:abcdefghijklmnopqrstuvwxyz", API_KEY: "private-test-key" }
  const cause = Object.assign(new Error(`connect ETIMEDOUT ${env.API_KEY}`), { code: "ETIMEDOUT" })
  const error = withErrorContext(new Error(`Agent failed Bearer dynamic-session-token ${env.TELEGRAM_ERRORS_BOT_TOKEN} {"Cookie":"session=runtime-cookie"}`, { cause }), {
    step: "step8-context-enrichment.js", provider: "copilot-sdk", model: "test-model", symbol: "TEST", timeoutMs: 600_000,
  })
  const text = formatStepError(error, { step: "candidate-enrichment.js" }, env)
  assert.match(text, /Сбой: step8-context-enrichment\.js/u)
  assert.match(text, /Тип: Таймаут/u)
  assert.match(text, /Монета: TEST/u)
  assert.match(text, /Провайдер: copilot-sdk\nМодель: test-model/u)
  assert.match(text, /Лимит ожидания: 600 с/u)
  assert.match(text, /Причина: Error: connect ETIMEDOUT/u)
  assert.doesNotMatch(text, /private-test-key|abcdefghijklmnopqrstuvwxyz|dynamic-session-token|runtime-cookie/u)
  assert.ok(formatStepError(new Error("long ".repeat(2_000)), {}, env).length <= 4_096)
  assert.doesNotMatch(formatStepError(new Error(JSON.stringify({ "Set-Cookie": ["sid=first; Path=/", "refresh=second; Path=/"] })), {}, env), /first|second/u)

  const messages = []
  const options = {
    env,
    send: (message, callback) => {
      messages.push(message)
      callback(null)
    },
    notify: async () => assert.fail("IPC reports must be delivered only by the parent"),
  }
  await Promise.all([reportStepError(error, {}, options), reportStepError(error, { fatal: true }, options)])
  assert.equal(messages.length, 1)
  assert.doesNotMatch(JSON.stringify(messages), /private-test-key|abcdefghijklmnopqrstuvwxyz|dynamic-session-token|runtime-cookie/u)
})

test("notification delivery uses the errors bot and TELEGRAM_MY_ID; a delivery failure does not hide the original", async () => {
  const env = { TELEGRAM_ERRORS_BOT_TOKEN: "123456:abcdefghijklmnopqrstuvwxyz", TELEGRAM_MY_ID: "12345" }
  const sent = []
  const logs = []
  let clock = 100_000
  const options = {
    env,
    sleep: async () => {},
    now: () => clock,
    log: message => logs.push(message),
    createClient: (settings) => {
      assert.deepEqual(settings, { token: env.TELEGRAM_ERRORS_BOT_TOKEN, chatId: env.TELEGRAM_MY_ID, timeoutMs: 10_000 })
      return { sendMessage: async text => sent.push(text) }
    },
  }
  assert.equal(await sendErrorNotification(`failure ${env.TELEGRAM_ERRORS_BOT_TOKEN}`, options), true)
  assert.doesNotMatch(sent[0], /abcdefghijklmnopqrstuvwxyz/u)
  let attempts = 0
  const results = await Promise.all(Array.from({ length: 20 }, () => sendErrorNotification("failure", {
    ...options,
    createClient: () => ({ sendMessage: async () => {
      attempts += 1
      throw new Error(`Telegram unavailable ${env.TELEGRAM_ERRORS_BOT_TOKEN}`)
    } }),
  })))
  assert.ok(results.every(result => result === false))
  assert.equal(attempts, 1)
  assert.match(logs[0], /Telegram unavailable/u)
  assert.doesNotMatch(logs[0], /abcdefghijklmnopqrstuvwxyz/u)

  const original = new Error("Original failure")
  const fallback = []
  assert.equal(await reportStepError(original, {}, {
    env,
    send: (message, callback) => callback(new Error("IPC closed")),
    notify: async (text) => {
      fallback.push(text)
      return false
    },
  }), false)
  assert.match(fallback[0], /Original failure/u)
  assert.equal(original.message, "Original failure")
  clock += 60_001
  assert.equal(await sendErrorNotification("after failure", options), true)
})

test("plain Telegram delivery preserves rejection reasons and has a bounded request timeout", async () => {
  const requests = []
  const client = createTelegramClient({
    token: "123456:abcdefghijklmnopqrstuvwxyz",
    chatId: "12345",
    request: async (url, options) => {
      requests.push({ url, options })
      return Response.json({ ok: true, result: { message_id: 1 } })
    },
  })
  await client.sendMessage("Failure <not HTML>")
  assert.match(requests[0].url, /\/sendMessage$/u)
  assert.equal(requests[0].options.body.get("chat_id"), "12345")
  assert.equal(requests[0].options.body.get("text"), "Failure <not HTML>")
  assert.equal(requests[0].options.body.has("parse_mode"), false)

  const rejected = createTelegramClient({
    token: "123456:abcdefghijklmnopqrstuvwxyz", chatId: "12345",
    request: async () => Response.json({ ok: false, error_code: 403, description: "Forbidden: bot was blocked by the user" }, { status: 403 }),
  })
  await assert.rejects(rejected.sendMessage("Failure"), (error) => {
    assert.equal(error.status, 403)
    assert.match(error.message, /bot was blocked/u)
    return true
  })
  const hanging = createTelegramClient({
    token: "123456:abcdefghijklmnopqrstuvwxyz", chatId: "12345", timeoutMs: 5,
    request: () => new Promise(() => {}),
  })
  await assert.rejects(hanging.sendMessage("Failure"), /timed out/u)
})

test("a caught step failure and a partial failure with a nonzero exit are each delivered once", async () => {
  const sent = []
  const helper = new URL("../src/helpers/run-step-helper.js", import.meta.url).href
  const reporter = new URL("../src/helpers/step-error-helper.js", import.meta.url).href
  const failed = await runChild(`
    import { runStep } from ${JSON.stringify(helper)}
    await runStep("test-step.js", async () => { throw new Error("agent timeout", { cause: new Error("upstream unavailable") }) })
  `, async text => sent.push(text))
  assert.equal(failed.succeeded, false)
  assert.equal(failed.error.reported, true)
  assert.equal(sent.length, 1)
  assert.match(sent[0], /agent timeout/u)
  assert.match(sent[0], /Причина: Error: upstream unavailable/u)

  sent.length = 0
  const partial = await runChild(`
    import { runStep } from ${JSON.stringify(helper)}
    import { reportStepError } from ${JSON.stringify(reporter)}
    await runStep("test-step.js", async () => {
      await reportStepError(new Error("model failed"), { step: "step12.1-market-brief.js" })
      process.exitCode = 1
    })
  `, async text => sent.push(text))
  assert.equal(partial.succeeded, false)
  assert.equal(sent.length, 1)
  assert.match(sent[0], /model failed/u)
})

test("process monitoring catches syntax errors, late crashes and signals without inventing a cause", async () => {
  const sent = []
  const syntax = await runChild("this is invalid JavaScript", async text => sent.push(text))
  assert.equal(syntax.succeeded, false)
  assert.equal(sent.length, 1)
  assert.match(sent[0], /SyntaxError/u)

  sent.length = 0
  let journal = ""
  await runChild(`
    process.stderr.write("123456:abcdefghijklmn")
    setTimeout(() => process.stderr.write("opqrstuvwxyz\\n"), 5)
    setTimeout(() => { throw new Error("failed after logging") }, 15)
  `, async text => sent.push(text), {
    write (text) {
      journal += text
    },
  })
  assert.doesNotMatch(journal, /abcdefghijklmnopqrstuvwxyz|123456:/u)
  assert.doesNotMatch(sent[0], /abcdefghijklmnopqrstuvwxyz|123456:/u)
  assert.match(journal, /\[redacted\]/u)

  sent.length = 0
  const helper = new URL("../src/helpers/run-step-helper.js", import.meta.url).href
  const reporter = new URL("../src/helpers/step-error-helper.js", import.meta.url).href
  const late = await runChild(`
    import { runStep } from ${JSON.stringify(helper)}
    import { reportStepError } from ${JSON.stringify(reporter)}
    await runStep("test-step.js", async () => {
      await reportStepError(new Error("partial failure"))
      process.exitCode = 1
    })
    process.once("beforeExit", () => {
      setImmediate(() => { throw new Error("late process failure") })
    })
  `, async text => sent.push(text))
  assert.equal(late.succeeded, false)
  assert.equal(sent.length, 2)
  assert.match(sent[1], /late process failure/u)

  sent.length = 0
  const killed = await runChild("process.kill(process.pid, \"SIGKILL\")", async text => sent.push(text))
  assert.equal(killed.succeeded, false)
  assert.equal(sent.length, 1)
  assert.match(sent[0], /Завершение по сигналу SIGKILL/u)
  assert.doesNotMatch(sent[0], /Тип: Таймаут|out of memory/u)
})
