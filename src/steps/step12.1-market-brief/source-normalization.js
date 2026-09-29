import { isIP } from "node:net"
import { isArray, isFinite, isObject, isString } from "../../helpers/utils.typed.js"

export function sourceString (value) {
  return isString(value) ? value.replace(/\r\n?/g, "\n").trim() : ""
}

export function sourceAuthor (value) {
  if (isArray(value)) {
    return [...new Set(value.map(sourceAuthor).filter(Boolean))].join(", ") || null
  }

  if (isObject(value)) {
    return sourceString(value.name) || sourceString(value.userName) || null
  }

  return sourceString(value) || null
}

export function normalizeSourceUrl (value) {
  if (!isString(value) || /\p{Cc}/u.test(value)) {
    return null
  }

  try {
    const url = new URL(value.trim())
    const hostname = url.hostname.replace(/\.+$/, "")

    if (
      !["http:", "https:"].includes(url.protocol)
      || url.username
      || url.password
      || !hostname.includes(".")
      || [".localhost", ".local", ".internal"].some(suffix => hostname.endsWith(suffix))
      || isIP(hostname.replace(/^\[|\]$/g, ""))
    ) {
      return null
    }

    url.hostname = hostname
    return url.href
  } catch {
    return null
  }
}

export function sourceUrlKey (value) {
  const normalized = normalizeSourceUrl(value)

  if (!normalized) {
    return null
  }

  const url = new URL(normalized)
  url.hash = ""

  for (const key of [...url.searchParams.keys()]) {
    if (/^(?:utm_.+|fbclid|gclid|dclid|msclkid|mc_cid|mc_eid)$/i.test(key)) {
      url.searchParams.delete(key)
    }
  }

  // Keep path case, protocol, meaningful parameters and repeated-value order intact.
  url.searchParams.sort()
  return url.href
}

export function sourcePublishedAt (value) {
  let milliseconds

  if (isFinite(value)) {
    milliseconds = value * 1_000
  } else {
    const text = sourceString(value)

    // A calendar date or a timezone-less time cannot establish membership in a rolling 24h window.
    if (
      !/\d{2}:\d{2}/.test(text)
      || !/(?:Z$|\b(?:GMT|UTC)\b|[+-]\d{2}:?\d{2}(?:$|\s))/.test(text)
    ) {
      return null
    }

    const calendarDate = text.match(/^(\d{4}-\d{2}-\d{2})(?:T|\s)/)?.[1]

    if (calendarDate) {
      const midnight = Date.parse(`${calendarDate}T00:00:00Z`)

      if (!isFinite(midnight) || new Date(midnight).toISOString().slice(0, 10) !== calendarDate) {
        return null
      }
    }

    milliseconds = Date.parse(text)
  }

  return isFinite(milliseconds) && isFinite(new Date(milliseconds).getTime())
    ? new Date(milliseconds).toISOString()
    : null
}
