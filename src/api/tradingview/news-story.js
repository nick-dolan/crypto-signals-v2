import { getRequiredString } from "../../helpers/normalization-helper.js"
import { getTradingViewCookieHeader } from "./client.js"
import { requestTradingViewText } from "./request.js"

export const TRADINGVIEW_NEWS_CONTENT_PARSER_VERSION = 1

function getOptionalString (value) {
  if (typeof value !== "string") {
    return null
  }

  return value.trim() || null
}

function normalizeInlineText (value) {
  return value.replace(/\s+/g, " ").trim()
}

function normalizeDocumentText (value) {
  return value
    .split("\n")
    .map(line => line.replace(/[\t ]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}

function registerUnknownNodeType (node, unknownNodeTypes) {
  if (
    typeof node?.type === "string"
    && ![
      "*",
      "b",
      "disclaimer",
      "i",
      "list",
      "news-image",
      "p",
      "quote",
      "root",
      "story-refs",
      "symbol",
      "table",
      "table-body",
      "table-data-cell",
      "table-header",
      "table-header-cell",
      "table-row",
      "twitter",
      "url",
    ].includes(node.type)
  ) {
    unknownNodeTypes.add(node.type)
  }
}

function renderInlineNode (node, unknownNodeTypes) {
  if (typeof node === "string") {
    return node
  }

  if (Array.isArray(node)) {
    return node.map(child => renderInlineNode(child, unknownNodeTypes)).join("")
  }

  if (!node || typeof node !== "object") {
    return ""
  }

  registerUnknownNodeType(node, unknownNodeTypes)

  if (node.type === "news-image" || node.type === "story-refs") {
    return ""
  }

  if (node.type === "url") {
    return getOptionalString(node.params?.linkText)
      ?? renderInlineNode(node.children, unknownNodeTypes)
  }

  if (node.type === "symbol") {
    return getOptionalString(node.params?.text)
      ?? getOptionalString(node.params?.symbol)
      ?? ""
  }

  if (node.children !== undefined) {
    return renderInlineNode(node.children, unknownNodeTypes)
  }

  return getOptionalString(node.params?.text)
    ?? getOptionalString(node.params?.linkText)
    ?? ""
}

function renderTableNode (node, unknownNodeTypes) {
  const rows = []

  function collectRows (value) {
    if (Array.isArray(value)) {
      for (const child of value) {
        collectRows(child)
      }

      return
    }

    if (!value || typeof value !== "object") {
      return
    }

    registerUnknownNodeType(value, unknownNodeTypes)

    if (value.type === "table-row") {
      const cells = Array.isArray(value.children) ? value.children : []
      const row = cells
        .map(cell => normalizeInlineText(
          renderInlineNode(cell?.children ?? cell, unknownNodeTypes),
        ))
        .filter(Boolean)
        .join(" | ")

      if (row) {
        rows.push(row)
      }

      return
    }

    collectRows(value.children)
  }

  collectRows(node.children)
  return rows.join("\n")
}

function renderBlockNode (node, unknownNodeTypes) {
  if (typeof node === "string") {
    return normalizeInlineText(node)
  }

  if (Array.isArray(node)) {
    return node
      .map(child => renderBlockNode(child, unknownNodeTypes))
      .filter(Boolean)
      .join("\n\n")
  }

  if (!node || typeof node !== "object") {
    return ""
  }

  registerUnknownNodeType(node, unknownNodeTypes)

  if (node.type === "news-image" || node.type === "story-refs") {
    return ""
  }

  if (node.type === "root") {
    return renderBlockNode(node.children, unknownNodeTypes)
  }

  if (node.type === "list") {
    const items = Array.isArray(node.children) ? node.children : []

    return items
      .map((item) => {
        const itemText = normalizeInlineText(
          renderInlineNode(item?.children ?? item, unknownNodeTypes),
        )

        return itemText ? `- ${itemText}` : ""
      })
      .filter(Boolean)
      .join("\n")
  }

  if (node.type === "quote") {
    const quote = normalizeInlineText(
      renderInlineNode(node.children, unknownNodeTypes),
    )

    return quote ? `> ${quote}` : ""
  }

  if (["table", "table-header", "table-body"].includes(node.type)) {
    return renderTableNode(node, unknownNodeTypes)
  }

  return normalizeInlineText(renderInlineNode(node, unknownNodeTypes))
}

function convertAstToPlainText (ast) {
  const unknownNodeTypes = new Set()
  const content = normalizeDocumentText(renderBlockNode(ast, unknownNodeTypes))

  return {
    content: content || null,
    unknownNodeTypes: [...unknownNodeTypes].sort(),
  }
}

function findStoryCandidates (value, candidates) {
  if (Array.isArray(value)) {
    for (const item of value) {
      findStoryCandidates(item, candidates)
    }

    return
  }

  if (!value || typeof value !== "object") {
    return
  }

  if (value.story && typeof value.story === "object") {
    candidates.push(value.story)
  }

  for (const child of Object.values(value)) {
    findStoryCandidates(child, candidates)
  }
}

function extractStory (html, expectedId) {
  const candidates = []
  const scriptPattern = /<script\b[^>]*\btype=(["'])application\/prs\.init-data\+json\1[^>]*>([\s\S]*?)<\/script>/gi

  for (const match of html.matchAll(scriptPattern)) {
    try {
      const payload = JSON.parse(match[2])
      findStoryCandidates(payload, candidates)
    } catch {
      // Other init-data blocks are not part of the news story contract.
    }
  }

  const story = candidates.find(candidate => candidate?.id === expectedId)

  if (!story) {
    if (candidates.length > 0) {
      throw new Error(`TradingView story id does not match ${expectedId}`)
    }

    throw new Error(`TradingView story ${expectedId} was not found in the page`)
  }

  return story
}

function normalizeStoryUrl (value) {
  const normalizedValue = getRequiredString(value, "url")
  let url

  try {
    url = new URL(normalizedValue)
  } catch {
    throw new Error("TradingView story url is invalid")
  }

  if (
    url.origin !== "https://www.tradingview.com"
    || !url.pathname.startsWith("/news/")
  ) {
    throw new Error("TradingView story url must point to tradingview.com/news")
  }

  return url
}

function getReadTimeSeconds (value) {
  return Number.isFinite(value) && value >= 0 ? value : null
}

export function parseTradingViewNewsStoryHtml (html, expectedId) {
  const normalizedHtml = getRequiredString(html, "html")
  const normalizedExpectedId = getRequiredString(expectedId, "expectedId")
  const story = extractStory(normalizedHtml, normalizedExpectedId)
  const shortDescription = getOptionalString(story.short_description)
  const { content, unknownNodeTypes } = convertAstToPlainText(
    story.ast_description,
  )
  const isBlockedByPaywall = /data-qa-id=["']paywall-button["']/i.test(
    normalizedHtml,
  )
  let contentStatus = "unavailable"
  let availableContent = null

  if (!isBlockedByPaywall && content) {
    contentStatus = "full"
    availableContent = content
  } else if (shortDescription) {
    contentStatus = "preview"
  }

  return {
    content: availableContent,
    contentStatus,
    contentParserVersion: TRADINGVIEW_NEWS_CONTENT_PARSER_VERSION,
    shortDescription,
    readTimeSeconds: getReadTimeSeconds(story.read_time),
    copyright: getOptionalString(story.copyright),
    unknownContentNodeTypes: unknownNodeTypes,
    contentError: null,
  }
}

export async function fetchTradingViewNewsStory ({
  id,
  url,
  timeoutMs = 20_000,
} = {}) {
  const normalizedId = getRequiredString(id, "id")
  const normalizedUrl = normalizeStoryUrl(url)
  const html = await requestTradingViewText(normalizedUrl, {
    label: `TradingView story ${normalizedId}`,
    responseDescription: "HTML",
    timeoutMs,
    headers: {
      accept: "text/html",
      cookie: getTradingViewCookieHeader(),
    },
  })

  return {
    ...parseTradingViewNewsStoryHtml(html, normalizedId),
    contentFetchedAt: new Date().toISOString(),
  }
}
