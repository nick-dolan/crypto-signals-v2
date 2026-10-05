import { isString } from "../../helpers/utils.typed.js"

export function telegramText (value, limit = 1_000) {
  const plain = isString(value) ? value.replace(/\s+/gu, " ").replace(/\p{Cc}/gu, "").trim() : ""
  let text = ""
  // Budget encoded characters, so limits remain safe even for markup-like input.
  for (const character of plain) {
    const escaped = ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;" })[character] ?? character
    if (text.length + escaped.length > limit - 1) {
      return `${text}…`
    }
    text += escaped
  }
  return text
}

export function telegramLink (label, value) {
  if (!isString(value)) {
    return null
  }
  let url
  try {
    url = new URL(value)
  } catch {
    return null
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    return null
  }
  const href = telegramText(url.href, 602)
  if (href.endsWith("…") || href.length > 600) {
    return null
  }
  return `<a href="${href}">${telegramText(label, 100)}</a>`
}

export function signalText (signal) {
  if (!isString(signal)) {
    return ""
  }
  // Evidence can contain JSON with colons inside quoted values, as in the web report.
  const separator = [...signal.matchAll(/"(?:\\.|[^"\\])*"|: /g)].find(([match]) => match === ": ")?.index ?? -1
  return separator > 0 && signal.slice(0, separator).includes("=") ? signal.slice(separator + 2) : signal
}

export function telegramRichMessage (html, media) {
  // Only trusted builder HTML: decode text once, excluding tags and link attributes.
  const text = html.replace(/<[^>]*>/gu, "")
    .replace(/&(amp|lt|gt|quot);/gu, (_, name) => ({ amp: "&", lt: "<", gt: ">", quot: "\"" })[name])
  const length = [...text].length
  if (length > 32_768) {
    throw new Error(`Текст rich-поста Telegram превышает лимит 32768 символов: ${length}`)
  }
  return { html, media }
}

export function reportTitleTime (value) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("ru-RU", {
    timeZone: "Europe/Moscow", day: "numeric", month: "long", year: "numeric",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date(value)).map(({ type, value }) => [type, value]))
  return `${parts.day} ${parts.month} ${parts.year}, ${parts.hour}:${parts.minute}`
}

export function reportTime (value) {
  return new Intl.DateTimeFormat("ru-RU", {
    timeZone: "Europe/Moscow", day: "2-digit", month: "2-digit", year: "numeric",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).format(new Date(value))
}
