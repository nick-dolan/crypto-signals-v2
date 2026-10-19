import "dotenv/config"
import { setTimeout as delay } from "node:timers/promises"
import { isArray, isFinite, isFunction, isObject, isSafeInteger, isString } from "../helpers/utils.typed.js"

function telegramError (message, deliveryUnknown, details = {}) {
  return Object.assign(new Error(message), { deliveryUnknown, ...details })
}

function isMessageResult (result) {
  return isObject(result) && isSafeInteger(result.message_id) && result.message_id > 0
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

async function postRequest (url, body, request, timeoutMs, validateResult) {
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
    } catch (error) {
      throw telegramError("Telegram transport failure", true, { cause: error })
    }

    if (!isSafeInteger(status) || status < 200 || status > 599) {
      throw telegramError("Telegram invalid response", true)
    }
    if (status >= 500) {
      throw telegramError(`Telegram server error: HTTP ${status}`, true, { status })
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
      throw telegramError(`Telegram server error: ${payload.description || payload.error_code}`, true, { status, code: payload.error_code })
    }
    if (status === 429 || (payload?.ok === false && payload.error_code === 429)) {
      return { retryAfter: payload?.ok === false ? payload.parameters?.retry_after : undefined }
    }
    if (status >= 400 || payload?.ok === false) {
      const detail = isString(payload?.description) ? `: ${payload.description}` : ""
      throw telegramError(`Telegram HTTP rejection: ${status}${detail}`, false, { status, code: payload?.error_code })
    }
    if (payload?.ok !== true || !validateResult(payload.result)) {
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
  const url = `https://api.telegram.org/bot${token.trim()}`

  async function send (method, body, validateResult = isMessageResult) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const { result, retryAfter } = await postRequest(`${url}/${method}`, body, request, timeoutMs, validateResult)
      if (result) {
        return result
      }
      if (attempt > 0) {
        throw telegramError("Telegram rate limit exceeded after one retry", false)
      }
      if (!isSafeInteger(retryAfter) || retryAfter <= 0 || retryAfter > Math.min(60, timeoutMs / 1_000)) {
        throw telegramError("Telegram rate limit exceeded; retry_after exceeds the request time limit", false)
      }
      try {
        await sleep(retryAfter * 1_000)
      } catch (error) {
        throw telegramError("Telegram rate-limit wait failed", false, { cause: error })
      }
    }
  }

  return {
    chatId: normalizedChatId,
    async setChatPhoto (photo) {
      if (!Buffer.isBuffer(photo) || photo.length === 0) {
        throw telegramError("Telegram chat photo must be a nonempty PNG Buffer", false)
      }
      const form = new FormData()
      form.append("chat_id", normalizedChatId)
      form.append("photo", new Blob([photo], { type: "image/png" }), "chat-photo.png")
      return send("setChatPhoto", form, result => result === true)
    },
    async sendRichMessage (richMessage, files = []) {
      return send("sendRichMessage", messageForm(normalizedChatId, richMessage, files))
    },
    async sendMessage (text) {
      if (!isString(text) || !text.trim() || text.length > 4_096) {
        throw telegramError("Telegram message must contain 1–4096 characters", false)
      }
      return send("sendMessage", new URLSearchParams({
        chat_id: normalizedChatId,
        text,
        link_preview_options: JSON.stringify({ is_disabled: true }),
      }))
    },
  }
}
