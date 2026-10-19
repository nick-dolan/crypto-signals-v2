import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import { buildTelegramRelease } from "../src/reports/telegram/build-telegram-release.js"
import { sendTelegramRelease } from "../src/reports/telegram/send-telegram-release.js"

async function createDelivery (t) {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), "telegram-release-"))
  t.after(() => fs.rm(folder, { recursive: true, force: true }))
  const manifestPath = path.join(folder, "release.json")
  const directory = path.join(folder, "delivery")
  const calls = []
  const client = {
    chatId: "-1001234567890",
    setChatPhoto: t.mock.fn(async () => {
      calls.push("photo")
      return true
    }),
    sendRichMessage: t.mock.fn(async () => {
      calls.push("message")
      return { message_id: 42 }
    }),
  }
  const reportError = t.mock.fn(async () => {})
  const send = async (status, overrides = {}) => {
    await fs.writeFile(manifestPath, JSON.stringify({
      schemaVersion: 2, source: "reports/test-report", candidates: [],
      richMessage: { html: "<p>Report</p>" }, altMarketStatus: status, ...overrides,
    }), "utf8")
    return sendTelegramRelease({ manifestPath }, { reportId: "test-report", client, directory, reportError })
  }
  return { client, calls, reportError, send, directory }
}

function avatar (status) {
  return fs.readFile(new URL(`../src/reports/telegram/avatars/${status}.png`, import.meta.url))
}

test("Telegram release preserves the web report's saved market status without recalculating it", () => {
  const report = { timeframe: "1h", asOf: "2026-10-19T11:00:00.000Z", coins: [] }
  for (const status of ["up", "down", "mixed", "unavailable"]) {
    const release = buildTelegramRelease({
      ...report, altMarketBackground: { status, change6hPct: -10, breadth6h: 0.1 },
      marketContext: { altMarketBackground: { status: "up" } },
    })
    assert.equal(release.altMarketStatus, status)
  }
  assert.equal(buildTelegramRelease({
    ...report, altMarketBackground: null, marketContext: { altMarketBackground: { status: "down" } },
  }).altMarketStatus, "down")
  assert.equal(buildTelegramRelease(report).altMarketStatus, "unavailable")
  assert.equal(buildTelegramRelease({
    ...report, altMarketBackground: { status: "unknown" }, marketContext: { altMarketBackground: { status: "up" } },
  }).altMarketStatus, "unavailable")
})

test("each approved PNG is set before posting and unchanged market status does not upload again", async (t) => {
  const { client, calls, reportError, send, directory } = await createDelivery(t)
  for (const status of ["up", "down", "mixed", "unavailable"]) {
    const result = await send(status)
    assert.equal(result.status, "sent")
    assert.deepEqual(calls.splice(0), ["photo", "message"])
    assert.deepEqual(client.setChatPhoto.mock.calls.at(-1).arguments[0], await avatar(status))
    const state = JSON.parse(await fs.readFile(path.join(directory, "chat-photos", "-1001234567890.json"), "utf8"))
    assert.equal(state.status, status)
    assert.equal(state.chatId, client.chatId)
    await send(status)
    assert.deepEqual(calls.splice(0), ["message"])
  }
  assert.equal(reportError.mock.callCount(), 0)
})

test("photo state is isolated per channel", async (t) => {
  const { client, calls, send } = await createDelivery(t)
  await send("up")
  client.chatId = "@another_channel"
  await send("up")
  client.chatId = "-1001234567890"
  await send("up")
  assert.deepEqual(calls, ["photo", "message", "photo", "message", "message"])
})

test("missing or unsafe status uses no-data photo and corrupt cached state is not trusted", async (t) => {
  const { client, calls, reportError, send, directory } = await createDelivery(t)
  await send(undefined)
  assert.deepEqual(client.setChatPhoto.mock.calls[0].arguments[0], await avatar("unavailable"))
  await send("../../up")
  assert.deepEqual(calls.splice(0), ["photo", "message", "message"])
  await fs.writeFile(path.join(directory, "chat-photos", "-1001234567890.json"), "{broken", "utf8")
  await send(undefined)
  assert.deepEqual(calls, ["photo", "message"])
  assert.equal(reportError.mock.callCount(), 0)
})

test("an unconfirmed photo change does not block posting or leave a stale cache for the previous status", async (t) => {
  const { client, calls, reportError, send } = await createDelivery(t)
  const failure = Object.assign(new Error("Photo request timed out"), { deliveryUnknown: true })
  let fail = false
  let photo
  t.mock.method(client, "setChatPhoto", async (data) => {
    calls.push("photo")
    photo = data
    if (fail) {
      throw failure
    }
    return true
  })
  await send("up")
  fail = true
  assert.equal((await send("down")).status, "sent")
  fail = false
  await send("up")
  assert.deepEqual(calls, ["photo", "message", "photo", "message", "photo", "message"])
  assert.deepEqual(photo, await avatar("up"))
  assert.equal(reportError.mock.callCount(), 1)
  assert.equal(reportError.mock.calls[0].arguments[0], failure)
  assert.deepEqual(reportError.mock.calls[0].arguments[1], {
    step: "step14-telegram.js", operation: "set_chat_photo", source: "reports/test-report",
  })
})

test("failed photo-state persistence is reported without blocking posts or trusting the missing state", async (t) => {
  const { client, reportError, send } = await createDelivery(t)
  const writeFile = fs.writeFile
  const failure = Object.assign(new Error("Disk is full"), { code: "ENOSPC" })
  t.mock.method(fs, "writeFile", async (file, ...args) => {
    if (path.basename(path.dirname(file)) === "chat-photos") {
      throw failure
    }
    return writeFile(file, ...args)
  })
  await send("up")
  await send("up")
  assert.equal(client.setChatPhoto.mock.callCount(), 2)
  assert.equal(client.sendRichMessage.mock.callCount(), 2)
  assert.equal(reportError.mock.callCount(), 2)
  assert.equal(reportError.mock.calls[0].arguments[0], failure)
})

test("synthetic and mismatched releases cannot change the photo or publish a message", async (t) => {
  const { client, reportError, send } = await createDelivery(t)
  await assert.rejects(send("up", { demo: true }), /Synthetic Telegram/)
  await assert.rejects(send("up", { source: "reports/another-report" }), /does not match/)
  assert.equal(client.setChatPhoto.mock.callCount(), 0)
  assert.equal(client.sendRichMessage.mock.callCount(), 0)
  assert.equal(reportError.mock.callCount(), 0)
})
