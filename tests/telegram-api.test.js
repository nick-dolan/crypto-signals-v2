import assert from "node:assert/strict"
import test from "node:test"
import { inspect } from "node:util"

import { createTelegramClient } from "../src/api/telegram-api.js"

function client (options = {}) {
  return createTelegramClient({ token: "123456:telegram-test_secret", chatId: -100123, ...options })
}

function success (result = { message_id: 42, chat: { id: -100123, type: "channel" } }) {
  return Response.json({ ok: true, result })
}

function photoMessage (id = "chart") {
  return { html: "<b>Market report</b>", media: [{ id, media: { type: "photo", media: `attach://${id}` } }] }
}

function photoFile (name = "chart") {
  return {
    name,
    fileName: `${name}.png`,
    data: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZ1cAAAAASUVORK5CYII=", "base64"),
  }
}

function safeError (deliveryUnknown, message) {
  return (error) => {
    assert.equal(error.deliveryUnknown, deliveryUnknown)
    assert.match(error.message, message)
    assert.equal(error.cause, undefined)
    const rendered = `${inspect(error, { showHidden: true })}\n${JSON.stringify(error)}`
    for (const secret of ["123456:telegram-test_secret", "987654:env-test_secret", "https://", "api.telegram.org", "private-response", "private-exception"]) {
      assert.equal(rendered.includes(secret), false, "Errors must not expose credentials or underlying failures")
    }
    return true
  }
}

function environment (context, values) {
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]))
  function apply (entries) {
    for (const [key, value] of Object.entries(entries)) {
      if (value === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = value
      }
    }
  }
  apply(values)
  context.after(() => apply(previous))
}

test("sends one multipart rich message with matching PNG bytes and no credentials or paid broadcast fields", async (context) => {
  const expected = { message_id: 42, chat: { id: -100123, type: "channel", title: "Reports" }, date: 1_800_000_000 }
  const request = context.mock.fn(async () => success(expected))
  const globalRequest = context.mock.method(globalThis, "fetch", () => assert.fail("Unexpected global fetch"))
  const telegram = client({ token: " 123456:telegram-test_secret \n", chatId: " -100123 ", request })
  const richMessage = {
    html: "<b>Market report</b>\nBTC &amp; ETH",
    media: [photoMessage("btc").media[0], photoMessage("eth").media[0]],
  }
  const files = [photoFile("eth"), photoFile("btc")]

  assert.equal(telegram.chatId, "-100123")
  assert.deepEqual(Object.keys(telegram).sort(), ["chatId", "sendRichMessage"])
  assert.equal(request.mock.callCount(), 0, "Factory must not send requests")
  assert.deepEqual(await telegram.sendRichMessage({ ...richMessage, token: "123456:telegram-test_secret", allow_paid_broadcast: true }, files), expected)
  assert.equal(request.mock.callCount(), 1)
  assert.equal(globalRequest.mock.callCount(), 0)

  const [url, options] = request.mock.calls[0].arguments
  assert.equal(url, "https://api.telegram.org/bot123456:telegram-test_secret/sendRichMessage")
  assert.equal(options.method, "POST")
  assert.equal(options.redirect, "manual")
  assert.equal(options.signal instanceof AbortSignal, true)
  assert.equal(options.body instanceof FormData, true)
  assert.equal(options.headers, undefined, "Fetch must generate the multipart boundary")

  const outgoing = new Request(url, options)
  assert.match(outgoing.headers.get("content-type"), /^multipart\/form-data; boundary=/u)
  const wire = await outgoing.clone().text()
  for (const value of ["123456:telegram-test_secret", "api.telegram.org", "allow_paid_broadcast", "token"]) {
    assert.equal(wire.includes(value), false)
  }
  const form = await outgoing.formData()
  assert.deepEqual([...form.keys()], ["chat_id", "rich_message", "eth", "btc"])
  assert.equal(form.get("chat_id"), "-100123")
  assert.deepEqual(JSON.parse(form.get("rich_message")), richMessage)
  for (const { name, fileName, data } of files) {
    const uploaded = form.get(name)
    assert.equal(uploaded.name, fileName)
    assert.equal(uploaded.type, "image/png")
    assert.deepEqual(Buffer.from(await uploaded.arrayBuffer()), data)
  }
})

test("supports text-only rich messages with omitted or empty media and files", async (context) => {
  const request = context.mock.fn(async () => success({ message_id: 1 }))
  const telegram = client({ request })
  for (const richMessage of [{ html: "<b>Text only</b>" }, { html: "<b>Text only</b>", media: [] }]) {
    assert.deepEqual(await telegram.sendRichMessage(richMessage), { message_id: 1 })
    const { body } = request.mock.calls.at(-1).arguments[1]
    assert.deepEqual([...body.keys()], ["chat_id", "rich_message"])
    assert.deepEqual(JSON.parse(body.get("rich_message")), { html: "<b>Text only</b>", media: [] })
  }
  assert.equal(request.mock.callCount(), 2)
})

test("reads and normalizes environment defaults at factory creation and allows injected overrides", async (context) => {
  environment(context, { TELEGRAM_BOT_TOKEN: " 987654:env-test_secret \n", TELEGRAM_CHAT_ID: " @report_channel " })
  const request = context.mock.method(globalThis, "fetch", async () => success())
  const telegram = createTelegramClient()
  assert.equal(telegram.chatId, "@report_channel")
  assert.equal(request.mock.callCount(), 0)
  process.env.TELEGRAM_BOT_TOKEN = "changed:invalid"
  process.env.TELEGRAM_CHAT_ID = "changed-channel"
  await telegram.sendRichMessage({ html: "Report" })
  assert.equal(request.mock.calls[0].arguments[0], "https://api.telegram.org/bot987654:env-test_secret/sendRichMessage")
  assert.equal(request.mock.calls[0].arguments[1].body.get("chat_id"), "@report_channel")

  const injectedRequest = context.mock.fn(async () => success())
  await client({ request: injectedRequest }).sendRichMessage({ html: "Report" })
  assert.equal(injectedRequest.mock.calls[0].arguments[0], "https://api.telegram.org/bot123456:telegram-test_secret/sendRichMessage")
  assert.equal(injectedRequest.mock.calls[0].arguments[1].body.get("chat_id"), "-100123")
  assert.equal(request.mock.callCount(), 1)
})

test("missing settings fail synchronously without requests or timers", (context) => {
  environment(context, { TELEGRAM_BOT_TOKEN: undefined, TELEGRAM_CHAT_ID: undefined })
  const request = context.mock.method(globalThis, "fetch", () => assert.fail("Unexpected fetch"))
  const timer = context.mock.method(globalThis, "setTimeout")
  assert.throws(() => createTelegramClient(), safeError(false, /bot token/u))
  assert.throws(() => createTelegramClient({ token: "123456:telegram-test_secret" }), safeError(false, /chatId/u))
  assert.equal(request.mock.callCount(), 0)
  assert.equal(timer.mock.callCount(), 0)
})

test("validates token path safety, chat IDs, timeouts and injected functions synchronously", (context) => {
  environment(context, { TELEGRAM_BOT_TOKEN: undefined, TELEGRAM_CHAT_ID: undefined })
  const request = context.mock.fn(() => assert.fail("Unexpected request"))
  const timer = context.mock.method(globalThis, "setTimeout")
  for (const token of [undefined, null, "", " \n ", 123, {}, "not-a-token", "abc:secret", "123:secret/path", "123:secret?query", "123:secret#fragment", "123:secret%2fpath", "123:secret\\path", "123:secret\npath", "https://private-exception"]) {
    assert.throws(() => client({ token, request }), safeError(false, /bot token/u))
  }
  for (const chatId of [undefined, null, "", " \n ", {}, [], true, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => client({ chatId, request }), safeError(false, /chatId/u))
  }
  for (const timeoutMs of [0, -1, NaN, Infinity, "100", null]) {
    assert.throws(() => client({ timeoutMs, request }), safeError(false, /timeoutMs/u))
  }
  for (const options of [{ request: null }, { request: "fetch" }, { sleep: null }, { sleep: "sleep" }]) {
    assert.throws(() => client({ request, ...options }), safeError(false, /must be functions/u))
  }
  for (const [chatId, expected] of [[" @channel ", "@channel"], [" -100123 ", "-100123"], [-100123, "-100123"], [0, "0"], [Number.MAX_SAFE_INTEGER, "9007199254740991"]]) {
    assert.equal(client({ chatId, request }).chatId, expected)
  }
  assert.equal(request.mock.callCount(), 0)
  assert.equal(timer.mock.callCount(), 0)
})

test("rejects invalid rich messages and mismatched attachments locally without leaking input errors", async (context) => {
  const request = context.mock.fn(() => assert.fail("Unexpected request"))
  const sleep = context.mock.fn(() => assert.fail("Unexpected sleep"))
  const timer = context.mock.method(globalThis, "setTimeout")
  const telegram = client({ request, sleep })
  const cases = [
    [undefined], [null], ["private-response"], [{}], [{ html: 123 }], [{ html: " \n " }],
    [{ html: "Report", media: null }], [{ html: "Report", media: {} }],
    [{ html: "Report", media: [null] }], [{ html: "Report", media: [{ id: "chart" }] }],
    [photoMessage(), null], [photoMessage(), {}], [photoMessage()],
    [{ html: "Report" }, [photoFile()]],
    [photoMessage(), [photoFile("other")]],
    [photoMessage(), [photoFile(), photoFile()]],
    [{ html: "Report", media: [...photoMessage().media, ...photoMessage().media] }, [photoFile(), photoFile()]],
    [{ html: "Report", media: [...photoMessage("a").media, ...photoMessage("b").media] }, [photoFile("a"), photoFile("a")]],
    [photoMessage(), [null]],
    [photoMessage(), [{ ...photoFile(), fileName: " " }]],
    [photoMessage(), [{ ...photoFile(), fileName: 123 }]],
    [photoMessage(), [{ ...photoFile(), data: "private-response" }]],
    [photoMessage(), [{ ...photoFile(), data: new Uint8Array([1, 2]) }]],
    [photoMessage(), [{ ...photoFile(), data: Buffer.alloc(0) }]],
    [photoMessage("chat_id"), [photoFile("chat_id")]],
    [photoMessage("rich_message"), [photoFile("rich_message")]],
    [photoMessage("bad\nname"), [photoFile("bad\nname")]],
    [{ html: "Report", media: [{ id: "chart", media: { type: "video", media: "attach://chart" } }] }, [photoFile()]],
    [{ html: "Report", media: [{ id: "chart", media: { type: "photo", media: "attach://other" } }] }, [photoFile()]],
    [{ html: "Report", media: [{ id: "chart", media: { type: "photo", media: "https://private-response" } }] }, [photoFile()]],
    [{
      get html () {
        throw new Error("private-exception 123456:telegram-test_secret")
      },
    }],
  ]
  for (const args of cases) {
    await assert.rejects(telegram.sendRichMessage(...args), safeError(false, /rich message and PNG attachments/u))
  }
  assert.equal(request.mock.callCount(), 0)
  assert.equal(sleep.mock.callCount(), 0)
  assert.equal(timer.mock.callCount(), 0)
})

test("clears the request timer after a successful response", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] })
  const request = context.mock.fn(async () => success())
  await client({ request }).sendRichMessage({ html: "Report" })
  context.mock.timers.tick(60_000)
  assert.equal(request.mock.calls[0].arguments[1].signal.aborted, false)
})

test("enforces default and injected request timeouts even when the transport ignores abort", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] })
  for (const timeoutMs of [undefined, 100]) {
    const request = context.mock.fn(() => new Promise(() => {}))
    const sleep = context.mock.fn(() => assert.fail("Unexpected retry"))
    const pending = assert.rejects(client({ request, sleep, timeoutMs }).sendRichMessage({ html: "Report" }), safeError(true, /timed out/u))
    const { signal } = request.mock.calls[0].arguments[1]
    context.mock.timers.tick((timeoutMs ?? 60_000) - 1)
    assert.equal(signal.aborted, false)
    context.mock.timers.tick(1)
    await pending
    assert.equal(signal.aborted, true)
    assert.equal(request.mock.callCount(), 1)
    assert.equal(sleep.mock.callCount(), 0)
  }
})

test("keeps the deadline active through response-body reads and preserves known HTTP rejection", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] })
  for (const status of [200, 400, 429]) {
    const { promise: reading, resolve: started } = Promise.withResolvers()
    const request = context.mock.fn(async () => ({
      status,
      text: () => {
        started()
        return new Promise(() => {})
      },
    }))
    const sleep = context.mock.fn(() => assert.fail("Unexpected retry"))
    const pending = assert.rejects(client({ request, sleep, timeoutMs: 100 }).sendRichMessage({ html: "Report" }), safeError(status === 200, /timed out/u))
    await reading
    context.mock.timers.tick(99)
    assert.equal(request.mock.calls[0].arguments[1].signal.aborted, false)
    context.mock.timers.tick(1)
    await pending
    assert.equal(request.mock.calls[0].arguments[1].signal.aborted, true)
    assert.equal(request.mock.callCount(), 1)
    assert.equal(sleep.mock.callCount(), 0)
  }
})

test("never follows redirects or reads their hostile bodies", async (context) => {
  const sleep = context.mock.fn(() => assert.fail("Unexpected retry"))
  for (const status of [301, 302, 303, 307, 308]) {
    const text = context.mock.fn(() => assert.fail("Must not read redirect bodies"))
    const request = context.mock.fn(async () => ({ status, text, headers: new Headers({ location: "https://private-response" }) }))
    await assert.rejects(client({ request, sleep }).sendRichMessage({ html: "Report" }), safeError(false, /redirects/u))
    assert.equal(request.mock.calls[0].arguments[1].redirect, "manual")
    assert.equal(request.mock.callCount(), 1)
    assert.equal(text.mock.callCount(), 0)
  }
  assert.equal(sleep.mock.callCount(), 0)
})

for (const [name, reply, unknown, message] of [
  ["non-JSON success", () => new Response("private-response 123456:telegram-test_secret https://api.telegram.org"), true, /invalid response body/u],
  ["empty success body", () => new Response(null, { status: 204 }), true, /invalid response body/u],
  ["null success", () => Response.json(null), true, /malformed success/u],
  ["array success", () => Response.json([]), true, /malformed success/u],
  ["missing ok", () => Response.json({ result: { message_id: 1 } }), true, /malformed success/u],
  ["nonboolean ok", () => Response.json({ ok: "true", result: { message_id: 1 } }), true, /malformed success/u],
  ["missing result", () => Response.json({ ok: true }), true, /malformed success/u],
  ["missing message ID", () => success({}), true, /malformed success/u],
  ["null result", () => success(null), true, /malformed success/u],
  ["array result", () => success([{ message_id: 1 }]), true, /malformed success/u],
  ["zero message ID", () => success({ message_id: 0 }), true, /malformed success/u],
  ["negative message ID", () => success({ message_id: -1 }), true, /malformed success/u],
  ["fractional message ID", () => success({ message_id: 1.5 }), true, /malformed success/u],
  ["string message ID", () => success({ message_id: "42" }), true, /malformed success/u],
  ["unsafe message ID", () => success({ message_id: Number.MAX_SAFE_INTEGER + 1 }), true, /malformed success/u],
  ["non-JSON HTTP rejection", () => new Response("private-response", { status: 400, statusText: "private-exception" }), false, /HTTP rejection: 400/u],
  ["HTTP unauthorized", () => Response.json({ ok: false, description: "private-response 123456:telegram-test_secret" }, { status: 401 }), false, /HTTP rejection: 401/u],
  ["HTTP forbidden", () => Response.json({ ok: false, error_code: 403 }, { status: 403 }), false, /HTTP rejection: 403/u],
  ["contradictory HTTP rejection", () => Response.json({ ok: true, result: { message_id: 1 } }, { status: 404 }), false, /HTTP rejection: 404/u],
  ["explicit Telegram rejection", () => Response.json({ ok: false, description: "private-response https://api.telegram.org" }), false, /rejected the rich message/u],
  ["Telegram server error", () => Response.json({ ok: false, error_code: 500, description: "private-response" }), true, /server error/u],
  ["Telegram server error in HTTP rejection", () => Response.json({ ok: false, error_code: 503 }, { status: 400 }), true, /server error/u],
  ["HTTP server error", () => new Response("private-response", { status: 500 }), true, /server error/u],
  ["HTTP server error with explicit rejection", () => Response.json({ ok: false, error_code: 503 }, { status: 503 }), true, /server error/u],
  ["HTTP server error with retry parameters", () => Response.json({ ok: false, error_code: 429, parameters: { retry_after: 1 } }, { status: 502 }), true, /server error/u],
  ["non-JSON rate limit", () => new Response("private-response", { status: 429 }), false, /rate limit/u],
  ["rate limit without explicit rejection", () => Response.json({ parameters: { retry_after: 1 } }, { status: 429 }), false, /rate limit/u],
  ["rate limit with contradictory success", () => Response.json({ ok: true, result: { message_id: 42 }, parameters: { retry_after: 1 } }, { status: 429 }), false, /rate limit/u],
  ["rate limit code without explicit rejection", () => Response.json({ error_code: 429, parameters: { retry_after: 1 } }), true, /malformed success/u],
  ["response missing status", () => ({ text: async () => "private-response" }), true, /invalid response/u],
  ["invalid status", () => ({ status: "private-response" }), true, /invalid response/u],
  ["opaque response", () => ({ status: 0 }), true, /invalid response/u],
  ["body read failure", () => ({
    status: 200,
    text: async () => {
      throw new Error("private-exception 123456:telegram-test_secret")
    },
  }), true, /invalid response body/u],
  ["HTTP rejection body failure", () => ({
    status: 400,
    text: async () => {
      throw "private-exception"
    },
  }), false, /HTTP rejection: 400/u],
  ["rate limit body failure", () => ({
    status: 429,
    text: async () => {
      throw "private-exception"
    },
  }), false, /rate limit/u],
]) {
  test(`${name} is sanitized, classified and never retried`, async (context) => {
    context.mock.timers.enable({ apis: ["setTimeout"] })
    const request = context.mock.fn(async () => reply())
    const sleep = context.mock.fn(() => assert.fail("Unexpected retry"))
    await assert.rejects(client({ request, sleep }).sendRichMessage({ html: "Report" }), safeError(unknown, message))
    context.mock.timers.tick(60_000)
    assert.equal(request.mock.calls[0].arguments[1].signal.aborted, false)
    assert.equal(request.mock.callCount(), 1)
    assert.equal(sleep.mock.callCount(), 0)
  })
}

test("sanitizes synchronous and asynchronous transport exceptions without trusting their delivery flags", async (context) => {
  const sleep = context.mock.fn(() => assert.fail("Unexpected retry"))
  for (const failure of [new Error("private-exception 123456:telegram-test_secret https://api.telegram.org", { cause: new Error("private-response") }), { message: "private-response", deliveryUnknown: false }, "private-exception", null]) {
    for (const asynchronous of [false, true]) {
      const request = context.mock.fn(() => {
        if (asynchronous) {
          return Promise.reject(failure)
        }
        throw failure
      })
      await assert.rejects(client({ request, sleep }).sendRichMessage({ html: "Report" }), safeError(true, /transport failure/u))
      assert.equal(request.mock.callCount(), 1)
    }
  }
  assert.equal(sleep.mock.callCount(), 0)
})

test("retries one explicit 429 rejection after a bounded injected sleep, preserving the multipart payload", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] })
  for (const [status, retryAfter] of [[200, 1], [429, 60]]) {
    const request = context.mock.fn(async () => request.mock.callCount() === 0
      ? Response.json({ ok: false, error_code: 429, parameters: { retry_after: retryAfter } }, { status })
      : success())
    const sleep = context.mock.fn(async (ms) => {
      assert.equal(ms, retryAfter * 1_000)
      context.mock.timers.tick(60_000)
      assert.equal(request.mock.calls[0].arguments[1].signal.aborted, false, "The first attempt timer must be cleared before waiting")
    })
    assert.deepEqual(await client({ request, sleep }).sendRichMessage(photoMessage(), [photoFile()]), { message_id: 42, chat: { id: -100123, type: "channel" } })
    assert.equal(request.mock.callCount(), 2)
    assert.equal(sleep.mock.callCount(), 1)
    const first = request.mock.calls[0].arguments[1]
    const second = request.mock.calls[1].arguments[1]
    assert.equal(first.body, second.body)
    assert.notEqual(first.signal, second.signal)
    assert.deepEqual(Buffer.from(await second.body.get("chart").arrayBuffer()), photoFile().data)
    context.mock.timers.tick(60_000)
    assert.equal(second.signal.aborted, false)
  }
})

test("rejects missing, excessive and invalid retry_after values without sleeping or retrying", async (context) => {
  for (const retryAfter of [undefined, null, 0, -1, 1.5, "1", 61, 3_600, {}, []]) {
    const request = context.mock.fn(async () => Response.json({ ok: false, error_code: 429, parameters: { retry_after: retryAfter } }, { status: 429 }))
    const sleep = context.mock.fn(() => assert.fail("Unexpected sleep"))
    await assert.rejects(client({ request, sleep }).sendRichMessage({ html: "Report" }), safeError(false, /rate limit/u))
    assert.equal(request.mock.callCount(), 1)
    assert.equal(sleep.mock.callCount(), 0)
  }
})

test("stops after the second explicit 429 rejection", async (context) => {
  const request = context.mock.fn(async () => Response.json({ ok: false, error_code: 429, parameters: { retry_after: 1 } }, { status: 429 }))
  const sleep = context.mock.fn(async () => {})
  await assert.rejects(client({ request, sleep }).sendRichMessage({ html: "Report" }), safeError(false, /rate limit exceeded after one retry/u))
  assert.equal(request.mock.callCount(), 2)
  assert.equal(sleep.mock.callCount(), 1)
})

test("does not retry ambiguous failures after an initial explicit rate-limit rejection", async (context) => {
  for (const reply of [
    () => {
      throw new Error("private-exception 123456:telegram-test_secret")
    },
    () => new Response("private-response"),
    () => success({ message_id: 0 }),
    () => Response.json({ ok: false, error_code: 503 }, { status: 503 }),
  ]) {
    const request = context.mock.fn(async () => request.mock.callCount() === 0
      ? Response.json({ ok: false, error_code: 429, parameters: { retry_after: 1 } }, { status: 429 })
      : reply())
    const sleep = context.mock.fn(async () => {})
    await assert.rejects(client({ request, sleep }).sendRichMessage({ html: "Report" }), safeError(true, /Telegram/u))
    assert.equal(request.mock.callCount(), 2)
    assert.equal(sleep.mock.callCount(), 1)
  }
})

test("a timed-out second attempt remains ambiguous and is never retried", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] })
  const { promise: retrying, resolve: started } = Promise.withResolvers()
  const request = context.mock.fn(async () => {
    if (request.mock.callCount() === 0) {
      return Response.json({ ok: false, error_code: 429, parameters: { retry_after: 1 } }, { status: 429 })
    }
    started()
    return new Promise(() => {})
  })
  const sleep = context.mock.fn(async () => {})
  const pending = assert.rejects(client({ request, sleep, timeoutMs: 100 }).sendRichMessage({ html: "Report" }), safeError(true, /timed out/u))
  await retrying
  context.mock.timers.tick(100)
  await pending
  assert.equal(request.mock.callCount(), 2)
  assert.equal(sleep.mock.callCount(), 1)
})

test("a failed rate-limit wait is sanitized and does not send a second request", async (context) => {
  const request = context.mock.fn(async () => Response.json({ ok: false, error_code: 429, parameters: { retry_after: 1 } }, { status: 429 }))
  const sleep = context.mock.fn(async () => {
    throw new Error("private-exception https://api.telegram.org 123456:telegram-test_secret")
  })
  await assert.rejects(client({ request, sleep }).sendRichMessage({ html: "Report" }), safeError(false, /rate-limit wait failed/u))
  assert.equal(request.mock.callCount(), 1)
})
