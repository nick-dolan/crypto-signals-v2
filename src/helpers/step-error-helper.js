import { setTimeout as delay } from "node:timers/promises"

import { createTelegramClient } from "../api/telegram-api.js"
import { redactSecrets } from "./error-helper.js"
import { isArray, isError, isFinite, isObject, isString } from "./utils.typed.js"

function errorChain (error) {
  const chain = []
  const seen = new Set()
  let current = error ?? new Error(String(error))
  while (current != null && !seen.has(current) && chain.length < 6) {
    seen.add(current)
    chain.push(current)
    current = current.cause
  }
  return chain
}

function errorKind (chain, context) {
  const description = `${context.code} ${context.type} ${chain.map(error => `${error.name} ${error.code} ${error.message}`).join(" ")}`
  const status = context.status ?? chain.find(error => error.status ?? error.statusCode)?.status
    ?? chain.find(error => error.statusCode)?.statusCode
  if (/TimeoutError|ETIMEDOUT|UND_ERR_\w*TIMEOUT|timed?\s*out|timeout/iu.test(description)) {
    return "Таймаут"
  }
  if (context.signal) {
    return `Завершение по сигналу ${context.signal}`
  }
  if (status === 429) {
    return "Лимит запросов (HTTP 429)"
  }
  if ([401, 403].includes(status)) {
    return `Ошибка авторизации или доступа (HTTP ${status})`
  }
  if (status >= 400) {
    return `Ошибка HTTP ${status}`
  }
  if (/ECONN|ENOTFOUND|EAI_AGAIN|EPIPE|UND_ERR_|fetch failed|socket/iu.test(description)) {
    return "Сетевая ошибка"
  }
  if (/SyntaxError|Invalid\w*Error/iu.test(description)) {
    return "Некорректные данные или ответ"
  }
  return context.provider ? "Ошибка агента" : "Ошибка выполнения"
}

export function formatStepError (error, context = {}, env = process.env) {
  const chain = errorChain(error)
  const details = Object.assign({}, ...chain.toReversed().map(item => item.context), context, error?.context)
  const value = text => redactSecrets(text, env).slice(0, 300)
  const lines = [
    `❌ Сбой: ${value(details.step || env.PIPELINE_STEP || "pipeline")}`,
    `Тип: ${errorKind(chain, details)}`,
    `Время: ${new Date().toISOString()}`,
  ]
  for (const [key, label] of [
    ["operation", "Операция"], ["symbol", "Монета"], ["source", "Источник"],
    ["provider", "Провайдер"], ["model", "Модель"], ["code", "Код"], ["type", "Тип провайдера"],
    ["exitCode", "Код завершения"],
  ]) {
    const field = details[key] ?? error?.[key]
    if (field != null && field !== "") {
      lines.push(`${label}: ${value(field)}`)
    }
  }
  if (isFinite(details.timeoutMs)) {
    lines.push(`Лимит ожидания: ${details.timeoutMs / 1_000} с`)
  }
  if (isFinite(details.elapsedMs)) {
    lines.push(`Длительность операции: ${(details.elapsedMs / 1_000).toFixed(1)} с`)
  }
  if (/^\d+$/u.test(env.PIPELINE_STARTED_AT || "")) {
    const startedAt = new Date(Number(env.PIPELINE_STARTED_AT) * 1_000)
    if (isFinite(startedAt.getTime())) {
      lines.push(`Запуск: ${startedAt.toISOString()}`)
    }
  }
  chain.forEach((item, index) => {
    const name = isString(item.name) ? `${item.name}: ` : ""
    const codes = [item.code, item.status ?? item.statusCode].filter(value => value != null).join(", ")
    const message = redactSecrets(item.message ?? String(item), env).slice(0, 800)
    lines.push(`${index === 0 ? "Ошибка" : "Причина"}: ${name}${message}${codes ? ` [${value(codes)}]` : ""}`)
  })
  if (isString(details.stderr) && details.stderr.trim()) {
    lines.push(`stderr:\n${redactSecrets(details.stderr, env).slice(-1_800)}`)
  }
  if (isArray(error?.cleanupErrors) && error.cleanupErrors.length) {
    lines.push(`Ошибка очистки: ${value(error.cleanupErrors[0]?.message ?? error.cleanupErrors[0])}`)
  }
  return redactSecrets(lines.join("\n"), env).slice(0, 3_900)
}

let deliveryQueue = Promise.resolve()
let lastDeliveryAt = 0
let deliveryUnavailableUntil = 0

export function sendErrorNotification (text, {
  env = process.env,
  createClient = createTelegramClient,
  sleep = delay,
  now = Date.now,
  log = console.error,
} = {}) {
  const deliver = async () => {
    const message = redactSecrets(text, env).slice(0, 3_900)
    try {
      if (!env.TELEGRAM_ERRORS_BOT_TOKEN || !env.TELEGRAM_MY_ID) {
        log(`⚠ Error notification not sent: TELEGRAM_ERRORS_BOT_TOKEN and TELEGRAM_MY_ID are required\n${message}`)
        return false
      }
      if (now() < deliveryUnavailableUntil) {
        log(`⚠ Error notification not sent: Telegram delivery paused after a failure; error retained in the log\n${message}`)
        return false
      }
      await sleep(Math.max(0, 1_000 - (now() - lastDeliveryAt)))
      lastDeliveryAt = now()
      const client = createClient({ token: env.TELEGRAM_ERRORS_BOT_TOKEN, chatId: env.TELEGRAM_MY_ID, timeoutMs: 10_000 })
      await client.sendMessage(message)
      return true
    } catch (error) {
      // One Telegram outage must not add a request timeout for every failed coin.
      deliveryUnavailableUntil = now() + 60_000
      log(`⚠ Error notification not sent: ${redactSecrets(error?.message ?? String(error), env)}\n${message}`)
      return false
    }
  }
  const sent = deliveryQueue.then(deliver)
  deliveryQueue = sent.catch(() => false)
  return sent
}

export async function sendStepMessage (message, send = process.connected ? process.send?.bind(process) : undefined) {
  if (!send) {
    return false
  }
  let timeout
  try {
    return await new Promise((resolve) => {
      timeout = setTimeout(() => resolve(false), 2_000)
      send(message, error => resolve(!error))
    })
  } catch {
    return false
  } finally {
    clearTimeout(timeout)
  }
}

const reportedErrors = new WeakMap()

export function reportStepError (error, context = {}, {
  notify = sendErrorNotification,
  send = process.connected ? process.send?.bind(process) : undefined,
  env = process.env,
} = {}) {
  if ((isError(error) || isObject(error)) && reportedErrors.has(error)) {
    return reportedErrors.get(error)
  }
  const task = (async () => {
    try {
      const report = {
        type: "step-error",
        text: formatStepError(error, context, env),
        message: redactSecrets(error?.message ?? String(error), env).slice(0, 1_000),
        fatal: context.fatal === true,
      }
      if (await sendStepMessage(report, send)) {
        return true
      }
      return await notify(report.text)
    } catch (failure) {
      console.error(`⚠ Could not report step error: ${redactSecrets(failure?.message ?? String(failure), env)}`)
      return false
    }
  })()
  if (isError(error) || isObject(error)) {
    reportedErrors.set(error, task)
  }
  return task
}
