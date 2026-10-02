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

function readSourceIds (ids, sourceIds) {
  if (
    !isArray(ids) || !ids.length
    || new Set(ids).size !== ids.length
    || ids.some(id => !sourceIds.has(id))
  ) {
    throw new InvalidMarketBriefError("every item, paragraph or event must cite unique IDs of collected sources")
  }
  return [...ids]
}

export function validateBriefItems (items, sources) {
  if (!isArray(items) || items.length > 5) {
    throw new InvalidMarketBriefError("items must contain at most five news items")
  }
  const sourceIds = new Set(sources.map(source => source.id))
  const result = items.map((item) => {
    requireKeys(item, ["text", "sourceIds"])
    const ids = readSourceIds(item.sourceIds, sourceIds)
    if (ids.length > 2) {
      throw new InvalidMarketBriefError("each news item must cite at most two sources")
    }
    return {
      text: readText(item.text, 250, "item text"),
      sourceIds: ids,
    }
  })
  if (new Set(result.map(item => item.text.toLowerCase())).size !== result.length) {
    throw new InvalidMarketBriefError("duplicate item text")
  }
  return result
}

// Archived v2 briefs retain their original paragraph structure and limits.
export function validateBriefParagraphs (paragraphs, sources) {
  if (!isArray(paragraphs) || paragraphs.length > 2) {
    throw new InvalidMarketBriefError("paragraphs must contain at most two items")
  }
  const sourceIds = new Set(sources.map(source => source.id))
  const result = paragraphs.map((paragraph) => {
    requireKeys(paragraph, ["text", "sourceIds"])
    return {
      text: readText(paragraph.text, 800, "paragraph text"),
      sourceIds: readSourceIds(paragraph.sourceIds, sourceIds),
    }
  })
  if (result.reduce((length, paragraph) => length + paragraph.text.length, 0) > 800) {
    throw new InvalidMarketBriefError("paragraph text must total at most 800 characters")
  }
  if (new Set(result.flatMap(paragraph => paragraph.sourceIds)).size > 3) {
    throw new InvalidMarketBriefError("paragraphs must cite at most three distinct sources")
  }
  if (new Set(result.map(paragraph => paragraph.text.toLowerCase())).size !== result.length) {
    throw new InvalidMarketBriefError("duplicate paragraph text")
  }
  return result
}

// Archived v1 briefs retain their original event structure and limits.
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

    return {
      title,
      summary: readText(event.summary, 600, "summary"),
      whyItMatters: readText(event.whyItMatters, 300, "whyItMatters"),
      verification: event.verification,
      sourceIds: readSourceIds(event.sourceIds, sourceIds),
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
  requireKeys(response, ["schemaVersion", "asOf", "items"])
  if (response.schemaVersion !== 3 || response.asOf !== asOf) {
    throw new InvalidMarketBriefError("response version or news cutoff does not match the request")
  }
  return validateBriefItems(response.items, sources)
}
