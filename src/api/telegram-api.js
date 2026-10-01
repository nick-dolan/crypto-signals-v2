import "dotenv/config"
import { setTimeout as delay } from "node:timers/promises"
import { isArray, isFinite, isFunction, isObject, isSafeInteger, isString } from "../helpers/utils.typed.js"

function telegramError (message, deliveryUnknown) {
  return Object.assign(new Error(message), { deliveryUnknown })
}

function messageForm (chatId, richMessage, files) {
  try {
    if (!isObject(richMessage) || !isString(richMessage.html) || !richMessage.html.trim()
      || (richMessage.media !== undefined && !isArray(richMessage.media)) || !isArray(files)) {
      throw new Error()
    }

    const media = richMessage.media ?? []
    if (!media.every(item => isObject(item) && isString(item.id) && /^[a-z\d_-]{1,64}$/iu.test(item.id)
      && !["chat_id", "rich_message"].includes(item.id) && isObject(item.media)
      && item.media.type === "photo" && item.media.media === `attach://${item.id}`)) {
      throw new Error()
    }

    const names = new Set(media.map(item => item.id))
    if (names.size !== media.length || files.length !== media.length
      || !files.every(file => isObject(file) && names.has(file.name)
        && isString(file.fileName) && file.fileName.trim() && Buffer.isBuffer(file.data) && file.data.length > 0)
      || new Set(files.map(file => file.name)).size !== files.length) {
      throw new Error()
    }

    const form = new FormData()
    form.append("chat_id", chatId)
    form.append("rich_message", JSON.stringify({
      html: richMessage.html,
      media: media.map(({ id }) => ({ id, media: { type: "photo", media: `attach://${id}` } })),
    }))
    files.forEach(({ name, fileName, data }) => form.append(name, new Blob([data], { type: "image/png" }), fileName))
    return form
  } catch {
    throw telegramError("Telegram rich message and PNG attachments are invalid", false)
  }
}

async function postRichMessage (url, body, request, timeoutMs) {
  const controller = new AbortController()
  let deliveryUnknown = true
  let timeoutId
  const timeout = new Promise((resolve, reject) => {
    timeoutId = setTimeout(() => {
      controller.abort()
      reject(telegramError("Telegram request timed out", deliveryUnknown))
    }, timeoutMs)
  })

  async function readResponse () {
    let response
    let status
    try {
      response = await request(url, { method: "POST", body, redirect: "manual", signal: controller.signal })
      status = response.status
    } catch {
      throw telegramError("Telegram transport failure", true)
    }

    if (!isSafeInteger(status) || status < 200 || status > 599) {
      throw telegramError("Telegram invalid response", true)
    }
    if (status >= 500) {
      throw telegramError("Telegram server error", true)
    }
    if (status >= 300 && status < 400) {
      throw telegramError("Telegram redirects are not allowed", false)
    }

    deliveryUnknown = status < 400
    let payload
    try {
      payload = JSON.parse(await response.text())
    } catch {
      if (controller.signal.aborted) {
        throw telegramError("Telegram request timed out", deliveryUnknown)
      }
      if (status === 429) {
        throw telegramError("Telegram rate limit exceeded", false)
      }
      if (status >= 400) {
        throw telegramError(`Telegram HTTP rejection: ${status}`, false)
      }
      throw telegramError("Telegram invalid response body", true)
    }

    if (payload?.ok === false && isSafeInteger(payload.error_code) && payload.error_code >= 500 && payload.error_code <= 599) {
      throw telegramError("Telegram server error", true)
    }
    if (status === 429 || (payload?.ok === false && payload.error_code === 429)) {
      return { retryAfter: payload?.ok === false ? payload.parameters?.retry_after : undefined }
    }
    if (status >= 400) {
      throw telegramError(`Telegram HTTP rejection: ${status}`, false)
    }
    if (payload?.ok === false) {
      throw telegramError("Telegram rejected the rich message", false)
    }
    if (payload?.ok !== true || !isObject(payload.result)
      || !isSafeInteger(payload.result.message_id) || payload.result.message_id <= 0) {
      throw telegramError("Telegram malformed success response", true)
    }
    return { result: payload.result }
  }

  try {
    return await Promise.race([readResponse(), timeout])
  } finally {
    clearTimeout(timeoutId)
  }
}

export function createTelegramClient ({
  token = process.env.TELEGRAM_BOT_TOKEN,
  chatId = process.env.TELEGRAM_CHAT_ID,
  request = globalThis.fetch,
  timeoutMs = 60_000,
  sleep = delay,
} = {}) {
  if (!isString(token) || !/^\d+:[a-z\d_-]+$/iu.test(token.trim())) {
    throw telegramError("Telegram bot token is required and must have a valid format", false)
  }
  if ((!isString(chatId) || !chatId.trim()) && !isSafeInteger(chatId)) {
    throw telegramError("Telegram chatId must be a nonempty string or safe integer", false)
  }
  if (!isFinite(timeoutMs) || timeoutMs <= 0) {
    throw telegramError("Telegram timeoutMs must be a positive finite number", false)
  }
  if (!isFunction(request) || !isFunction(sleep)) {
    throw telegramError("Telegram request and sleep must be functions", false)
  }

  const normalizedChatId = String(chatId).trim()
  const url = `https://api.telegram.org/bot${token.trim()}/sendRichMessage`

  return {
    chatId: normalizedChatId,
    async sendRichMessage (richMessage, files = []) {
      const body = messageForm(normalizedChatId, richMessage, files)
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const { result, retryAfter } = await postRichMessage(url, body, request, timeoutMs)
        if (result) {
          return result
        }
        if (attempt > 0) {
          throw telegramError("Telegram rate limit exceeded after one retry", false)
        }
        if (!isSafeInteger(retryAfter) || retryAfter <= 0 || retryAfter > 60) {
          throw telegramError("Telegram rate limit exceeded; retry_after must be 1–60 seconds", false)
        }
        try {
          await sleep(retryAfter * 1_000)
        } catch {
          throw telegramError("Telegram rate-limit wait failed", false)
        }
      }
    },
  }
}
