import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import { createTelegramClient } from "../src/api/telegram-api.js"
import { buildTelegramRelease } from "../src/reports/telegram/build-telegram-release.js"
import { sendTelegramRelease } from "../src/reports/telegram/send-telegram-release.js"

async function prepareRelease (t, count = 2) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "telegram-delivery-"))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const manifest = {
    ...buildTelegramRelease({
      asOf: "2026-10-01T09:00:00.000Z", timeframe: "1h",
      coins: Array.from({ length: count }, (_, index) => ({ symbol: `TEST${index + 1}`, topRank: index + 1 })),
    }),
    source: "reports/saved-report",
  }
  const release = { directory: root, manifestPath: path.join(root, "release.json") }
  await fs.mkdir(path.join(root, "cards"))
  const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
  for (const candidate of manifest.candidates) {
    await fs.writeFile(path.join(root, candidate.image), png)
  }
  await fs.writeFile(release.manifestPath, JSON.stringify(manifest))
  let messageId = 77
  const client = { chatId: "-100123", sendRichMessage: t.mock.fn(async () => ({ message_id: messageId++, chat: { id: -100123 } })) }
  return {
    release, manifest, png,
    options: { reportId: "saved-report", directory: path.join(root, "delivery"), client },
    receiptPath: path.join(root, "delivery", "saved-report.json"),
  }
}

for (const count of [0, 1, 10, 11, 50]) {
  test(`sends one rich post with ${count} photos on every invocation and records the latest confirmation`, async (t) => {
    const { release, manifest, png, options, receiptPath } = await prepareRelease(t, count)
    const result = await sendTelegramRelease(release, options)
    assert.deepEqual(result, { status: "sent", messageId: 77, receiptPath })
    const send = options.client.sendRichMessage
    assert.equal(send.mock.callCount(), 1)
    const [payload, files] = send.mock.calls[0].arguments
    assert.deepEqual(payload, manifest.richMessage)
    assert.equal(files.length, count)
    assert.deepEqual(files.map(file => file.name), manifest.richMessage.media.map(item => item.id))
    for (const [index, file] of files.entries()) {
      assert.equal(file.fileName, path.basename(manifest.candidates[index].image))
      assert.deepEqual(file.data, png)
    }
    assert.ok(!JSON.stringify(payload).includes(release.directory))
    const receipt = JSON.parse(await fs.readFile(receiptPath, "utf8"))
    assert.equal(receipt.status, "sent")
    assert.equal(receipt.reportId, options.reportId)
    assert.equal(receipt.chatId, options.client.chatId)
    assert.equal(receipt.messageId, 77)
    assert.equal(receipt.releaseDirectory, release.directory)
    assert.ok(Date.parse(receipt.sentAt) >= Date.parse(receipt.startedAt))
    assert.deepEqual(await sendTelegramRelease(release, options), { status: "sent", messageId: 78, receiptPath })
    assert.equal(send.mock.callCount(), 2)
    const latest = JSON.parse(await fs.readFile(receiptPath, "utf8"))
    assert.equal(latest.messageId, 78)
    assert.equal(latest.status, "sent")
    assert.equal(latest.reportId, receipt.reportId)
    assert.equal(latest.chatId, receipt.chatId)
    assert.ok(Date.parse(latest.sentAt) >= Date.parse(receipt.sentAt))
    assert.deepEqual(JSON.parse(await fs.readFile(release.manifestPath, "utf8")), manifest)
  })
}

test("missing images fail before creating a delivery record or sending anything", async (t) => {
  const { release, manifest, options } = await prepareRelease(t)
  await fs.rm(path.join(release.directory, manifest.candidates[0].image))
  await assert.rejects(sendTelegramRelease(release, options), { code: "ENOENT" })
  assert.equal(options.client.sendRichMessage.mock.callCount(), 0)
  await assert.rejects(fs.access(options.directory), { code: "ENOENT" })
})

test("mismatched, synthetic and unsafe releases never reach the client", async (t) => {
  const { release, manifest, options } = await prepareRelease(t, 1)
  for (const invalid of [
    { ...manifest, schemaVersion: 1 },
    { ...manifest, source: "reports/different-report" },
    { ...manifest, demo: true },
    { ...manifest, richMessage: null },
    { ...manifest, candidates: null },
    { ...manifest, candidates: [{ ...manifest.candidates[0], image: "../private.png" }] },
    { ...manifest, candidates: [{ ...manifest.candidates[0], mediaId: "../../private" }] },
  ]) {
    await fs.writeFile(release.manifestPath, JSON.stringify(invalid))
    await assert.rejects(sendTelegramRelease(release, options), /Telegram|Synthetic/)
  }
  for (const reportId of [undefined, null, "", "../other", "a".repeat(81)]) {
    await assert.rejects(sendTelegramRelease(release, { ...options, reportId }), /report ID/)
  }
  assert.equal(options.client.sendRichMessage.mock.callCount(), 0)
  await assert.rejects(fs.access(options.directory), { code: "ENOENT" })
})

test("a new invocation sends even while a previous invocation is still pending", { timeout: 5_000 }, async (t) => {
  const { release, options, receiptPath } = await prepareRelease(t)
  let notify
  let finish
  const started = new Promise((resolve) => {
    notify = resolve
  })
  const pending = new Promise((resolve) => {
    finish = resolve
  })
  t.after(() => finish())
  let messageId = 77
  options.client.sendRichMessage = t.mock.fn(async () => {
    const id = messageId++
    if (id === 77) {
      notify()
      await pending
    }
    return { message_id: id }
  })
  const first = sendTelegramRelease(release, options)
  await started
  try {
    assert.deepEqual(await sendTelegramRelease(release, options), { status: "sent", messageId: 78, receiptPath })
    assert.equal(options.client.sendRichMessage.mock.callCount(), 2)
  } finally {
    finish()
    await first
  }
  assert.equal(JSON.parse(await fs.readFile(receiptPath, "utf8")).messageId, 77)
})

test("an ambiguous transport failure warns without automatically retrying or blocking a later run", async (t) => {
  const { release, options, receiptPath } = await prepareRelease(t)
  options.client.sendRichMessage = t.mock.fn(async () => {
    throw Object.assign(new Error("untrusted transport details"), { deliveryUnknown: true })
  })
  await assert.rejects(sendTelegramRelease(release, options), (error) => {
    assert.match(error.message, /delivery was not confirmed.*Check the chat.*another run will send a new post/)
    assert.doesNotMatch(error.message, /untrusted transport details/)
    return true
  })
  await assert.rejects(fs.access(receiptPath), { code: "ENOENT" })
  assert.equal(options.client.sendRichMessage.mock.callCount(), 1)
  options.client.sendRichMessage = t.mock.fn(async () => ({ message_id: 78 }))
  assert.deepEqual(await sendTelegramRelease(release, options), { status: "sent", messageId: 78, receiptPath })
  assert.equal(options.client.sendRichMessage.mock.callCount(), 1)
  await fs.access(release.manifestPath)
})

test("a definite rejection permits a later successful run", async (t) => {
  const { release, options, receiptPath } = await prepareRelease(t)
  const failure = Object.assign(new Error("Telegram rejected the rich message"), { deliveryUnknown: false })
  let calls = 0
  options.client.sendRichMessage = async () => {
    calls += 1
    if (calls === 1) {
      throw failure
    }
    return { message_id: 78 }
  }
  await assert.rejects(sendTelegramRelease(release, options), error => error === failure)
  await assert.rejects(fs.access(receiptPath), { code: "ENOENT" })
  assert.deepEqual(await sendTelegramRelease(release, options), { status: "sent", messageId: 78, receiptPath })
  assert.equal(calls, 2)
})

test("legacy delivery records never block sending and are replaced with the new confirmation", async (t) => {
  const { release, options, receiptPath } = await prepareRelease(t)
  await fs.mkdir(options.directory)
  const confirmed = { reportId: "saved-report", chatId: "-100123", status: "sent", messageId: 77 }
  let count = 0
  for (const raw of [
    "broken json", "null", "{}", JSON.stringify(confirmed),
    JSON.stringify({ ...confirmed, reportId: "another" }),
    JSON.stringify({ ...confirmed, chatId: "-100456" }),
    JSON.stringify({ ...confirmed, status: "sending" }),
    JSON.stringify({ ...confirmed, messageId: 0 }),
  ]) {
    await fs.writeFile(receiptPath, raw)
    const messageId = 77 + count++
    assert.deepEqual(await sendTelegramRelease(release, options), { status: "sent", messageId, receiptPath })
    const receipt = JSON.parse(await fs.readFile(receiptPath, "utf8"))
    assert.equal(receipt.reportId, options.reportId)
    assert.equal(receipt.chatId, options.client.chatId)
    assert.equal(receipt.status, "sent")
    assert.equal(receipt.messageId, messageId)
  }
  assert.equal(options.client.sendRichMessage.mock.callCount(), count)
})

for (const deliveryUnknown of [false, true]) {
  test(`a failed resend preserves the last confirmed delivery (unknown: ${deliveryUnknown})`, async (t) => {
    const { release, options, receiptPath } = await prepareRelease(t)
    await sendTelegramRelease(release, options)
    const previous = await fs.readFile(receiptPath, "utf8")
    options.client.sendRichMessage = t.mock.fn(async () => {
      throw Object.assign(new Error("Telegram request failed"), { deliveryUnknown })
    })
    await assert.rejects(sendTelegramRelease(release, options), /Telegram/)
    assert.equal(options.client.sendRichMessage.mock.callCount(), 1)
    assert.equal(await fs.readFile(receiptPath, "utf8"), previous)
  })
}

test("a real client stops automatic retries after a transport failure but allows a later invocation", async (t) => {
  const { release, options, receiptPath } = await prepareRelease(t)
  let calls = 0
  const sleep = t.mock.fn(async () => {})
  options.client = createTelegramClient({
    token: "123456:test-token", chatId: "-100123", sleep,
    request: async () => {
      calls += 1
      if (calls === 1) {
        return Response.json({ ok: false, error_code: 429, parameters: { retry_after: 1 } }, { status: 429 })
      }
      if (calls === 2) {
        throw new Error("untrusted transport details")
      }
      return Response.json({ ok: true, result: { message_id: 78 } })
    },
  })
  await assert.rejects(sendTelegramRelease(release, options), /delivery was not confirmed/)
  assert.equal(calls, 2)
  assert.equal(sleep.mock.callCount(), 1)
  await assert.rejects(fs.access(receiptPath), { code: "ENOENT" })
  assert.deepEqual(await sendTelegramRelease(release, options), { status: "sent", messageId: 78, receiptPath })
  assert.equal(calls, 3)
})

test("failure to record an acknowledged post warns without automatically resending or blocking a later invocation", async (t) => {
  const { release, options, receiptPath } = await prepareRelease(t)
  const writeFile = fs.writeFile.bind(fs)
  let failWrite = true
  t.mock.method(fs, "writeFile", async (filename, ...args) => {
    if (filename === receiptPath && failWrite) {
      failWrite = false
      throw new Error("Disk full")
    }
    return writeFile(filename, ...args)
  })
  await assert.rejects(sendTelegramRelease(release, options), /Telegram sent message 77.*could not be saved/)
  assert.equal(options.client.sendRichMessage.mock.callCount(), 1)
  await assert.rejects(fs.access(receiptPath), { code: "ENOENT" })
  assert.deepEqual(await sendTelegramRelease(release, options), { status: "sent", messageId: 78, receiptPath })
  assert.equal(options.client.sendRichMessage.mock.callCount(), 2)
})
