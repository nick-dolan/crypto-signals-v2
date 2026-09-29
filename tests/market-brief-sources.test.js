import assert from "node:assert/strict"
import test, { beforeEach } from "node:test"

import { fetchTradingViewNews } from "../src/api/tradingview/news.js"
import { collectMarketSources } from "../src/steps/step12.1-market-brief/collect-market-sources.js"

beforeEach((context) => {
  context.mock.method(globalThis, "fetch", async () => assert.fail("Unexpected network request"))
})

function collect (overrides = {}) {
  return collectMarketSources({
    referenceTimestamp: 1_800_000_000,
    requestTavily: async () => ({ results: [] }),
    fetchNews: async () => ({ items: [] }),
    fetchStory: async () => assert.fail("Unexpected story request"),
    fetchTweets: async () => ({ tweets: [], has_next_page: false }),
    wait: async () => {},
    ...overrides,
  })
}

function article (id, overrides = {}) {
  return {
    title: `News ${id}`,
    url: `https://publisher.example/news/${id}`,
    published_date: "2027-01-15T07:59:00Z",
    content: "The company announced a scheduled update on January 15, with a stated amount of $10 million. The report describes the timeline, the organizations involved and the next steps confirmed by the official announcement. ".repeat(2).trim(),
    author: `Author ${id}`,
    ...overrides,
  }
}

async function collectTavilyPages (pages, extract = async () => assert.fail("Unexpected extract request")) {
  const calls = []
  let search = 0
  const result = await collect({
    requestTavily: async (endpoint, body, options) => {
      calls.push({ endpoint, body, options })
      if (endpoint === "/search") {
        return { results: pages[search++] ?? [] }
      }
      assert.equal(endpoint, "/extract")
      return extract(body, options)
    },
  })

  return { result, calls }
}

function assertTavilyText (source, body, kind = "search") {
  assert.ok(source.text.startsWith(kind === "headline" ? "[Headline only]\n" : "[Snippet only]\n"))
  assert.ok(source.text.includes(kind === "extract"
    ? "[Extract: two relevant fragments, not the full article]\n"
    : "[Search snippet, not the full article]\n"))
  assert.equal(source.text.replace(/^(?:\[[^\n]+\]\n)+/, ""), body)
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

test("collects three parallel channels with bounded news queries, provenance and deterministic IDs", async () => {
  const searches = []
  const symbols = []
  const stories = []
  const queries = []
  const result = await collect({
    requestTavily: async (endpoint, body) => {
      searches.push({ endpoint, body })
      return { results: searches.length === 1 ? [article("tavily", { author: [{ name: "Alice" }, { name: "Bob" }] })] : [] }
    },
    fetchNews: async ({ symbol }) => {
      symbols.push(symbol)
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

  assert.equal(result.from, "2027-01-14T08:00:00.000Z")
  assert.equal(result.asOf, "2027-01-15T08:00:00.000Z")
  assert.equal(searches.length, 3)
  assert.ok(searches[0].body.query.includes("Bitcoin"))
  assert.ok(searches[1].body.query.includes("Federal Reserve"))
  assert.ok(searches[2].body.query.includes("exploit"))
  for (const { endpoint, body } of searches) {
    assert.equal(endpoint, "/search")
    assert.equal(body.topic, "news")
    assert.equal(body.time_range, "day")
    assert.equal(body.include_answer, false)
    assert.equal(body.include_raw_content, false)
    assert.equal(body.max_results, 5)
  }
  assert.deepEqual(symbols, ["BINANCE:BTCUSDT.P", "BINANCE:ETHUSDT.P"])
  assert.deepEqual(stories, [{ id: "tv", url: "https://www.tradingview.com/news/tv/" }])
  assert.deepEqual(queries, [{
    query: "(crypto OR bitcoin OR ethereum) (ETF OR SEC OR Fed OR regulation OR hack OR exploit OR depeg OR outage OR liquidation) lang:en -filter:retweets -filter:replies since_time:1799913600 until_time:1800000001",
    cursor: "",
  }])
  assert.deepEqual(result.sources.map(source => [source.id, source.channel, source.author, source.publisher]), [
    ["source-1", "tavily", "Alice, Bob", "publisher.example"],
    ["source-2", "tradingview", "Carol", "Original publisher"],
    ["source-3", "twitter", "reporter", null],
  ])
  assert.equal(result.sources[0].url, "https://publisher.example/news/tavily")
  assert.equal(result.sources[1].url, "https://publisher.example/news/tv")
  assert.equal(result.sources[2].url, "https://x.com/reporter/status/1234567890123456789")
  assert.deepEqual(result.coverage, ["tavily", "tradingview", "twitter"].map(source => ({
    source, status: source === "tavily" ? "partial" : "available", fetchedCount: 1, error: null,
  })))
  assert.match(result.warnings.join(" "), /tavily:.*(?:snippet|excerpt)/i)
  assert.match(result.warnings.join(" "), /bounded Latest.*not full 24-hour coverage/)
})

test("preserves the original publisher from the actual TradingView client without inventing an author", async (context) => {
  context.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({
    items: [{
      id: "provider:article:0",
      title: "Bitcoin update",
      published: 1_800_000_000,
      provider: { id: "provider", name: "  Original   publisher  ", url: "https://provider.example" },
      storyPath: "/news/provider-article/",
      paywall: false,
      permission: "free",
      urgency: 1,
    }],
  })))
  const result = await collect({
    fetchNews: fetchTradingViewNews,
    fetchStory: async () => ({ contentStatus: "full", content: "Full article without an author byline." }),
  })

  assert.equal(result.sources.length, 1)
  assert.equal(result.sources[0].channel, "tradingview")
  assert.equal(result.sources[0].url, "https://www.tradingview.com/news/provider-article/")
  assert.equal(result.sources[0].publisher, "Original publisher")
  assert.equal(result.sources[0].author, null)
})

test("normalizes declared Tavily publishers and falls back to the article hostname independently of authors", async () => {
  let searches = 0
  const result = await collect({
    requestTavily: async () => ({
      results: searches++ === 0
        ? [
            article("declared", { publisher: "  News   Desk \n", author: "Alice" }),
            article("object", { publisher: { name: " Publisher Company " }, author: null }),
            article("hostname", { url: "https://NEWS.Example:443/article", author: "Bob" }),
            article("blank", { publisher: " \n ", author: null }),
          ]
        : [],
    }),
  })

  assert.deepEqual(Object.fromEntries(result.sources.map(source => [source.title, [source.publisher, source.author]])), {
    "News declared": ["News Desk", "Alice"],
    "News object": ["Publisher Company", null],
    "News hostname": ["news.example", "Bob"],
    "News blank": ["publisher.example", null],
  })
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

test("starts all list requests without waiting for another channel and assigns IDs after sorting", async () => {
  const started = []
  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  const pending = collect({
    requestTavily: async () => {
      started.push("tavily")
      await gate
      return { results: [article("z"), article("a")] }
    },
    fetchNews: async () => {
      started.push("tradingview")
      await gate
      return { items: [] }
    },
    fetchTweets: async () => {
      started.push("twitter")
      await gate
      return { tweets: [tweet("2"), tweet("1")] }
    },
  })

  assert.deepEqual(started, ["tavily", "tavily", "tavily", "tradingview", "tradingview", "twitter"])
  release()
  const result = await pending
  assert.deepEqual(result.sources.map(source => source.id), Array.from({ length: 8 }, (_, index) => `source-${index + 1}`))
  assert.deepEqual(result.sources.slice(0, 3).map(source => source.url), Array(3).fill("https://publisher.example/news/a"))
  assert.equal(result.sources[6].url, "https://x.com/reporter/status/1")
})

test("validates inclusive 24-hour boundaries, rejects future/old/undated items and never invents dates", async () => {
  const dates = [
    "2027-01-14T08:00:00Z",
    "2027-01-15T08:00:00Z",
    "2027-01-14T07:59:59Z",
    "2027-01-15T08:00:01Z",
    "not-a-date",
    undefined,
    "2027-01-15",
    "2027-01-15T07:00:00",
    "2027-02-30T07:00:00Z",
  ]
  let query = 0
  const result = await collect({
    requestTavily: async () => ({
      results: dates.slice(query++ * 3, query * 3).map((published_date, index) => article(`${query}-${index}`, { published_date })),
    }),
    fetchNews: async () => ({ items: dates.map((publishedAt, index) => news(String(index), { publishedAt, published: undefined })) }),
    fetchStory: async () => ({ contentStatus: "full", content: "Full article" }),
    fetchTweets: async () => ({ tweets: dates.map((createdAt, index) => tweet(String(index), { createdAt })) }),
  })

  assert.equal(result.sources.length, 6)
  for (const source of result.sources) {
    assert.ok([result.from, result.asOf].includes(source.publishedAt))
  }
  assert.deepEqual(result.coverage.map(source => [source.status, source.fetchedCount]), Array(3).fill(["partial", 2]))
  assert.match(result.warnings.join(" "), /invalid publication time/)
})

test("uses current time, not PIPELINE_STARTED_AT, for the default cutoff", async (context) => {
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

  assert.equal(result.asOf, "2027-01-15T08:00:00.000Z")
  assert.deepEqual(result.coverage.map(source => source.status), ["empty", "empty", "empty"])
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
  assert.equal(result.coverage[2].status, "partial")
  assert.match(result.warnings.join(" "), /unsafe URL/)
})

test("skips Extract for adequate Tavily snippets without raw content and ignores unexpected full articles", async () => {
  const items = [
    article("adequate"),
    article("large", {
      content: article("context").content.repeat(10),
      raw_content: "UNEXPECTED SEARCH RAW ARTICLE. ".repeat(2_000),
    }),
  ]
  const { result, calls } = await collectTavilyPages([items])

  assert.deepEqual(calls.map(call => call.endpoint), ["/search", "/search", "/search"])
  assert.equal(result.sources.length, 2)
  for (const item of items) {
    assertTavilyText(result.sources.find(source => source.url === item.url), item.content.slice(0, 1200))
  }
  assert.deepEqual(result.coverage[0], { source: "tavily", status: "partial", fetchedCount: 2, error: null })
  assert.match(result.warnings.join(" "), /tavily:.*(?:snippet|excerpt)/i)
  assert.match(result.warnings.join(" "), /capped at 1200/)
  assert.equal(JSON.stringify(result).includes("UNEXPECTED SEARCH RAW ARTICLE"), false)
})

test("makes two independent targeted Extract requests, caps excerpts and prefers even shorter successful excerpts", async () => {
  const items = [
    article("long", {
      title: `Bitcoin treasury acquisition ${"details ".repeat(40)}TITLE_SUFFIX_OUTSIDE_QUERY`,
      content: "Short preview of the acquisition.",
      raw_content: "UNEXPECTED SEARCH RAW ARTICLE. ".repeat(2_000),
      score: 0.9,
    }),
    article("noisy", { content: `Prediction Banner. ${article("context").content}`, score: 0.8, author: null }),
  ]
  const excerpts = ["Relevant acquisition details. ".repeat(100), "The exchange confirmed a $12 million acquisition on January 15."]
  const started = []
  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  const pending = collectTavilyPages([items], async ({ urls }) => {
    started.push(urls[0])
    await gate
    return { results: [{ url: urls[0], raw_content: excerpts[items.findIndex(item => item.url === urls[0])], author: "Extracted author" }] }
  })
  await new Promise(resolve => setImmediate(resolve))
  const startedBeforeRelease = [...started]
  release()
  const { result, calls } = await pending

  assert.deepEqual(startedBeforeRelease, items.map(item => item.url))
  assert.deepEqual(calls.map(call => call.endpoint), ["/search", "/search", "/search", "/extract", "/extract"])
  for (const [index, { body, options }] of calls.slice(3).entries()) {
    assert.deepEqual(body.urls, [items[index].url])
    assert.ok(body.query.includes(items[index].title.slice(0, 240)))
    assert.equal(body.query.includes("TITLE_SUFFIX_OUTSIDE_QUERY"), false)
    if (items[index].title.length > 240) {
      assert.equal(body.query.includes(items[index].title.slice(0, 241)), false)
    }
    for (const phrase of ["key facts", "dates", "amounts", "what happened"]) {
      assert.ok(body.query.toLowerCase().includes(phrase))
    }
    assert.equal(body.chunks_per_source, 2)
    assert.equal(body.extract_depth, "advanced")
    assert.equal(body.format, "text")
    assert.equal(body.timeout, 30)
    assert.equal(options.timeoutMs, 45_000)
    assertTavilyText(result.sources.find(source => source.url === items[index].url), excerpts[index].slice(0, 1800), "extract")
  }
  assert.equal(result.sources.find(source => source.url === items[0].url).author, items[0].author)
  assert.equal(result.sources.find(source => source.url === items[1].url).author, "Extracted author")
  assert.deepEqual(result.coverage[0], { source: "tavily", status: "partial", fetchedCount: 2, error: null })
  assert.match(result.warnings.join(" "), /capped at 1800/)
  assert.equal(JSON.stringify(result).includes("UNEXPECTED SEARCH RAW ARTICLE"), false)
})

test("marks Tavily headline-only fallback and never substitutes unexpected raw article text", async () => {
  const item = article("headline", { content: " \n ", raw_content: "UNEXPECTED SEARCH RAW ARTICLE. ".repeat(2_000) })
  const { result, calls } = await collectTavilyPages([[item]], async () => ({ results: [] }))

  assert.deepEqual(calls.filter(call => call.endpoint === "/extract").map(call => call.body.urls), [[item.url]])
  assertTavilyText(result.sources[0], item.title, "headline")
  assert.equal(result.coverage[0].status, "partial")
  assert.match(result.coverage[0].error, /extraction incomplete/)
  assert.equal(JSON.stringify(result).includes("UNEXPECTED SEARCH RAW ARTICLE"), false)
})

test("selects long Tavily snippets containing any agreed boilerplate marker", async (context) => {
  for (const marker of [
    "Prediction Banner", "Read More", "Next Read", "Also Read", "Copy Link", "Share on", "Stock Screeners",
    "privacy policy", "terms of use", "terms of service", "all categories", "market data api",
    "add to preferred sources", "crypto regulation hub", "deep dives", "ADVERTISEMENT",
  ]) {
    await context.test(marker, async () => {
      const item = article("noisy", {
        title: "Bitcoin exchange custody expansion confirmed",
        content: `Bitcoin exchange custody expansion confirmed. ${marker}. ${article("context").content}`,
      })
      const { result, calls } = await collectTavilyPages([[item]], async () => ({ results: [{ url: item.url, raw_content: "Relevant facts." }] }))

      assert.deepEqual(calls.filter(call => call.endpoint === "/extract").map(call => call.body.urls), [[item.url]])
      assertTavilyText(result.sources[0], "Relevant facts.", "extract")
    })
  }
})

test("uses snippet length and unique whole Unicode headline words only as a context heuristic", async (context) => {
  const content = article("context").content
  for (const { name, title, snippet = content, extract } of [
    { name: "299 characters is insufficient", title: "Bitcoin Ethereum Solana", snippet: "Bitcoin Ethereum Solana. ".padEnd(299, "x"), extract: true },
    { name: "300 characters is adequate", title: "Bitcoin Ethereum Solana", snippet: "Bitcoin Ethereum Solana. ".padEnd(300, "x"), extract: false },
    { name: "title words beyond 1200 characters do not provide context", title: "Bitcoin Ethereum Solana", snippet: `${content.padEnd(1200, ".")} Bitcoin Ethereum Solana.`, extract: true },
    { name: "three missing title words", title: "Bitcoin Ethereum Solana", extract: true },
    { name: "one of three words is enough", title: "Bitcoin Ethereum Solana", snippet: `BITCOIN, ${content}`, extract: false },
    { name: "one of four words is insufficient", title: "Bitcoin Ethereum Solana Avalanche", snippet: `Bitcoin. ${content}`, extract: true },
    { name: "two of six words is enough", title: "Bitcoin Ethereum Solana Avalanche Polygon Cardano", snippet: `Bitcoin/Ethereum. ${content}`, extract: false },
    { name: "short words do not reach the three-word minimum", title: "Bitcoin Ethereum SEC ETF Fed BTC", extract: false },
    { name: "five-letter words count", title: "Funds votes surge", extract: true },
    { name: "repeated title words count only once", title: "Bitcoin bitcoin BITCOIN Ethereum Solana", snippet: `Ethereum. ${content}`, extract: false },
    { name: "substrings are not whole words", title: "Bitcoin Ethereum Solana", snippet: `Bitcoins Ethereumish Solanas. ${content}`, extract: true },
    { name: "Unicode title words count", title: "Платежи запуск обновление", extract: true },
    { name: "Unicode words match ignoring case and punctuation", title: "Платежи запуск обновление", snippet: `ПЛАТЕЖИ, ${content}`, extract: false },
    { name: "Unicode substrings are not whole words", title: "Платежи запуск обновление", snippet: `суперплатежи перезапуск обновлениями. ${content}`, extract: true },
  ]) {
    await context.test(name, async () => {
      const item = article("context", { title, content: snippet })
      const { result, calls } = await collectTavilyPages([[item]], async () => ({ results: [{ url: item.url, raw_content: "Relevant facts." }] }))

      assert.deepEqual(calls.filter(call => call.endpoint === "/extract").map(call => call.body.urls), extract ? [[item.url]] : [])
      assertTavilyText(result.sources[0], extract ? "Relevant facts." : snippet, extract ? "extract" : "search")
    })
  }
})

test("deduplicates normalized Extract requests, preserving distinct snippets and reusing excerpts only for identical ones", async (context) => {
  const items = [
    article("first", {
      url: "https://publisher.example/news/shared?edition=global&utm_source=first#intro",
      content: `Prediction Banner. ${article("context").content.repeat(4)}`,
      publisher: "First publisher",
      score: 0.4,
    }),
    article("second", {
      url: "https://publisher.example/news/shared?utm_medium=email&edition=global#timeline",
      content: "Second snippet.",
      publisher: "Second publisher",
      score: 0.9,
    }),
    article("third", {
      url: "https://publisher.example/news/shared?utm_medium=email&edition=global#timeline",
      content: "Third different snippet for the same original URL.",
      publisher: "Third publisher",
      score: 0.3,
    }),
    article("identical", {
      url: "https://publisher.example/news/shared?edition=global&utm_campaign=repeat#facts",
      content: "Second snippet.",
      publisher: "Fourth publisher",
      score: 0.2,
    }),
  ]
  for (const successful of [true, false]) {
    await context.test(successful ? "matching normalized result" : "failed normalized URL", async () => {
      const { result, calls } = await collectTavilyPages([[items[0]], [items[1]], items.slice(2)], async () => ({
        results: successful
          ? [{
              url: "https://publisher.example/news/shared?edition=global&fbclid=response#fragment",
              raw_content: "Requested relevant excerpt.",
              author: "Extracted author must not overwrite bylines",
              title: "Extracted title must not overwrite headlines",
              publisher: "Extracted publisher must not overwrite publishers",
            }]
          : [],
        failed_results: successful ? [] : [{ url: "https://publisher.example/news/shared?edition=global", error: "secret-token" }],
      }))

      assert.deepEqual(calls.filter(call => call.endpoint === "/extract").map(call => call.body.urls), [[items[1].url]])
      assert.equal(result.sources.length, items.length)
      for (const item of items) {
        const source = result.sources.find(source => source.author === item.author)
        assert.equal(source.url, item.url)
        assert.equal(source.title, item.title)
        assert.equal(source.publisher, item.publisher)
        assert.equal(source.publishedAt, "2027-01-15T07:59:00.000Z")
        const extracted = successful && item.content === items[1].content
        assertTavilyText(source, extracted ? "Requested relevant excerpt." : item.content.slice(0, 1200), extracted ? "extract" : "search")
      }
      assert.equal(result.coverage[0].fetchedCount, items.length)
      assert.equal(result.coverage[0].status, "partial")
      if (successful) {
        assert.equal(result.coverage[0].error, null)
      } else {
        assert.match(result.coverage[0].error, /extraction incomplete/)
      }
      assert.equal(JSON.stringify(result).includes("secret-token"), false)
      assert.equal(JSON.stringify(result).includes("must not overwrite"), false)
    })
  }
})

test("only retained adequate duplicate context blocks Extract without merging original records", async (context) => {
  for (const beyondLimit of [false, true]) {
    await context.test(beyondLimit ? "context beyond 1200 does not block Extract" : "retained context blocks Extract", async () => {
      const items = [
        article("poor", { url: "https://publisher.example/news/shared?utm_source=first#intro", content: "Poor snippet.", score: 0.99 }),
        article("other", { content: "Another short snippet.", score: 0.5 }),
        article("adequate", {
          url: "https://publisher.example/news/shared?gclid=tracking#facts",
          title: "Bitcoin Ethereum Solana",
          content: beyondLimit
            ? `${article("context").content.padEnd(1200, ".")} Bitcoin Ethereum Solana.`
            : `Bitcoin Ethereum Solana. ${article("context").content}`,
          score: 0.01,
        }),
      ]
      const { result, calls } = await collectTavilyPages([[items[0], items[1]], [], [items[2]]], async ({ urls }) => ({
        results: [{ url: urls[0], raw_content: "Relevant facts." }],
      }))

      assert.deepEqual(calls.filter(call => call.endpoint === "/extract").map(call => call.body.urls), beyondLimit ? [[items[0].url], [items[1].url]] : [[items[1].url]])
      assert.equal(result.sources.length, 3)
      for (const item of items) {
        const source = result.sources.find(source => source.author === item.author)
        const extracted = item === items[1] || (beyondLimit && item === items[0])
        assert.equal(source.url, item.url)
        assertTavilyText(source, extracted ? "Relevant facts." : item.content.slice(0, 1200), extracted ? "extract" : "search")
      }
      assert.equal(result.coverage[0].error, null)
    })
  }
})

test("budgets two Extract URLs by descending score, then source order, without dropping lower-ranked records", async () => {
  const items = [
    article("adequate", { score: 1 }),
    article("newest", { score: 0.4, published_date: "2027-01-15T08:00:00Z", content: "Newer but lower score." }),
    article("z-tie", { score: 0.8, content: "URL sorts later." }),
    article("a-tie", { score: 0.8, content: "URL sorts first." }),
    article("winner", { score: 0.9, published_date: "2027-01-14T08:00:00Z", content: "Older but highest eligible score." }),
  ]
  const { result, calls } = await collectTavilyPages([items], async ({ urls }) => ({
    results: [{ url: urls[0], raw_content: `Excerpt for ${urls[0]}` }],
  }))

  assert.deepEqual(calls.filter(call => call.endpoint === "/extract").map(call => call.body.urls), [[items[4].url], [items[3].url]])
  assert.equal(result.sources.length, 5)
  for (const item of items) {
    const extracted = [items[4], items[3]].includes(item)
    assertTavilyText(result.sources.find(source => source.url === item.url), extracted ? `Excerpt for ${item.url}` : item.content, extracted ? "extract" : "search")
  }
  assert.match(result.warnings.join(" "), /extraction capped at 2 URLs/)
  assert.equal(result.coverage[0].error, null)
})

test("breaks equal Extract scores by publication time before URL order", async () => {
  const items = [
    article("a-oldest", { content: "Oldest snippet.", score: 0.8, published_date: "2027-01-14T08:00:00Z" }),
    article("b-middle", { content: "Middle snippet.", score: 0.8, published_date: "2027-01-15T07:00:00Z" }),
    article("z-newest", { content: "Newest snippet.", score: 0.8, published_date: "2027-01-15T08:00:00Z" }),
  ]
  const { calls } = await collectTavilyPages([items], async ({ urls }) => ({ results: [{ url: urls[0], raw_content: "Relevant facts." }] }))

  assert.deepEqual(calls.filter(call => call.endpoint === "/extract").map(call => call.body.urls), [[items[2].url], [items[1].url]])
})

test("caps Tavily search results locally and never emits an answer as an article", async () => {
  const result = await collect({
    requestTavily: async () => ({
      answer: "Invented answer without a publication date",
      results: Array.from({ length: 7 }, (_, index) => article(String(index))),
    }),
  })

  assert.equal(result.sources.length, 15)
  assert.equal(result.coverage[0].status, "partial")
  assert.match(result.warnings.join(" "), /search capped at 5/)
  assert.equal(JSON.stringify(result).includes("Invented answer"), false)
})

test("isolates failed and malformed search queries while keeping successful sources", async () => {
  let query = 0
  const result = await collect({
    requestTavily: async () => {
      query += 1
      if (query === 1) {
        throw new Error("Tavily HTTP 429 secret-token private-query")
      }
      return query === 2 ? { results: [article("survives")] } : { error: "secret-token" }
    },
    fetchTweets: async () => ({ tweets: [tweet("1")] }),
  })

  assert.equal(result.sources.length, 2)
  assert.equal(result.coverage[0].status, "partial")
  assert.equal(result.coverage[2].status, "available")
  assert.match(result.coverage[0].error, /HTTP 429/)
  assert.match(result.coverage[0].error, /invalid response/)
  assert.equal(JSON.stringify(result).includes("secret-token"), false)
  assert.equal(JSON.stringify(result).includes("private-query"), false)
})

test("isolates failed or unusable Extract responses, retaining bounded snippets and independent successes", async (context) => {
  const failed = article("failed", {
    url: "https://publisher.example/news/failed?utm_source=search#original",
    content: `Prediction Banner. ${article("context").content.repeat(4)}`,
    raw_content: "UNEXPECTED SEARCH RAW ARTICLE. ".repeat(2_000),
    score: 0.9,
  })
  const healthy = article("healthy", { content: "Short preview.", score: 0.8 })
  for (const { name, response, error } of [
    { name: "request timeout", error: new Error("request timed out secret-token PRIVATE_RESPONSE") },
    { name: "HTTP failure", error: new Error("Tavily HTTP 429 secret-token PRIVATE_RESPONSE") },
    { name: "missing result", response: { results: [] } },
    { name: "empty content", response: { results: [{ url: failed.url, raw_content: " \n " }] } },
    { name: "absent content", response: { results: [{ url: failed.url }] } },
    { name: "unmatched URL", response: { results: [
      { url: "https://unexpected.example/article", raw_content: "UNREQUESTED ARTICLE", author: "Unrequested author" },
      { url: healthy.url, raw_content: "WRONG_REQUEST ARTICLE" },
    ] } },
    { name: "failed_results overrides matching content", response: {
      results: [{ url: failed.url, raw_content: "FAILED_EXCERPT", author: "Unrequested author" }],
      failed_results: [{ url: "https://publisher.example/news/failed?gclid=response#other", error: "secret-token PRIVATE_RESPONSE" }],
    } },
    { name: "item error", response: { results: [{ url: failed.url, raw_content: "FAILED_EXCERPT", error: "secret-token PRIVATE_RESPONSE" }] } },
    { name: "malformed response", response: { error: "secret-token PRIVATE_RESPONSE" } },
  ]) {
    await context.test(name, async () => {
      const { result, calls } = await collectTavilyPages([[failed, healthy]], async ({ urls }) => {
        if (urls[0] === healthy.url) {
          return {
            results: [
              { url: failed.url, raw_content: "WRONG_REQUEST ARTICLE" },
              { url: "https://unexpected.example/article", raw_content: "UNREQUESTED ARTICLE", author: "Unrequested author" },
              { url: `${healthy.url}?utm_source=extract#fragment`, raw_content: "Independent relevant excerpt." },
            ],
            failed_results: [{ url: failed.url, error: "secret-token PRIVATE_RESPONSE" }],
          }
        }
        if (error) {
          throw error
        }
        return response
      })

      assert.deepEqual(calls.filter(call => call.endpoint === "/extract").map(call => call.body.urls), [[failed.url], [healthy.url]])
      assert.equal(result.sources.length, 2)
      assertTavilyText(result.sources.find(source => source.url === failed.url), failed.content.slice(0, 1200))
      assertTavilyText(result.sources.find(source => source.url === healthy.url), "Independent relevant excerpt.", "extract")
      assert.equal(result.coverage[0].status, "partial")
      assert.equal(result.coverage[0].fetchedCount, 2)
      assert.match(result.coverage[0].error, /extraction (?:failed|incomplete)/)
      if (error) {
        assert.match(result.coverage[0].error, name === "request timeout" ? /request timed out/ : /HTTP 429/)
      }
      for (const privateText of ["secret-token", "PRIVATE_RESPONSE", "UNREQUESTED ARTICLE", "WRONG_REQUEST ARTICLE", "FAILED_EXCERPT", "UNEXPECTED SEARCH RAW ARTICLE", "Unrequested author"]) {
        assert.equal(JSON.stringify(result).includes(privateText), false)
      }
    })
  }
})

test("deduplicates TradingView IDs, caps stories/headlines and keeps explicit previews on errors", async () => {
  const calls = []
  const result = await collect({
    fetchNews: async () => ({ items: Array.from({ length: 31 }, (_, index) => news(String(index), { published: 1_800_000_000 - index })) }),
    fetchStory: async ({ id }) => {
      calls.push(id)
      if (id === "2") {
        throw new Error("upstream secret-token")
      }
      if (id === "1") {
        return { contentStatus: "preview", shortDescription: "Paywall preview", content: "Not a full available body" }
      }
      return { contentStatus: "full", content: "x".repeat(id === "0" ? 7_000 : 400), unknownContentNodeTypes: id === "3" ? ["unsupported"] : [] }
    },
  })

  assert.deepEqual(calls, ["0", "1", "2", "3", "4", "5"])
  assert.equal(result.sources.length, 30)
  assert.equal(result.coverage[1].status, "partial")
  assert.equal(result.coverage[1].fetchedCount, 30)
  assert.equal(result.sources[0].text.length, 6_000)
  assert.match(result.sources[0].text, /Truncated/)
  assert.equal(result.sources[1].text, "[Snippet only]\nPaywall preview")
  assert.equal(result.sources[2].text, "[Headline only]\nNews 2")
  assert.match(result.sources[3].text, /^\[Partial text\]/)
  assert.equal(result.sources[6].text, "[Headline only]\nNews 6")
  assert.equal(result.sources[0].author, null)
  assert.match(result.warnings.join(" "), /headlines capped at 30/)
  assert.match(result.warnings.join(" "), /full-story fetching capped at 6/)
  assert.equal(JSON.stringify(result).includes("secret-token"), false)
  assert.equal(JSON.stringify(result).includes("Not a full available body"), false)
})

test("a failed TradingView feed does not discard the other feed or its external article URL", async () => {
  const result = await collect({
    fetchNews: async ({ symbol }) => {
      if (symbol.includes("BTC")) {
        throw new Error("HTTP 500 private-response")
      }
      return { items: [news("eth", { tradingViewUrl: null, author: "Original writer" })] }
    },
  })

  assert.equal(result.coverage[1].status, "partial")
  assert.equal(result.sources[0].url, "https://publisher.example/news/eth")
  assert.equal(result.sources[0].author, "Original writer")
  assert.equal(result.sources[0].text, "[Headline only]\nNews eth")
  assert.match(result.coverage[1].error, /HTTP 500/)
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
  assert.equal(result.coverage[2].status, "partial")
  assert.equal(result.coverage[2].fetchedCount, 3)
  assert.match(result.coverage[2].error, /page 3 failed.*API error: 429/)
  assert.equal(JSON.stringify(result).includes("secret-token"), false)
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
  assert.equal(result.coverage[2].status, "partial")
  assert.match(result.warnings.join(" "), /capped at 3 pages/)
  assert.match(result.warnings.join(" "), /capped at 20 per page/)
  assert.match(result.warnings.join(" "), /not full 24-hour coverage/)
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
    assert.equal(result.coverage[2].status, "partial")
    assert.match(result.warnings.join(" "), /missing or repeated pagination cursor/)
  })
}

test("reports failed channels without leaking API errors and distinguishes empty successful samples", async () => {
  const result = await collect({
    requestTavily: async () => {
      throw new Error("Tavily /search API key is required secret-token")
    },
    fetchNews: async () => {
      throw { message: "private-response" }
    },
    fetchTweets: async () => ({ status: "error", tweets: [], error: "secret-token" }),
  })

  assert.deepEqual(result.sources, [])
  assert.deepEqual(result.coverage.map(source => [source.status, source.fetchedCount]), Array(3).fill(["failed", 0]))
  assert.ok(result.coverage.every(source => source.error))
  assert.equal(JSON.stringify(result).includes("secret-token"), false)
  assert.equal(JSON.stringify(result).includes("private-response"), false)
  const empty = await collect()
  assert.deepEqual(empty.coverage, ["tavily", "tradingview", "twitter"].map(source => ({ source, status: "empty", fetchedCount: 0, error: null })))
})

test("rejects invalid reference times and dependencies before requesting data", async () => {
  for (const referenceTimestamp of [0, -1, 1.5, NaN, Infinity, "1800000000", 9_000_000_000_000]) {
    await assert.rejects(collect({ referenceTimestamp }), /referenceTimestamp/)
  }
  await assert.rejects(collect({ wait: null }), /fetchers and wait must be functions/)
})
