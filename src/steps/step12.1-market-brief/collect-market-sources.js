import { sleep } from "radash"

import { requestTavilyJson } from "../../api/tavily/request.js"
import { fetchTradingViewNews } from "../../api/tradingview/news.js"
import { fetchTradingViewNewsStory } from "../../api/tradingview/news-story.js"
import { fetchTweetPage } from "../../api/twitter-api.js"
import { isArray, isError, isFinite, isFunction, isObject, isSafeInteger } from "../../helpers/utils.typed.js"
import { normalizeSourceUrl, sourceAuthor, sourcePublishedAt, sourceString, sourceUrlKey } from "./source-normalization.js"

function createCollection (channel) {
  return { channel, sources: [], successes: 0, warnings: [], errors: [] }
}

function warn (collection, message) {
  collection.warnings.push(`${collection.channel}: ${message}`)
}

function fail (collection, label, error) {
  // Never propagate upstream error bodies, URLs, query text or credentials into a report.
  const reason = isError(error)
    ? error.message.match(/API key is required|request timed out|transport failure|invalid JSON|invalid response|HTTP \d{3}|API error: \d{3}/)?.[0]
    : null
  const message = `${label}: ${reason ?? "request failed"}`

  collection.errors.push(`${collection.channel}: ${message}`)
  warn(collection, message)
}

function readItems (response, field) {
  if (!isObject(response) || response.error || response.status === "error" || !isArray(response[field])) {
    throw new Error("invalid response")
  }

  return response[field]
}

async function fetchLists (collection, requests, field) {
  const results = await Promise.allSettled(requests.map(async request => readItems(await request(), field)))

  return results.flatMap((result, index) => {
    if (result.status === "rejected") {
      fail(collection, `request ${index + 1}`, result.reason)
      return []
    }

    collection.successes += 1
    return [result.value]
  })
}

function normalizeSource (collection, item, referenceTimestamp) {
  const publishedAt = sourcePublishedAt(item.publishedAt)

  if (!publishedAt) {
    warn(collection, "missing, ambiguous or invalid publication time; item omitted")
    return null
  }

  const timestamp = Date.parse(publishedAt) / 1_000

  if (timestamp < referenceTimestamp - 24 * 60 * 60 || timestamp > referenceTimestamp) {
    return null
  }

  const url = normalizeSourceUrl(item.url)
  const title = sourceString(item.title).replace(/\s+/g, " ")

  if (!url || !title) {
    warn(collection, "missing title/text or unsafe URL; item omitted")
    return null
  }

  return {
    channel: collection.channel,
    url,
    title,
    text: "",
    publishedAt,
    author: sourceAuthor(item.author),
    publisher: sourceString(item.publisher?.name ?? item.publisher).replace(/\s+/g, " ")
      || (collection.channel === "tavily" ? new URL(url).hostname : null),
  }
}

function formatText (collection, full, snippet, title, partial = false) {
  const text = full || snippet || title
  const notes = []

  if (!full) {
    notes.push(snippet ? "Snippet only" : "Headline only")
    warn(collection, "headline/snippet only for some items; full article text unavailable")
  } else if (partial || /(?:…|\.{3}|\[truncated\])$/i.test(full)) {
    notes.push("Partial text")
    warn(collection, "some text is incomplete at the source")
  }

  if (text.length + notes.map(note => `[${note}]\n`).join("").length > 6_000) {
    notes.push("Truncated at 6000 characters")
    warn(collection, "text capped at 6000 characters per item")
  }

  const prefix = notes.map(note => `[${note}]\n`).join("")
  return prefix + text.slice(0, Math.max(0, 6_000 - prefix.length))
}

function compareSources (first, second) {
  return second.publishedAt.localeCompare(first.publishedAt)
    || first.url.localeCompare(second.url)
    || first.title.localeCompare(second.title)
    || (first.author ?? "").localeCompare(second.author ?? "")
    || first.text.localeCompare(second.text)
}

function needsTavilyExtract ({ source, snippet }) {
  const text = snippet.slice(0, 1200)
  const titleWords = [...new Set(source.title.toLowerCase().match(/\p{L}{5,}/gu) ?? [])]
  const snippetWords = new Set(text.toLowerCase().match(/\p{L}+/gu) ?? [])

  // Approximate missing context in the retained snippet, not event importance or truthfulness.
  return text.length < 300
    || /\b(?:prediction banner|read more|next read|also read|copy link|share on|stock screeners|privacy policy|terms of (?:use|service)|all categories|market data api|add to preferred sources|crypto regulation hub|deep dives|advertisement)\b/i.test(text)
    || (titleWords.length >= 3 && titleWords.filter(word => snippetWords.has(word)).length < titleWords.length / 3)
}

function formatTavilyText (collection, { source, snippet }, excerpt) {
  const content = excerpt?.text || snippet || source.title
  const limit = excerpt ? 1800 : 1200
  const notes = [
    excerpt || snippet ? "Snippet only" : "Headline only",
    excerpt ? "Extract: two relevant fragments, not the full article" : "Search snippet, not the full article",
  ]
  if (content.length > limit) {
    notes.push(`Truncated at ${limit} characters`)
    warn(collection, `text capped at ${limit} characters per ${excerpt ? "extract" : "search snippet"}`)
  }
  return notes.map(note => `[${note}]\n`).join("") + content.slice(0, limit)
}

async function fetchTavilyExcerpts (collection, { source, key, snippet }, request) {
  try {
    const response = await request("/extract", {
      urls: [source.url],
      query: `${source.title.slice(0, 240)}. Key facts, dates, amounts and what happened.`,
      chunks_per_source: 2,
      extract_depth: "advanced",
      format: "text",
      include_images: false,
      timeout: 30,
    }, { timeoutMs: 45_000 })
    const items = readItems(response, "results")
    const failed = response.failed_results ?? []
    const item = items.find(item => sourceUrlKey(item?.url) === key)
    if (
      !isArray(failed) || failed.some(item => sourceUrlKey(item?.url) === key)
      || !item || item.error || !sourceString(item.raw_content)
    ) {
      fail(collection, "extraction incomplete; search snippet retained")
      return null
    }
    return [key, { text: sourceString(item.raw_content), author: sourceAuthor(item.author ?? item.authors), snippet }]
  } catch (error) {
    fail(collection, "extraction failed; search snippet retained", error)
    return null
  }
}

async function collectTavily (referenceTimestamp, request) {
  const collection = createCollection("tavily")
  const lists = await fetchLists(collection, [
    "crypto market Bitcoin BTC Ethereum ETH major news today",
    "crypto macro economy Federal Reserve interest rates ETF SEC regulation today",
    "major crypto exchange hack exploit depeg outage liquidation incident today",
  ].map(query => () => request("/search", {
    query,
    topic: "news",
    time_range: "day",
    search_depth: "basic",
    max_results: 5,
    include_answer: false,
    include_raw_content: false,
    include_images: false,
    auto_parameters: false,
  })), "results")
  const records = lists.flatMap((items) => {
    if (items.length >= 5) {
      warn(collection, "search capped at 5 results per query; coverage may be incomplete")
    }

    return items.slice(0, 5).flatMap((item) => {
      const source = normalizeSource(collection, {
        url: item?.url,
        title: item?.title,
        publishedAt: item?.published_date ?? item?.publishedAt,
        author: item?.author ?? item?.authors,
        publisher: item?.publisher,
      }, referenceTimestamp)

      return source
        ? [{ source, key: sourceUrlKey(source.url), snippet: sourceString(item.content), score: isFinite(item.score) ? item.score : 0 }]
        : []
    })
  })
  const byUrl = new Map()
  for (const record of [...records].sort((first, second) => second.score - first.score || compareSources(first.source, second.source))) {
    const group = byUrl.get(record.key) ?? []
    group.push(record)
    byUrl.set(record.key, group)
  }
  const selected = [...byUrl.values()]
    .filter(group => group.every(needsTavilyExtract))
    .map(group => group[0])
  if (selected.length > 2) {
    warn(collection, "extraction capped at 2 URLs; other items retain search snippets")
  }
  if (records.length) {
    warn(collection, "only search snippets and targeted extract excerpts; full articles not fetched")
  }
  const extracted = new Map((await Promise.all(selected.slice(0, 2)
    .map(record => fetchTavilyExcerpts(collection, record, request)))).filter(Boolean))

  collection.sources = records.map((record) => {
    const result = extracted.get(record.key)
    // Reuse an extraction only for identical snippets; other versions may contain corrections.
    const excerpt = result?.snippet === record.snippet ? result : null
    return {
      ...record.source,
      author: record.source.author ?? excerpt?.author ?? null,
      text: formatTavilyText(collection, record, excerpt),
    }
  })

  return collection
}

async function collectTradingView (referenceTimestamp, fetchNews, fetchStory) {
  const collection = createCollection("tradingview")
  const lists = await fetchLists(collection, ["BINANCE:BTCUSDT.P", "BINANCE:ETHUSDT.P"]
    .map(symbol => () => fetchNews({ symbol })), "items")
  const recordsById = new Map()

  for (const item of lists.flat()) {
    const id = sourceString(item?.id)
    const storyUrl = normalizeSourceUrl(item?.tradingViewUrl)
    const source = normalizeSource(collection, {
      url: normalizeSourceUrl(item?.externalUrl) ?? storyUrl,
      title: item?.title,
      publishedAt: item?.publishedAt ?? item?.published,
      author: item?.author ?? item?.authors,
      publisher: item?.provider?.name,
    }, referenceTimestamp)

    if (!source) {
      continue
    }

    if (!id) {
      warn(collection, "missing story id; item omitted")
      continue
    }

    if (!recordsById.has(id)) {
      recordsById.set(id, { id, source, storyUrl, snippet: sourceString(item.shortDescription ?? item.description) })
    }
  }

  const records = [...recordsById.values()].sort((first, second) => compareSources(first.source, second.source))

  if (records.length > 30) {
    warn(collection, "headlines capped at 30 recent stories")
  }

  const selected = records.slice(0, 30)
  const readable = selected.filter(record => record.storyUrl?.startsWith("https://www.tradingview.com/news/"))

  if (readable.length > 6) {
    warn(collection, "full-story fetching capped at 6 recent stories")
  }

  const stories = await Promise.allSettled(readable.slice(0, 6).map(async ({ id, storyUrl }) => {
    const story = await fetchStory({ id, url: storyUrl })

    if (!isObject(story)) {
      throw new Error("invalid response")
    }

    return story
  }))
  const storiesById = new Map()

  stories.forEach((result, index) => {
    if (result.status === "fulfilled") {
      storiesById.set(readable[index].id, result.value)
    } else {
      fail(collection, "story fetch failed; headline/snippet retained", result.reason)
    }
  })

  collection.sources = selected.map(({ id, source, snippet }) => {
    const story = storiesById.get(id)
    const full = story?.contentStatus === "full" ? sourceString(story.content) : ""
    const partial = Boolean(story?.contentError || story?.unknownContentNodeTypes?.length)

    return {
      ...source,
      author: source.author ?? sourceAuthor(story?.author ?? story?.authors),
      text: formatText(collection, full, sourceString(story?.shortDescription) || snippet, source.title, partial),
    }
  })

  return collection
}

function tweetUrl (tweet) {
  const url = normalizeSourceUrl(tweet?.url)
  const id = sourceString(tweet?.id) || (isSafeInteger(tweet?.id) && tweet.id > 0 ? String(tweet.id) : "")
  const username = sourceString(tweet?.author?.userName)

  if (url || !id) {
    return url
  }

  return /^[a-z0-9_]{1,15}$/i.test(username)
    ? `https://x.com/${username}/status/${encodeURIComponent(id)}`
    : `https://x.com/i/web/status/${encodeURIComponent(id)}`
}

async function collectTwitter (referenceTimestamp, fetchTweets, wait) {
  const collection = createCollection("twitter")
  const query = [
    "(crypto OR bitcoin OR ethereum)",
    "(ETF OR SEC OR Fed OR regulation OR hack OR exploit OR depeg OR outage OR liquidation)",
    "lang:en -filter:retweets -filter:replies",
    `since_time:${referenceTimestamp - 24 * 60 * 60}`,
    // The API's upper boundary is exclusive; local validation includes the reference second.
    `until_time:${referenceTimestamp + 1}`,
  ].join(" ")
  const cursors = new Set()
  const tweetsById = new Map()
  let cursor = ""

  for (let pageNumber = 1; pageNumber <= 3; pageNumber += 1) {
    let page
    let tweets

    try {
      if (pageNumber > 1) {
        await wait(300)
      }

      page = await fetchTweets(query, cursor)
      tweets = readItems(page, "tweets")
      collection.successes += 1
    } catch (error) {
      fail(collection, `page ${pageNumber} failed; earlier pages retained`, error)
      break
    }

    if (tweets.length > 20) {
      warn(collection, "tweets capped at 20 per page")
    }

    for (const tweet of tweets.slice(0, 20)) {
      const text = sourceString(tweet?.text)
      const source = normalizeSource(collection, {
        url: tweetUrl(tweet),
        title: text.slice(0, 240),
        publishedAt: tweet?.createdAt,
        author: sourceString(tweet?.author?.userName) || sourceAuthor(tweet?.author),
      }, referenceTimestamp)

      if (source) {
        source.text = formatText(collection, text, "", source.title, tweet?.isTruncated === true)
        const id = sourceString(tweet?.id) || source.url

        if (!tweetsById.has(id) || tweetsById.get(id).text.length < source.text.length) {
          tweetsById.set(id, source)
        }
      }
    }

    const nextCursor = sourceString(page.next_cursor)

    if (page.has_next_page === false || (!nextCursor && page.has_next_page !== true)) {
      break
    }

    if (!nextCursor || cursors.has(nextCursor)) {
      warn(collection, "missing or repeated pagination cursor; remaining pages unavailable")
      break
    }

    if (pageNumber === 3) {
      warn(collection, "Latest search capped at 3 pages; remaining tweets not fetched")
      break
    }

    cursors.add(nextCursor)
    cursor = nextCursor
  }

  collection.sources = [...tweetsById.values()]
  return collection
}

export async function collectMarketSources ({
  referenceTimestamp = Math.floor(Date.now() / 1_000),
  requestTavily = requestTavilyJson,
  fetchNews = fetchTradingViewNews,
  fetchStory = fetchTradingViewNewsStory,
  fetchTweets = fetchTweetPage,
  wait = sleep,
} = {}) {
  if (
    !isSafeInteger(referenceTimestamp)
    || referenceTimestamp <= 0
    || !isFinite(new Date(referenceTimestamp * 1_000).getTime())
  ) {
    throw new Error("Market brief referenceTimestamp must be a positive Unix timestamp")
  }

  if (![requestTavily, fetchNews, fetchStory, fetchTweets, wait].every(isFunction)) {
    throw new Error("Market brief fetchers and wait must be functions")
  }

  const collections = await Promise.all([
    collectTavily(referenceTimestamp, requestTavily),
    collectTradingView(referenceTimestamp, fetchNews, fetchStory),
    collectTwitter(referenceTimestamp, fetchTweets, wait),
  ])

  return {
    from: new Date((referenceTimestamp - 24 * 60 * 60) * 1_000).toISOString(),
    asOf: new Date(referenceTimestamp * 1_000).toISOString(),
    sources: collections.flatMap(collection => collection.sources.sort(compareSources))
      .map((source, index) => ({ id: `source-${index + 1}`, ...source })),
    coverage: collections.map(collection => ({
      source: collection.channel,
      status: collection.successes === 0
        ? "failed"
        : collection.warnings.length > 0
          ? "partial"
          : collection.sources.length > 0 ? "available" : "empty",
      fetchedCount: collection.sources.length,
      error: [...new Set(collection.errors)].join("; ") || null,
    })),
    warnings: [...new Set([
      ...collections.flatMap(collection => collection.warnings),
      "twitter: bounded Latest keyword sample, not full 24-hour coverage; absence of tweets is not absence of events",
    ])],
  }
}
