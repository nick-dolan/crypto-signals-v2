import assert from "node:assert/strict"
import test from "node:test"

import { createTelegramClient } from "../src/api/telegram-api.js"

function pngPhoto () {
  return Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64")
}

function createClient (request, options = {}) {
  return createTelegramClient({
    token: "123456:fake-test-token",
    chatId: " -10012345 ",
    request,
    sleep: async () => assert.fail("Unexpected automatic retry"),
    ...options,
  })
}

test("setChatPhoto sends the PNG bytes and normalized chat_id as multipart and returns true", async () => {
  const photo = pngPhoto()
  let attempts = 0
  const client = createClient(async (url, options) => {
    attempts += 1
    assert.equal(url, "https://api.telegram.org/bot123456:fake-test-token/setChatPhoto")
    assert.equal(options.method, "POST")
    assert.equal(options.redirect, "manual")
    assert.ok(options.signal instanceof AbortSignal)
    assert.ok(options.body instanceof FormData)
    assert.deepEqual([...options.body.keys()], ["chat_id", "photo"])
    assert.equal(options.body.get("chat_id"), "-10012345")
    const file = options.body.get("photo")
    assert.ok(file instanceof Blob)
    assert.equal(file.name, "chat-photo.png")
    assert.equal(file.type, "image/png")
    assert.deepEqual(Buffer.from(await file.arrayBuffer()), photo)
    return Response.json({ ok: true, result: true })
  })

  assert.equal(await client.setChatPhoto(photo), true)
  assert.equal(attempts, 1)
})

test("setChatPhoto rejects empty buffers and other input types before sending", async () => {
  const client = createClient(async () => assert.fail("Invalid photos must not be sent"))
  for (const photo of [undefined, null, "PNG", new Uint8Array([137, 80, 78, 71]), Buffer.alloc(0)]) {
    await assert.rejects(client.setChatPhoto(photo), {
      message: /nonempty PNG Buffer/u,
      deliveryUnknown: false,
    })
  }
})

test("setChatPhoto rejects malformed success responses without retrying", async () => {
  for (const payload of [
    { ok: true, result: { message_id: 1 } },
    { ok: true, result: false },
    { ok: true, result: "true" },
    { ok: true, result: 1 },
    { ok: true, result: null },
    { ok: true },
    { ok: 1, result: true },
    { result: true },
  ]) {
    let attempts = 0
    const client = createClient(async () => {
      attempts += 1
      return Response.json(payload)
    })
    await assert.rejects(client.setChatPhoto(pngPhoto()), {
      message: "Telegram malformed success response",
      deliveryUnknown: true,
    })
    assert.equal(attempts, 1)
  }
})

for (const [method, input] of [["sendMessage", "Test"], ["sendRichMessage", { html: "<b>Test</b>" }]]) {
  test(`${method} still requires a Message with a positive safe message_id`, async () => {
    for (const result of [true, null, {}, { message_id: 0 }, { message_id: -1 }, { message_id: "1" },
      { message_id: 1.5 }, { message_id: Number.MAX_SAFE_INTEGER + 1 }]) {
      const client = createClient(async () => Response.json({ ok: true, result }))
      await assert.rejects(client[method](input), {
        message: "Telegram malformed success response",
        deliveryUnknown: true,
      })
    }
    const message = { message_id: 42 }
    const client = createClient(async () => Response.json({ ok: true, result: message }))
    assert.deepEqual(await client[method](input), message)
  })
}

test("setChatPhoto preserves the Telegram 403 description and does not retry", async () => {
  let attempts = 0
  const client = createClient(async () => {
    attempts += 1
    return Response.json({ ok: false, error_code: 403, description: "Forbidden: not enough rights to change chat photo" }, { status: 403 })
  })
  await assert.rejects(client.setChatPhoto(pngPhoto()), {
    message: "Telegram HTTP rejection: 403: Forbidden: not enough rights to change chat photo",
    status: 403,
    code: 403,
    deliveryUnknown: false,
  })
  assert.equal(attempts, 1)
})

test("setChatPhoto retries 429 once with the same multipart body", async () => {
  for (const secondResponse of [
    { ok: true, result: true },
    { ok: false, error_code: 429, parameters: { retry_after: 2 } },
  ]) {
    const requests = []
    const waits = []
    const client = createClient(async (url, options) => {
      requests.push({ url, body: options.body })
      if (requests.length === 1) {
        return Response.json({ ok: false, error_code: 429, parameters: { retry_after: 2 } }, { status: 429 })
      }
      return Response.json(secondResponse, { status: secondResponse.ok ? 200 : 429 })
    }, { sleep: async ms => waits.push(ms) })

    if (secondResponse.ok) {
      assert.equal(await client.setChatPhoto(pngPhoto()), true)
    } else {
      await assert.rejects(client.setChatPhoto(pngPhoto()), {
        message: "Telegram rate limit exceeded after one retry",
        deliveryUnknown: false,
      })
    }
    assert.equal(requests.length, 2)
    assert.deepEqual(waits, [2_000])
    assert.equal(requests[0].url, "https://api.telegram.org/bot123456:fake-test-token/setChatPhoto")
    assert.equal(requests[1].url, requests[0].url)
    assert.equal(requests[1].body, requests[0].body)
  }
})

test("unknown delivery never automatically repeats photo or message requests", async () => {
  for (const [method, input] of [
    ["setChatPhoto", pngPhoto()],
    ["sendMessage", "Test"],
    ["sendRichMessage", { html: "<b>Test</b>" }],
  ]) {
    const cause = new Error("Connection reset after upload")
    let attempts = 0
    const client = createClient(async () => {
      attempts += 1
      throw cause
    })
    await assert.rejects(client[method](input), (error) => {
      assert.equal(error.message, "Telegram transport failure")
      assert.equal(error.deliveryUnknown, true)
      assert.equal(error.cause, cause)
      return true
    })
    assert.equal(attempts, 1)
  }
})
