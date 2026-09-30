import assert from "node:assert/strict"
import test, { beforeEach } from "node:test"

import { collectMarketSources } from "../src/steps/step12.1-market-brief/collect-market-sources.js"

beforeEach((context) => {
  context.mock.method(globalThis, "fetch", async () => assert.fail("Unexpected network request"))
})

function collect (overrides = {}) {
  return collectMarketSources({
    referenceTimestamp: 1_800_000_000,
    fetchNews: async () => ({ items: [] }),
    fetchStory: async () => assert.fail("Unexpected story request"),
    fetchTweets: async () => ({ tweets: [], has_next_page: false }),
    wait: async () => {},
    ...overrides,
  })
}

function news (id, overrides = {}) {
  return {
    id,
    title: `News ${id}`,
    published: 1_799_999_940,
    tradingViewUrl: `https://www.tradingview.com/news/${id}/`,
    externalUrl: `https://publisher.example/news/${id}`,
    provider: { id: "publisher", name: "Original publisher" },
    ...overrides,
  }
}

function tweet (id, overrides = {}) {
  return {
    id,
    text: `Crypto ETF news ${id}`,
    createdAt: "Fri Jan 15 07:59:00 +0000 2027",
    author: { userName: "reporter" },
    ...overrides,
  }
}

test("collects one global crypto feed and general Twitter search with provenance and deterministic IDs", async () => {
  const feeds = []
  const stories = []
  const queries = []
  const result = await collect({
    fetchNews: async (...args) => {
      feeds.push(args)
      return { items: [news("tv")] }
    },
    fetchStory: async (request) => {
      stories.push(request)
      return { contentStatus: "full", content: "Full TradingView story.", author: "Carol" }
    },
    fetchTweets: async (query, cursor) => {
      queries.push({ query, cursor })
      return { tweets: [tweet("1234567890123456789")], has_next_page: false }
    },
  })

  assert.equal(result.from, "2027-01-15T02:00:00.000Z")
  assert.equal(result.asOf, "2027-01-15T08:00:00.000Z")
  assert.deepEqual(feeds, [[]])
  assert.deepEqual(stories, [{ id: "tv", url: "https://www.tradingview.com/news/tv/" }])
  assert.deepEqual(queries, [{
    query: "(crypto OR bitcoin OR ethereum) (ETF OR SEC OR Fed OR regulation OR hack OR exploit OR depeg OR outage OR liquidation) lang:en -filter:retweets -filter:replies since_time:1799978400 until_time:1800000001",
    cursor: "",
  }])
  assert.deepEqual(result.sources.map(source => [source.id, source.channel, source.author, source.publisher]), [
    ["source-1", "tradingview", "Carol", "Original publisher"],
    ["source-2", "twitter", "reporter", null],
  ])
  assert.equal(result.sources[0].url, "https://publisher.example/news/tv")
  assert.equal(result.sources[0].text, "Full TradingView story.")
  assert.equal(result.sources[1].url, "https://x.com/reporter/status/1234567890123456789")
  assert.deepEqual(result.coverage, ["tradingview", "twitter"].map(source => ({
    source, status: "available", fetchedCount: 1, error: null,
  })))
  assert.match(result.warnings.join(" "), /tradingview: bounded global crypto news sample.*no pagination.*not full 6-hour coverage/)
  assert.match(result.warnings.join(" "), /twitter: bounded Latest.*not full 6-hour coverage/)
})

test("defaults to the global TradingView client and preserves the original publisher without inventing an author", async (context) => {
  const fetchMock = context.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({
    items: [{
      id: "provider:article:0",
      title: "Solana ecosystem update",
      published: 1_800_000_000,
      provider: { id: "provider", name: "  Original   publisher  ", url: "https://provider.example" },
      storyPath: "/news/provider-article/",
      paywall: false,
      permission: "free",
      urgency: 1,
      relatedSymbols: [{ symbol: "BINANCE:SOLUSDT" }],
    }],
    pagination: { cursor: "next-batch" },
  })))
  const result = await collect({
    fetchNews: undefined,
    fetchStory: async () => ({ contentStatus: "full", content: "Full article without an author byline." }),
  })

  assert.equal(fetchMock.mock.callCount(), 1)
  assert.equal(fetchMock.mock.calls[0].arguments[0].href, "https://news-mediator.tradingview.com/public/news-flow/v2/news?filter=lang%3Aen&filter=market%3Acrypto&client=landing&streaming=false")
  assert.equal(result.sources.length, 1)
  assert.equal(result.sources[0].channel, "tradingview")
  assert.equal(result.sources[0].title, "Solana ecosystem update")
  assert.equal(result.sources[0].url, "https://www.tradingview.com/news/provider-article/")
  assert.equal(result.sources[0].publisher, "Original publisher")
  assert.equal(result.sources[0].author, null)
  assert.equal(result.coverage[0].error, null)
})

test("keeps Twitter identity ID-based across domains and usernames with no publisher", async () => {
  const result = await collect({
    fetchTweets: async (query, cursor) => ({
      tweets: [tweet("1234567890123456789", {
        url: cursor ? "https://twitter.com/new_name/status/1234567890123456789" : "https://x.com/old_name/status/1234567890123456789",
        author: { userName: cursor ? "new_name" : "old_name" },
        publisher: "Not a news publisher",
      })],
      has_next_page: !cursor,
      next_cursor: cursor ? "" : "next-page",
    }),
  })

  assert.equal(result.sources.length, 1)
  assert.equal(result.sources[0].url, "https://x.com/old_name/status/1234567890123456789")
  assert.equal(result.sources[0].author, "old_name")
  assert.equal(result.sources[0].publisher, null)
})

test("starts both channels without waiting for another channel and assigns IDs after sorting", async () => {
  const started = []
  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  const pending = collect({
    fetchNews: async () => {
      started.push("tradingview")
      await gate
      return { items: [news("z", { tradingViewUrl: null }), news("a", { tradingViewUrl: null })] }
    },
    fetchTweets: async () => {
      started.push("twitter")
      await gate
      return { tweets: [tweet("2"), tweet("1")] }
    },
  })

  assert.deepEqual(started, ["tradingview", "twitter"])
  release()
  const result = await pending
  assert.deepEqual(result.sources.map(source => source.id), ["source-1", "source-2", "source-3", "source-4"])
  assert.deepEqual(result.sources.map(source => source.url), [
    "https://publisher.example/news/a", "https://publisher.example/news/z",
    "https://x.com/reporter/status/1", "https://x.com/reporter/status/2",
  ])
})

test("validates inclusive six-hour boundaries locally for both channels before fetching stories", async () => {
  const dates = [
    "2027-01-15T02:00:00Z",
    "2027-01-15T08:00:00Z",
    "2027-01-15T01:59:59Z",
    "2027-01-15T08:00:01Z",
    "2027-01-15T01:59:59.999Z",
    "2027-01-15T08:00:00.001Z",
    "2027-01-15T07:59:59.999Z",
    "2027-01-15T04:00:00+02:00",
    1_799_978_400,
    1_800_000_000,
    "2027-01-14T08:00:00Z",
  ]
  const stories = []
  const result = await collect({
    fetchNews: async () => ({ items: dates.map((publishedAt, index) => news(String(index), { publishedAt, published: undefined })) }),
    fetchStory: async ({ id }) => {
      stories.push(id)
      return { contentStatus: "full", content: "Full article" }
    },
    fetchTweets: async () => ({ tweets: dates.map((createdAt, index) => tweet(String(index), { createdAt })) }),
  })

  assert.equal(result.from, "2027-01-15T02:00:00.000Z")
  assert.equal(result.asOf, "2027-01-15T08:00:00.000Z")
  assert.equal(result.sources.length, 12)
  assert.deepEqual(stories.sort(), ["0", "1", "6", "7", "8", "9"])
  for (const channel of ["tradingview", "twitter"]) {
    const sources = result.sources.filter(source => source.channel === channel)
    assert.deepEqual(sources.map(source => source.title.match(/\d+$/)[0]).sort(), ["0", "1", "6", "7", "8", "9"])
    assert.ok(sources.every(source => source.publishedAt >= result.from && source.publishedAt <= result.asOf))
  }
  assert.ok(result.coverage.every(source => source.error === null))
})

test("omits unknown or ambiguous timestamps without inventing dates or discarding valid neighbors", async () => {
  const dates = [undefined, null, "", "not-a-date", "2027-01-15", "2027-01-15T07:00:00", "2027-02-30T07:00:00Z", NaN, Infinity, {}]
  const stories = []
  const result = await collect({
    fetchNews: async () => ({ items: [news("valid"), ...dates.map((publishedAt, index) => news(String(index), { publishedAt, published: undefined }))] }),
    fetchStory: async ({ id }) => {
      stories.push(id)
      return { contentStatus: "full", content: "Full article" }
    },
    fetchTweets: async () => ({ tweets: [tweet("valid"), ...dates.map((createdAt, index) => tweet(String(index), { createdAt }))] }),
  })

  assert.deepEqual(stories, ["valid"])
  assert.equal(result.sources.length, 2)
  assert.ok(result.sources.every(source => source.publishedAt === "2027-01-15T07:59:00.000Z"))
  assert.deepEqual(result.coverage.map(source => [source.status, source.fetchedCount, source.error]), [["partial", 1, null], ["partial", 1, null]])
  for (const channel of ["tradingview", "twitter"]) {
    assert.ok(result.warnings.includes(`${channel}: missing, ambiguous or invalid publication time; item omitted`))
  }
})

test("uses current time, not PIPELINE_STARTED_AT, for the default six-hour cutoff", async (context) => {
  const previous = process.env.PIPELINE_STARTED_AT
  process.env.PIPELINE_STARTED_AT = "1700000000"
  context.after(() => {
    if (previous === undefined) {
      delete process.env.PIPELINE_STARTED_AT
    } else {
      process.env.PIPELINE_STARTED_AT = previous
    }
  })
  context.mock.method(Date, "now", () => 1_800_000_000_789)
  const result = await collect({ referenceTimestamp: undefined })

  assert.equal(result.from, "2027-01-15T02:00:00.000Z")
  assert.equal(result.asOf, "2027-01-15T08:00:00.000Z")
  assert.deepEqual(result.coverage.map(source => source.status), ["empty", "empty"])
})

test("only keeps safe public HTTP(S) links and preserves unknown Twitter authors as null", async () => {
  const unsafe = [
    "javascript:alert(1)", "data:text/html,hello", "ftp://example.com/news",
    "https://user:password@example.com/news", "http://127.0.0.1/news", "http://0x7f000001/news",
    "http://[::1]/news", "http://localhost/news", "http://host.local/news", "https://host.internal/news",
    "https://example.com/\nnews", "/relative/news",
  ]
  const result = await collect({
    fetchTweets: async () => ({ tweets: [
      ...unsafe.map(url => tweet(undefined, { url })),
      tweet("1", { author: undefined }),
      tweet("2", { author: { name: "Display name" } }),
      tweet(undefined, { url: "https://x.com/news/status/3", author: undefined }),
    ] }),
  })

  assert.equal(result.sources.length, 3)
  assert.deepEqual(result.sources.map(source => [source.url, source.author]), [
    ["https://x.com/i/web/status/1", null],
    ["https://x.com/i/web/status/2", "Display name"],
    ["https://x.com/news/status/3", null],
  ])
  assert.equal(result.coverage[1].status, "partial")
  assert.match(result.warnings.join(" "), /unsafe URL/)
})

test("deduplicates the single TradingView batch, caps stories/headlines and keeps explicit previews on errors", async () => {
  const feeds = []
  const stories = []
  const result = await collect({
    fetchNews: async (...args) => {
      feeds.push(args)
      return {
        items: [...Array.from({ length: 31 }, (_, index) => news(String(index), { published: 1_800_000_000 - index })), news("0")],
        pagination: { cursor: "next-batch" },
      }
    },
    fetchStory: async ({ id }) => {
      stories.push(id)
      if (id === "2") {
        throw new Error("HTTP 403 https://user:secret-token@upstream.example/news private-response")
      }
      if (id === "1") {
        return { contentStatus: "preview", shortDescription: "Paywall preview", content: "Not a full available body" }
      }
      return { contentStatus: "full", content: "x".repeat(id === "0" ? 7_000 : 400), unknownContentNodeTypes: id === "3" ? ["unsupported"] : [] }
    },
  })

  assert.deepEqual(feeds, [[]])
  assert.deepEqual(stories, ["0", "1", "2", "3", "4", "5"])
  assert.equal(result.sources.length, 30)
  assert.equal(result.coverage[0].status, "partial")
  assert.equal(result.coverage[0].fetchedCount, 30)
  assert.match(result.coverage[0].error, /story fetch failed; headline\/snippet retained: HTTP 403/)
  assert.equal(result.sources[0].text.length, 6_000)
  assert.match(result.sources[0].text, /Truncated/)
  assert.equal(result.sources[1].text, "[Snippet only]\nPaywall preview")
  assert.equal(result.sources[2].text, "[Headline only]\nNews 2")
  assert.match(result.sources[3].text, /^\[Partial text\]/)
  assert.equal(result.sources[6].text, "[Headline only]\nNews 6")
  assert.equal(result.sources[0].author, null)
  assert.match(result.warnings.join(" "), /headlines capped at 30/)
  assert.match(result.warnings.join(" "), /full-story fetching capped at 6/)
  assert.doesNotMatch(JSON.stringify(result), /secret-token|private-response|upstream\.example|Not a full available body|next-batch/)
})

test("retains external links, safe story links and feed snippets without inventing publishers or read failures", async () => {
  const stories = []
  const result = await collect({
    fetchNews: async () => ({ items: [
      news("external", { tradingViewUrl: null, author: "Original writer", provider: null }),
      news("snippet", { tradingViewUrl: null, description: "Feed description" }),
      news("story", { externalUrl: "https://user:password@publisher.example/private" }),
      news("unavailable"),
      news("foreign", { tradingViewUrl: "https://www.tradingview.com.evil.example/news/foreign/" }),
    ] }),
    fetchStory: async ({ id }) => {
      stories.push(id)
      return id === "story"
        ? { contentStatus: "full", content: "Full story", authors: [{ name: "Alice" }, { name: "Bob" }] }
        : { contentStatus: "unavailable" }
    },
  })
  const sources = Object.fromEntries(result.sources.map(source => [source.title, source]))

  assert.deepEqual(stories.sort(), ["story", "unavailable"])
  assert.equal(sources["News external"].url, "https://publisher.example/news/external")
  assert.equal(sources["News external"].author, "Original writer")
  assert.equal(sources["News external"].publisher, null)
  assert.equal(sources["News external"].text, "[Headline only]\nNews external")
  assert.equal(sources["News snippet"].text, "[Snippet only]\nFeed description")
  assert.equal(sources["News story"].url, "https://www.tradingview.com/news/story/")
  assert.equal(sources["News story"].text, "Full story")
  assert.equal(sources["News story"].author, "Alice, Bob")
  assert.equal(sources["News unavailable"].text, "[Headline only]\nNews unavailable")
  assert.equal(result.coverage[0].status, "partial")
  assert.equal(result.coverage[0].error, null)
  assert.doesNotMatch(JSON.stringify(result), /password/)
})

test("isolates malformed story responses and retains both the fallback and healthy full articles", async () => {
  const result = await collect({
    fetchNews: async () => ({ items: [news("broken", { shortDescription: "Feed preview" }), news("healthy")] }),
    fetchStory: async ({ id }) => id === "broken" ? null : { contentStatus: "full", content: "Full article" },
  })

  assert.deepEqual(result.sources.map(source => source.text), ["[Snippet only]\nFeed preview", "Full article"])
  assert.equal(result.coverage[0].fetchedCount, 2)
  assert.match(result.coverage[0].error, /story fetch failed.*invalid response/)
})

test("isolates crypto feed HTTP errors from Twitter and never leaks upstream credentials or bodies", async (context) => {
  context.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({
    message: "https://user:secret-token@upstream.example private-response",
  }), { status: 503 }))
  const result = await collect({ fetchNews: undefined, fetchTweets: async () => ({ tweets: [tweet("healthy")] }) })

  assert.equal(result.sources.length, 1)
  assert.equal(result.sources[0].channel, "twitter")
  assert.equal(result.coverage[0].status, "failed")
  assert.match(result.coverage[0].error, /crypto feed: HTTP 503/)
  assert.equal(result.coverage[1].status, "available")
  assert.doesNotMatch(JSON.stringify(result), /secret-token|private-response|upstream\.example/)
})

test("isolates malformed crypto feed responses while preserving Twitter sources", async () => {
  for (const response of [null, {}, { items: null }, { items: [], error: "secret-token" }, { items: [], status: "error" }]) {
    const result = await collect({ fetchNews: async () => response, fetchTweets: async () => ({ tweets: [tweet("healthy")] }) })

    assert.equal(result.sources.length, 1)
    assert.equal(result.sources[0].channel, "twitter")
    assert.equal(result.coverage[0].status, "failed")
    assert.match(result.coverage[0].error, /invalid response/)
    assert.equal(result.coverage[1].error, null)
    assert.doesNotMatch(JSON.stringify(result), /secret-token/)
  }
})

test("retains earlier Twitter pages when a later page fails and waits 300ms between requests", async () => {
  const calls = []
  const waits = []
  const result = await collect({
    wait: async milliseconds => waits.push(milliseconds),
    fetchTweets: async (query, cursor) => {
      calls.push(cursor)
      if (cursor === "page-3") {
        throw new Error("Twitter API error: 429 secret-token")
      }
      return {
        tweets: cursor ? [tweet("2"), tweet("3")] : [tweet("1"), tweet("2")],
        has_next_page: true,
        next_cursor: cursor ? "page-3" : "page-2",
      }
    },
  })

  assert.deepEqual(calls, ["", "page-2", "page-3"])
  assert.deepEqual(waits, [300, 300])
  assert.equal(result.sources.length, 3)
  assert.equal(result.coverage[1].status, "partial")
  assert.equal(result.coverage[1].fetchedCount, 3)
  assert.match(result.coverage[1].error, /page 3 failed.*API error: 429/)
  assert.doesNotMatch(JSON.stringify(result), /secret-token/)
})

test("bounds Twitter pagination, page size and long text without claiming full coverage", async () => {
  let pages = 0
  const waits = []
  const result = await collect({
    wait: async milliseconds => waits.push(milliseconds),
    fetchTweets: async () => {
      pages += 1
      return {
        tweets: Array.from({ length: 21 }, (_, index) => tweet(`${pages}-${index}`, { text: "x".repeat(6_100) })),
        has_next_page: true,
        next_cursor: `page-${pages + 1}`,
      }
    },
  })

  assert.equal(pages, 3)
  assert.deepEqual(waits, [300, 300])
  assert.equal(result.sources.length, 60)
  assert.ok(result.sources.every(source => source.text.length === 6_000))
  assert.equal(result.coverage[1].status, "partial")
  assert.equal(result.coverage[1].error, null)
  assert.match(result.warnings.join(" "), /capped at 3 pages/)
  assert.match(result.warnings.join(" "), /capped at 20 per page/)
  assert.match(result.warnings.join(" "), /not full 6-hour coverage/)
  assert.doesNotMatch(result.warnings.join(" "), /24-hour/)
})

for (const next_cursor of ["", "same-page"]) {
  test(`stops safely on ${next_cursor ? "repeated" : "missing"} Twitter cursors`, async () => {
    let pages = 0
    const result = await collect({
      fetchTweets: async () => {
        pages += 1
        return { tweets: [tweet(String(pages))], has_next_page: true, next_cursor }
      },
    })

    assert.equal(pages, next_cursor ? 2 : 1)
    assert.equal(result.sources.length, pages)
    assert.equal(result.coverage[1].status, "partial")
    assert.match(result.coverage[1].error, /missing or repeated pagination cursor/)
    assert.match(result.warnings.join(" "), /missing or repeated pagination cursor/)
  })
}

test("isolates first-page Twitter failures while retaining the crypto feed", async () => {
  const result = await collect({
    fetchNews: async () => ({ items: [news("healthy")] }),
    fetchStory: async () => ({ contentStatus: "full", content: "Full article" }),
    fetchTweets: async () => {
      throw new Error("Twitter API key is required secret-token")
    },
  })

  assert.equal(result.sources.length, 1)
  assert.equal(result.sources[0].channel, "tradingview")
  assert.equal(result.coverage[0].status, "available")
  assert.equal(result.coverage[0].error, null)
  assert.equal(result.coverage[1].status, "failed")
  assert.match(result.coverage[1].error, /API key is required/)
  assert.doesNotMatch(JSON.stringify(result), /secret-token/)
})

test("reports only the two failed channels without leaking errors and distinguishes empty successful samples", async () => {
  const result = await collect({
    fetchNews: async () => {
      throw { message: "private-response" }
    },
    fetchTweets: async () => ({ status: "error", tweets: [], error: "secret-token" }),
  })

  assert.deepEqual(result.sources, [])
  assert.deepEqual(result.coverage.map(source => [source.source, source.status, source.fetchedCount]), [["tradingview", "failed", 0], ["twitter", "failed", 0]])
  assert.ok(result.coverage.every(source => source.error))
  assert.doesNotMatch(JSON.stringify(result), /secret-token|private-response/)
  const empty = await collect()
  assert.deepEqual(empty.coverage, ["tradingview", "twitter"].map(source => ({ source, status: "empty", fetchedCount: 0, error: null })))
  assert.match(empty.warnings.join(" "), /tradingview: bounded global crypto news sample/)
  assert.match(empty.warnings.join(" "), /twitter: bounded Latest keyword sample/)
})

test("rejects invalid reference times and dependencies before requesting data", async () => {
  for (const referenceTimestamp of [0, -1, 1.5, NaN, Infinity, "1800000000", 9_000_000_000_000]) {
    await assert.rejects(collect({ referenceTimestamp }), /referenceTimestamp/)
  }
  for (const dependency of ["fetchNews", "fetchStory", "fetchTweets", "wait"]) {
    await assert.rejects(collect({ [dependency]: null }), /fetchers and wait must be functions/)
  }
})
