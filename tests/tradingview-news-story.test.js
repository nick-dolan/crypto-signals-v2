import assert from "node:assert/strict"
import test from "node:test"

import {
  TRADINGVIEW_NEWS_CONTENT_PARSER_VERSION,
  fetchTradingViewNewsStory,
  parseTradingViewNewsStoryHtml,
} from "../src/api/tradingview/news-story.js"

function createStoryHtml (story, { paywall = false } = {}) {
  const payload = JSON.stringify({ generatedKey: { story } })
  const paywallButton = paywall
    ? "<button data-qa-id=\"paywall-button\">Keep reading</button>"
    : ""

  return `<!doctype html><html><body>${paywallButton}<script type="application/prs.init-data+json">${payload}</script></body></html>`
}

test("fetches a TradingView story as authenticated HTML", async (context) => {
  const previousSessionId = process.env.TV_SESSIONID
  const previousSessionIdSign = process.env.TV_SESSIONID_SIGN
  const id = "provider:fetched:0"
  const html = createStoryHtml({
    id,
    ast_description: {
      type: "root",
      children: [{ type: "p", children: ["Fetched story"] }],
    },
  })

  process.env.TV_SESSIONID = "test-session"
  process.env.TV_SESSIONID_SIGN = "test-signature"

  context.after(() => {
    if (previousSessionId === undefined) {
      delete process.env.TV_SESSIONID
    } else {
      process.env.TV_SESSIONID = previousSessionId
    }

    if (previousSessionIdSign === undefined) {
      delete process.env.TV_SESSIONID_SIGN
    } else {
      process.env.TV_SESSIONID_SIGN = previousSessionIdSign
    }
  })

  const fetchMock = context.mock.method(globalThis, "fetch", async () => (
    new Response(html, {
      headers: {
        "content-type": "text/html",
      },
    })
  ))
  const result = await fetchTradingViewNewsStory({
    id,
    url: `https://www.tradingview.com/news/${id}/`,
    timeoutMs: 100,
  })

  assert.equal(result.content, "Fetched story")
  assert.equal(fetchMock.mock.callCount(), 1)

  const [url, options] = fetchMock.mock.calls[0].arguments

  assert.equal(url.toString(), `https://www.tradingview.com/news/${id}/`)
  assert.equal(options.headers.accept, "text/html")
  assert.equal(
    options.headers.cookie,
    "sessionid=test-session;sessionid_sign=test-signature",
  )
  assert.equal(options.headers["user-agent"], "crypto-signals/1.0")
})

test("converts a TradingView story AST to plain text", () => {
  const html = createStoryHtml({
    id: "provider:article:0",
    short_description: "Preview",
    read_time: 90,
    copyright: "Copyright Provider",
    ast_description: {
      type: "root",
      children: [
        {
          type: "p",
          children: [
            "First ",
            { type: "b", children: ["bold"] },
            " and ",
            {
              type: "url",
              params: {
                url: "https://example.com",
                linkText: "source",
              },
            },
            ".",
          ],
        },
        {
          type: "list",
          children: [
            { type: "*", children: ["One"] },
            {
              type: "*",
              children: [
                {
                  type: "symbol",
                  params: {
                    symbol: "NASDAQ:COIN",
                    text: "NASDAQ:COIN",
                  },
                },
              ],
            },
          ],
        },
        {
          type: "twitter",
          children: [
            {
              type: "p",
              children: [
                "Tweet ",
                {
                  type: "url",
                  params: {
                    url: "https://x.com/example",
                    linkText: "$BTC",
                  },
                },
              ],
            },
          ],
        },
        {
          type: "news-image",
          params: { image: { id: "image-id" } },
        },
        {
          type: "quote",
          children: [{ type: "p", children: ["Quoted text"] }],
        },
        {
          type: "table",
          children: [
            {
              type: "table-header",
              children: [
                {
                  type: "table-row",
                  children: [
                    {
                      type: "table-header-cell",
                      children: ["Asset"],
                    },
                    {
                      type: "table-header-cell",
                      children: ["Price"],
                    },
                  ],
                },
              ],
            },
            {
              type: "table-body",
              children: [
                {
                  type: "table-row",
                  children: [
                    {
                      type: "table-data-cell",
                      children: ["Bitcoin"],
                    },
                    {
                      type: "table-data-cell",
                      children: ["$75,000"],
                    },
                  ],
                },
              ],
            },
          ],
        },
        {
          type: "disclaimer",
          children: [{ type: "p", children: ["Verify important facts."] }],
        },
        {
          type: "story-refs",
          params: { refs: [{ id: "related:story:0" }] },
        },
        {
          type: "future-node",
          children: [{ type: "p", children: ["Unknown text"] }],
        },
      ],
    },
  })

  assert.deepEqual(
    parseTradingViewNewsStoryHtml(html, "provider:article:0"),
    {
      content: [
        "First bold and source.",
        "- One\n- NASDAQ:COIN",
        "Tweet $BTC",
        "> Quoted text",
        "Asset | Price\nBitcoin | $75,000",
        "Verify important facts.",
        "Unknown text",
      ].join("\n\n"),
      contentStatus: "full",
      contentParserVersion: TRADINGVIEW_NEWS_CONTENT_PARSER_VERSION,
      shortDescription: "Preview",
      readTimeSeconds: 90,
      copyright: "Copyright Provider",
      unknownContentNodeTypes: ["future-node"],
      contentError: null,
    },
  )
})

test("does not expose hidden AST content when a paywall button is present", () => {
  const html = createStoryHtml({
    id: "provider:paywall:0",
    short_description: "Allowed preview",
    ast_description: {
      type: "root",
      children: [{ type: "p", children: ["Hidden full article"] }],
    },
  }, { paywall: true })

  const result = parseTradingViewNewsStoryHtml(html, "provider:paywall:0")

  assert.equal(result.content, null)
  assert.equal(result.contentStatus, "preview")
  assert.equal(result.shortDescription, "Allowed preview")
})

test("marks a story without content as unavailable", () => {
  const html = createStoryHtml({ id: "provider:empty:0" })
  const result = parseTradingViewNewsStoryHtml(html, "provider:empty:0")

  assert.equal(result.content, null)
  assert.equal(result.contentStatus, "unavailable")
})

test("rejects a story with an unexpected id", () => {
  const html = createStoryHtml({
    id: "provider:actual:0",
    ast_description: {
      type: "root",
      children: [{ type: "p", children: ["Text"] }],
    },
  })

  assert.throws(
    () => parseTradingViewNewsStoryHtml(html, "provider:expected:0"),
    /does not match/,
  )
})
