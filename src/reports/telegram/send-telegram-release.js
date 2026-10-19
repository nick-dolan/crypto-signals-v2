import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"

import { createTelegramClient } from "../../api/telegram-api.js"
import { reportStepError } from "../../helpers/step-error-helper.js"
import { isArray, isObject, isString } from "../../helpers/utils.typed.js"

async function updateChatPhoto (status, client, directory) {
  status = ["up", "down", "mixed"].includes(status) ? status : "unavailable"
  const photo = await fs.readFile(new URL(`./avatars/${status}.png`, import.meta.url))
  const photoHash = createHash("sha256").update(photo).digest("hex")
  const statePath = path.resolve(directory, "chat-photos", `${encodeURIComponent(client.chatId)}.json`)
  let previous
  try {
    previous = JSON.parse(await fs.readFile(statePath, "utf8"))
  } catch (error) {
    if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) {
      throw error
    }
  }
  if (previous?.chatId === client.chatId && previous?.status === status && previous?.photoHash === photoHash) {
    return
  }

  await fs.mkdir(path.dirname(statePath), { recursive: true })
  // An unconfirmed change may still replace the photo, so invalidate the old state first.
  await fs.rm(statePath, { force: true })
  await client.setChatPhoto(photo)
  await fs.writeFile(statePath, JSON.stringify({ chatId: client.chatId, status, photoHash }), "utf8")
}

export async function sendTelegramRelease (release, {
  reportId,
  client = createTelegramClient(),
  directory = "output/telegram-delivery",
  reportError = reportStepError,
} = {}) {
  if (!isString(reportId) || !/^[a-z\d_-]{1,80}$/i.test(reportId)) {
    throw new Error("Telegram delivery requires a valid step 13 report ID")
  }
  const manifest = JSON.parse(await fs.readFile(release.manifestPath, "utf8"))
  if (manifest?.schemaVersion !== 2 || manifest.source !== `reports/${reportId}`
    || !isObject(manifest.richMessage) || !isArray(manifest.candidates)) {
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
  const startedAt = new Date().toISOString()
  try {
    await updateChatPhoto(manifest.altMarketStatus, client, directory)
  } catch (error) {
    await reportError(error, { step: "step14-telegram.js", operation: "set_chat_photo", source: manifest.source })
  }

  let message
  try {
    message = await client.sendRichMessage(manifest.richMessage, files)
  } catch (error) {
    if (error.deliveryUnknown === false) {
      throw error
    }
    throw new Error("Telegram delivery was not confirmed. Check the chat before retrying: another run will send a new post.", { cause: error })
  }
  try {
    await fs.writeFile(receiptPath, JSON.stringify({
      reportId, chatId: client.chatId, status: "sent", messageId: message.message_id,
      releaseDirectory: path.dirname(release.manifestPath), startedAt, sentAt: new Date().toISOString(),
    }, null, 2), "utf8")
  } catch (error) {
    throw new Error(`Telegram sent message ${message.message_id}, but its delivery record could not be saved. Check ${receiptPath}; do not resend blindly.`, { cause: error })
  }
  return { status: "sent", messageId: message.message_id, receiptPath }
}
