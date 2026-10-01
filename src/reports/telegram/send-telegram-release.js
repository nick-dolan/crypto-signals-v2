import fs from "node:fs/promises"
import path from "node:path"

import { createTelegramClient } from "../../api/telegram-api.js"
import { isArray, isObject, isSafeInteger, isString } from "../../helpers/utils.typed.js"

async function existingDelivery (receiptPath, reportId, chatId) {
  let saved
  try {
    saved = JSON.parse(await fs.readFile(receiptPath, "utf8"))
  } catch {
    throw new Error(`Cannot read Telegram delivery record ${receiptPath}. Check the chat before changing this record.`)
  }
  if (saved?.reportId !== reportId || saved.chatId !== chatId) {
    throw new Error(`Telegram delivery record ${receiptPath} belongs to another report or chat. Nothing was sent.`)
  }
  if (saved.status !== "sent" || !isSafeInteger(saved.messageId) || saved.messageId <= 0) {
    throw new Error(`Telegram delivery is pending or uncertain. Check the chat and ${receiptPath} before retrying; automatic resend is blocked.`)
  }
  return { status: "already_sent", messageId: saved.messageId, receiptPath }
}

export async function sendTelegramRelease (release, {
  reportId,
  client = createTelegramClient(),
  directory = "output/telegram-delivery",
} = {}) {
  if (!isString(reportId) || !/^[a-z\d_-]{1,80}$/i.test(reportId)) {
    throw new Error("Telegram delivery requires a valid step 13 report ID")
  }
  const manifest = JSON.parse(await fs.readFile(release.manifestPath, "utf8"))
  if (manifest?.schemaVersion !== 2 || manifest.source !== `reports/${reportId}`
    || !isObject(manifest.richMessage) || !isArray(manifest.candidates) || manifest.candidates.length > 10) {
    throw new Error("Telegram release does not match the saved step 13 report")
  }
  if (manifest.demo === true) {
    throw new Error("Synthetic Telegram reports cannot be sent")
  }
  const files = await Promise.all(manifest.candidates.map(async (item) => {
    if (!isString(item?.image) || !/^cards\/\d{2}-[a-z\d_-]{1,40}\.png$/i.test(item.image)
      || !isString(item.mediaId) || !/^card_\d+$/.test(item.mediaId)) {
      throw new Error("Telegram release contains an invalid local card")
    }
    return {
      name: item.mediaId,
      fileName: path.basename(item.image),
      data: await fs.readFile(path.join(path.dirname(release.manifestPath), item.image)),
    }
  }))

  await fs.mkdir(directory, { recursive: true })
  const receiptPath = path.resolve(directory, `${reportId}.json`)
  let handle
  try {
    // The exclusive claim also blocks concurrent runs and retries after an ambiguous timeout.
    handle = await fs.open(receiptPath, "wx")
  } catch (error) {
    if (error.code === "EEXIST") {
      return existingDelivery(receiptPath, reportId, client.chatId)
    }
    throw error
  }
  const receipt = {
    reportId, chatId: client.chatId, status: "sending",
    releaseDirectory: path.dirname(release.manifestPath), startedAt: new Date().toISOString(),
  }
  try {
    await handle.writeFile(JSON.stringify(receipt, null, 2), "utf8")
    await handle.sync()
  } finally {
    await handle.close()
  }
  // Persist the directory entry too, so a host crash cannot discard the pre-send claim.
  const folder = await fs.open(directory, "r")
  try {
    await folder.sync()
  } finally {
    await folder.close()
  }

  let message
  try {
    message = await client.sendRichMessage(manifest.richMessage, files)
  } catch (error) {
    if (error.deliveryUnknown === false) {
      await fs.rm(receiptPath)
      throw error
    }
    throw new Error(`Telegram delivery was not confirmed. Automatic resend is blocked; check the chat and ${receiptPath}.`, { cause: error })
  }
  try {
    await fs.writeFile(receiptPath, JSON.stringify({
      ...receipt, status: "sent", messageId: message.message_id, sentAt: new Date().toISOString(),
    }, null, 2), "utf8")
  } catch {
    throw new Error(`Telegram sent message ${message.message_id}, but its delivery record could not be saved. Check ${receiptPath}; do not resend blindly.`)
  }
  return { status: "sent", messageId: message.message_id, receiptPath }
}
