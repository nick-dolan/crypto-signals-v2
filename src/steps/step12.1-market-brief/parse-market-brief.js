import { isArray, isObject, isString } from "../../helpers/utils.typed.js"

export class InvalidMarketBriefError extends Error {
  constructor (message) {
    super(`Invalid market brief: ${message}`)
    this.name = "InvalidMarketBriefError"
  }
}

function requireKeys (value, keys) {
  if (!isObject(value) || Object.keys(value).length !== keys.length || !keys.every(key => Object.hasOwn(value, key))) {
    throw new InvalidMarketBriefError("unexpected response structure")
  }
}

function readText (value, limit, field) {
  if (!isString(value) || !value.trim() || value.length > limit) {
    throw new InvalidMarketBriefError(`${field} must be nonempty text of at most ${limit} characters`)
  }
  return value.trim()
}

export function validateBriefEvents (events, sources) {
  if (!isArray(events) || events.length > 5) {
    throw new InvalidMarketBriefError("events must contain at most five items")
  }
  const sourceIds = new Set(sources.map(source => source.id))
  const titles = new Set()

  return events.map((event) => {
    requireKeys(event, ["title", "summary", "whyItMatters", "verification", "sourceIds"])
    const title = readText(event.title, 160, "title")
    if (titles.has(title.toLowerCase())) {
      throw new InvalidMarketBriefError("duplicate event title")
    }
    titles.add(title.toLowerCase())
    if (!["reported", "unconfirmed"].includes(event.verification)) {
      throw new InvalidMarketBriefError("verification must be reported or unconfirmed")
    }
    if (
      !isArray(event.sourceIds) || !event.sourceIds.length
      || new Set(event.sourceIds).size !== event.sourceIds.length
      || event.sourceIds.some(id => !sourceIds.has(id))
    ) {
      throw new InvalidMarketBriefError("every event must cite unique IDs of collected sources")
    }
    return {
      title,
      summary: readText(event.summary, 600, "summary"),
      whyItMatters: readText(event.whyItMatters, 300, "whyItMatters"),
      verification: event.verification,
      sourceIds: [...event.sourceIds],
    }
  })
}

export function parseMarketBrief (content, asOf, sources) {
  if (!isString(content) || !content.trim()) {
    throw new InvalidMarketBriefError("response must be a nonempty string")
  }
  let response
  try {
    response = JSON.parse(content.trim().replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/i, "$1"))
  } catch {
    throw new InvalidMarketBriefError("response is not valid JSON")
  }
  requireKeys(response, ["schemaVersion", "asOf", "events"])
  if (response.schemaVersion !== 1 || response.asOf !== asOf) {
    throw new InvalidMarketBriefError("response version or news cutoff does not match the request")
  }
  return validateBriefEvents(response.events, sources)
}
