import assert from "node:assert/strict"
import test from "node:test"
import { token_sort_ratio as similarity } from "fuzzball"

import { deduplicateMarketSources } from "../src/steps/step12.1-market-brief/deduplicate-market-sources.js"

function createSource (id, overrides = {}) {
  return {
    id: `source-${id}`,
    channel: "tavily",
    url: `https://example.com/news/${id}`,
    title: "Bitcoin ETF inflows reach record levels",
    text: "Full article text.",
    publishedAt: "2027-01-15T07:00:00.000Z",
    author: `Author ${id}`,
    ...overrides,
  }
}

function groupTitles (first, second) {
  return deduplicateMarketSources([
    createSource(1, { title: first }),
    createSource(2, { title: second, channel: "tradingview" }),
  ])
}

test("uses token_sort_ratio with an inclusive 95 threshold", () => {
  const title = "Bitcoin ETF inflows reach record levels"
  assert.equal(similarity(title, `The ${title}`), 95)
  assert.equal(groupTitles(title, `The ${title}`).length, 1)

  const shorter = "Bitcoin ETF inflows surge"
  assert.ok(similarity(shorter, `The ${shorter}`) < 95)
  assert.equal(groupTitles(shorter, `The ${shorter}`).length, 2)
})

test("merges punctuation, case and benign word order across news channels", () => {
  const groups = groupTitles(
    "Bitcoin, Ethereum: market liquidity improves",
    "Market liquidity improves — Bitcoin / Ethereum!",
  )

  assert.deepEqual(groups.map(group => group.sourceIds), [["source-1", "source-2"]])
  assert.equal(groups[0].id, "group-1")
  assert.equal(groupTitles("Éther: résumé du marché", "Résumé du marché — éther").length, 1)
})

test("keeps changed numbers, dates, signs, units and number associations separate", () => {
  for (const [first, second] of [
    ["Bitcoin ETF inflows reach $100 million today", "Bitcoin ETF inflows reach $101 million today"],
    ["Bitcoin ETF inflows reach $100 million today", "Bitcoin ETF inflows reach $100 billion today"],
    ["Bitcoin ETF inflows reach $100 million today", "Bitcoin ETF inflows reach €100 million today"],
    ["Bitcoin ETF inflows grow 5% today", "Bitcoin ETF inflows grow 5 today"],
    ["Bitcoin ETF inflows grow -5% today", "Bitcoin ETF inflows grow 5% today"],
    ["Bitcoin ETF inflows grow +5% today", "Bitcoin ETF inflows grow -5% today"],
    ["Bitcoin ETF inflows reach 1.5 billion", "Bitcoin ETF inflows reach 15 billion"],
    ["Bitcoin ETF inflows reach 1,500 million", "Bitcoin ETF inflows reach 1.500 million"],
    ["Bitcoin ETF launch 09/10/2026", "Bitcoin ETF launch 10/09/2026"],
    ["Bitcoin ETF launch September 29", "Bitcoin ETF launch October 29"],
    ["Bitcoin ETF inflows reach a record", "Bitcoin ETF inflows reach a record 5"],
    ["Bitcoin inflows 5 Ethereum inflows 10", "Bitcoin inflows 10 Ethereum inflows 5"],
  ]) {
    assert.equal(groupTitles(first, second).length, 2, `${first} / ${second}`)
  }
})

test("rejects near-identical names, negations and status changes even above 95 similarity", () => {
  const suffix = " after months of detailed market analysis and discussions with institutional cryptocurrency investors around the world and continued public consultations about the regulatory outlook for digital assets"

  for (const [first, second] of [
    ["SEC approved Bitcoin ETF", "SEC not approved Bitcoin ETF"],
    ["SEC approved Bitcoin ETF", "SEC denied Bitcoin ETF"],
    ["Exchange withdrawals suspended", "Exchange withdrawals resumed"],
    ["Exchange withdrawals enabled", "Exchange withdrawals disabled"],
    ["Bitcoin ETF launched", "Bitcoin ETF launching"],
    ["ARK Bitcoin ETF approved", "ART Bitcoin ETF approved"],
    ["Bitcoin ETF approved", "Litecoin ETF approved"],
    ["Bitcoin ETF is approved", "Bitcoin ETF is not approved"],
    ["A token is approved", "THE token is approved"],
  ]) {
    assert.ok(similarity(first + suffix, second + suffix) >= 95, `${first} / ${second}`)
    assert.equal(groupTitles(first + suffix, second + suffix).length, 2)
  }

  assert.equal(groupTitles("SEC approves Bitcoin ETF?", "SEC approves Bitcoin ETF").length, 2)
  assert.equal(groupTitles("SEC can't approve Bitcoin ETF", "SEC can approve Bitcoin ETF").length, 2)
  assert.equal(groupTitles("Bitcoin not Ethereum receives approval", "Ethereum not Bitcoin receives approval").length, 2)
  assert.equal(groupTitles("Binance acquires Coinbase", "Coinbase acquires Binance").length, 2)
  assert.equal(groupTitles("Withdrawals suspended deposits resumed", "Withdrawals resumed deposits suspended").length, 2)
})

test("uses complete short tweet text, never tweet headlines or cross-channel fuzzy matches", () => {
  const article = createSource(1, { title: "SEC approves Bitcoin ETF", text: "SEC approves Bitcoin ETF" })
  const tweet = createSource(2, { channel: "twitter", title: article.title, text: article.text })
  const changed = createSource(3, { channel: "twitter", title: article.title, text: `${article.text}, not Ethereum ETF` })
  const duplicate = createSource(4, { channel: "twitter", title: "Different preview", text: "Bitcoin ETF: SEC approves!" })
  const groups = deduplicateMarketSources([article, tweet, changed, duplicate])

  assert.deepEqual(groups.map(group => group.sourceIds), [["source-1"], ["source-2", "source-4"], ["source-3"]])

  for (const text of ["x".repeat(501), "[Partial text]\nSEC approves Bitcoin ETF", "[Truncated at 6000 characters]\nSEC approves Bitcoin ETF"]) {
    const sources = [1, 2].map(id => createSource(id, { channel: "twitter", text }))
    assert.equal(deduplicateMarketSources(sources).length, 2)
  }

  assert.equal(deduplicateMarketSources([1, 2].map(id => createSource(id, { channel: "twitter", text: "x".repeat(500) }))).length, 1)
})

test("normalizes exact URLs before fuzzy matching and preserves all source provenance", () => {
  const sources = Object.freeze([
    Object.freeze(createSource(1, {
      url: "HTTPS://Example.COM:443/news?id=7&b=2&utm_source=tavily#section",
      title: "Earlier headline",
      text: `[Snippet only]\n${"A long snippet. ".repeat(80)}`,
    })),
    Object.freeze(createSource(2, {
      channel: "tradingview",
      url: "https://example.com/news?fbclid=tracking&b=2&id=7",
      title: "Updated full headline",
      text: "Actual full article.",
      author: "Actual author",
    })),
  ])
  const original = structuredClone(sources)
  const groups = deduplicateMarketSources(sources)

  assert.deepEqual(groups, [{
    id: "group-1",
    title: "Updated full headline",
    text: "Actual full article.",
    sourceIds: ["source-1", "source-2"],
  }])
  assert.deepEqual(sources, original)
})

test("does not normalize meaningful URLs or merge empty/unsafe URL identities", () => {
  const urls = [
    "https://example.com/news?id=7",
    "https://example.com/news?id=8",
    "https://example.com/News?id=7",
    "https://example.com/news/?id=7",
    "http://example.com/news?id=7",
    "https://www.example.com/news?id=7",
    "https://example.com/news?id=7&ref=other-edition",
    "https://example.com/news?id=7&id=8",
    "https://example.com/news?id=8&id=7",
    "",
    "",
    "javascript:alert(1)",
    "javascript:alert(1)",
  ]
  const sources = urls.map((url, index) => createSource(index + 1, { url, title: `Edition ${index}` }))

  assert.equal(deduplicateMarketSources(sources).length, urls.length)
})

test("does not let exact URL updates create a fuzzy bridge to other articles", () => {
  const sources = [
    createSource(1, { title: "SEC approved Bitcoin ETF" }),
    createSource(2, { title: "SEC approved Bitcoin ETF" }),
    createSource(3, { url: "https://example.com/news/1", title: "SEC not approved Bitcoin ETF" }),
  ]

  assert.deepEqual(deduplicateMarketSources(sources).map(group => group.sourceIds), [
    ["source-1", "source-3"],
    ["source-2"],
  ])
})

test("chooses the richest full text with deterministic ties and returns empty groups for no sources", () => {
  const sources = [
    createSource(1, { text: "Short full article" }),
    createSource(2, { text: "Longer full article with more details" }),
    createSource(3, { text: "[Headline only]\n" + "Incomplete. ".repeat(100) }),
  ]
  const result = deduplicateMarketSources(sources)

  assert.equal(result[0].text, sources[1].text)
  assert.deepEqual(result[0].sourceIds, sources.map(source => source.id))
  assert.deepEqual(deduplicateMarketSources(sources), result)
  assert.deepEqual(deduplicateMarketSources([]), [])
  assert.throws(() => deduplicateMarketSources(null), /sources must be an array/)
})
