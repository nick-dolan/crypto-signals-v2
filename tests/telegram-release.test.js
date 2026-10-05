import assert from "node:assert/strict"
import http from "node:http"
import https from "node:https"
import test, { beforeEach } from "node:test"

import { isArray, isObject } from "../src/helpers/utils.typed.js"
import { buildTelegramRelease, selectTelegramCandidates } from "../src/reports/telegram/build-telegram-release.js"
import { reportTime, reportTitleTime, signalText, telegramLink, telegramRichMessage, telegramText } from "../src/reports/telegram/telegram-format.js"

beforeEach((t) => {
  const requests = [[globalThis, "fetch"], [http, "request"], [http, "get"], [https, "request"], [https, "get"]]
    .map(([target, method]) => t.mock.method(target, method, () => assert.fail("Unexpected network request")))
  t.after(() => requests.forEach(request => assert.equal(request.mock.callCount(), 0)))
})

function coin (symbol, overrides = {}) {
  return {
    symbol, baseCurrencyId: `XTVC${symbol}`, name: `Монета ${symbol}`, marketSymbol: `BINANCE:${symbol}USDT.P`,
    topRank: null, movementProbability: 0.5, socialSignificant: false, socialSentiment: null,
    technicalExplanation: "Техническое наблюдение.", explanation: "Обогащённое наблюдение.", ...overrides,
  }
}

function fixture (coins = [], overrides = {}) {
  return {
    asOf: "2026-09-30T23:00:00.000Z", timeframe: "1h", reportCreatedAt: "2026-10-01T07:45:00.000Z",
    coins, ...overrides,
  }
}

function brief (overrides = {}) {
  return {
    schemaVersion: 5, marketAsOf: "2026-09-30T23:00:00.000Z", status: "available",
    from: "2026-10-01T00:30:00.000Z", asOf: "2026-10-01T06:30:00.000Z",
    items: [{ title: "Сводка рынка", text: "Сохранённое событие.", sentiment: "neutral", sourceIds: [] }],
    sources: [], ...overrides,
  }
}

function deepFreeze (value) {
  if (isArray(value) || isObject(value)) {
    Object.values(value).forEach(deepFreeze)
    Object.freeze(value)
  }
  return value
}

function visibleText (html) {
  return html.replace(/<[^>]*>/gu, "")
    .replace(/&(amp|lt|gt|quot);/gu, (_, name) => ({ amp: "&", lt: "<", gt: ">", quot: "\"" })[name])
}

function links (html) {
  return [...html.matchAll(/<a\b[^>]*\bhref="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gu)]
    .map(([, href, label]) => ({ href: visibleText(href), label: visibleText(label) }))
}

test("selection preserves top priority and stable ranks, sorts significant news and deduplicates symbols and IDs", () => {
  const report = deepFreeze(fixture([
    coin("TOP-B", { topRank: 2, movementProbability: 0.1 }),
    coin("NEWS-NEG", { socialSignificant: true, socialSentiment: "negative", movementProbability: 0.8 }),
    coin("TOP-A", { topRank: 1, socialSignificant: true, socialSentiment: "positive" }),
    coin(" top-a ", { socialSignificant: true, socialSentiment: "positive", movementProbability: 1 }),
    coin("ALIAS", { baseCurrencyId: " XTVCTOP-B ", socialSignificant: true, socialSentiment: "positive" }),
    coin("TOP-C", { topRank: 2, movementProbability: 1 }),
    coin("NEWS-POS", { socialSignificant: true, socialSentiment: "positive", movementProbability: 0.9 }),
    coin("NEWS-TIE", { socialSignificant: true, socialSentiment: "negative", movementProbability: 0.8 }),
    coin("NEWS-UNKNOWN", { socialSignificant: true, socialSentiment: "negative", movementProbability: null }),
    coin("PROBABILITY-ONLY", { movementProbability: 1 }),
    coin("TRENDING-ONLY", { features: { coingeckoTrending: true } }),
    coin("MIXED", { socialSignificant: true, socialSentiment: "mixed" }),
    coin("NEUTRAL", { socialSignificant: true, socialSentiment: "neutral" }),
    coin("TRUTHY", { socialSignificant: "true", socialSentiment: "positive" }),
    coin("INVALID-RANK", { topRank: "1" }),
  ]))
  const before = structuredClone(report)
  const selection = selectTelegramCandidates(report)
  assert.deepEqual(selection.candidates.map(item => [item.coin.symbol, item.section, item.coinIndex]), [
    ["TOP-A", "top", 2], ["TOP-B", "top", 0], ["TOP-C", "top", 5],
    ["NEWS-POS", "news", 6], ["NEWS-NEG", "news", 1], ["NEWS-TIE", "news", 7], ["NEWS-UNKNOWN", "news", 8],
  ])
  assert.equal(selection.eligibleCount, 7)
  assert.equal(selection.omittedCount, 0)
  assert.deepEqual(report, before)
})

test("release keeps every selected coin, binds media to safe unique paths and does not mutate or leak source data", () => {
  const report = deepFreeze(fixture([
    ...["../A", "A/B", "A?B", ...Array.from({ length: 9 }, (_, index) => `COIN-${index}`)]
      .map((symbol, index) => coin(symbol, { topRank: index + 1, technicalExplanation: "Наблюдение. ".repeat(70) })),
    coin("NEWS", { socialSignificant: true, socialSentiment: "negative" }),
    coin("PRIVATE-UNSELECTED", { movementProbability: 1 }),
  ], { marketBrief: brief(), token: "PRIVATE-TOKEN", history: { secret: "PRIVATE-HISTORY" } }))
  const before = structuredClone(report)
  const release = buildTelegramRelease(report)
  assert.equal(release.schemaVersion, 2)
  assert.equal(release.asOf, report.asOf)
  assert.equal(release.closedAt, "2026-10-01T00:00:00.000Z")
  assert.equal(release.candidates.length, 13)
  assert.equal(release.eligibleCount, 13)
  assert.equal(release.omittedCount, 0)
  assert.equal(new Set(release.candidates.map(item => item.image)).size, 13)
  assert.equal(new Set(release.candidates.map(item => item.mediaId)).size, 13)
  for (const item of release.candidates) {
    assert.equal(item.symbol, report.coins[item.coinIndex].symbol)
    assert.match(item.image, /^cards\/\d{2}-[a-z\d_-]{1,40}\.png$/iu)
  }
  assert.deepEqual(release.richMessage.media, release.candidates.map(item => ({
    id: item.mediaId, media: { type: "photo", media: `attach://${item.mediaId}` },
  })))
  assert.deepEqual([...release.richMessage.html.matchAll(/tg:\/\/photo\?id=([^"<>]+)/gu)].map(([, id]) => id),
    release.candidates.map(item => item.mediaId))
  const text = visibleText(release.richMessage.html)
  assert.ok([...text].length > 4_096)
  assert.ok(text.includes("Сохранённое событие."))
  assert.doesNotMatch(JSON.stringify(release), /PRIVATE-/u)
  assert.deepEqual(buildTelegramRelease(report), release)
  assert.deepEqual(report, before)
})

test("release HTML preserves section order, item spacing, collage and warning placement", () => {
  const report = fixture([
    coin("TOP-A", { topRank: 1 }),
    coin("TOP-B", { topRank: 2 }),
    coin("NEWS-A", { socialSignificant: true, socialSentiment: "positive" }),
    coin("NEWS-B", { socialSignificant: true, socialSentiment: "negative" }),
  ], { demo: true, marketBrief: brief({
    items: [
      { title: "Событие A", text: "Первая новость.", sentiment: "bullish", sourceIds: ["a"] },
      { title: "Пропущено", text: " " },
      { text: "Вторая новость.", sentiment: "bearish", sourceIds: ["a"] },
    ],
    sources: [{ id: "a", url: "https://news.example/a" }],
    warning: "Неполные данные.",
  }) })
  assert.equal(buildTelegramRelease(report).richMessage.html, [
    "<p><b>📊 Крипторадар | 1 октября 2026, 10:45 МСК</b></p>",
    "<tg-collage><img src=\"tg://photo?id=card_1\"/><img src=\"tg://photo?id=card_2\"/><img src=\"tg://photo?id=card_3\"/><img src=\"tg://photo?id=card_4\"/></tg-collage>",
    "<p><b>Монеты под наблюдением</b></p>",
    "<p><br></p>",
    "<p><b>TOP-A</b> · <b>Монета TOP-A</b><br>Техническое наблюдение.</p>",
    "<p><br></p>",
    "<p><b>TOP-B</b> · <b>Монета TOP-B</b><br>Техническое наблюдение.</p>",
    "<p><br></p>",
    "<p><b>📰 Значимые инфоповоды</b></p>",
    "<p><br></p>",
    "<p><b>NEWS-A</b> · <b>Монета NEWS-A</b><br>Обогащённое наблюдение.</p>",
    "<p><br></p>",
    "<p><b>NEWS-B</b> · <b>Монета NEWS-B</b><br>Обогащённое наблюдение.</p>",
    "<p><br></p>",
    "<p><b>Новости за последние 6 часов</b></p>",
    "<p><br></p>",
    "<p>• <b>Событие A</b><br>Первая новость. 🚀 <a href=\"https://news.example/a\">[1]</a></p>",
    "<p><br></p>",
    "<p>• Вторая новость. 📉 <a href=\"https://news.example/a\">[1]</a></p>",
    "<p>⚠ Неполные данные.</p>",
  ].join("\n"))
})

test("single-candidate HTML has no collage, extra separators or empty explanation line", () => {
  for (const section of ["top", "news"]) {
    const report = fixture([coin("ONLY", {
      name: null, technicalExplanation: "", explanation: "",
      topRank: section === "top" ? 1 : null,
      socialSignificant: section === "news", socialSentiment: "positive",
    })])
    assert.equal(buildTelegramRelease(report).richMessage.html, [
      "<p><b>📊 Крипторадар | 1 октября 2026, 10:45 МСК</b></p>",
      "<img src=\"tg://photo?id=card_1\"/>",
      "<p><b>Монеты под наблюдением</b></p>",
      "<p><br></p>",
      ...(section === "news"
        ? [
            "<p>Агент не выделил убедительных ранних кандидатов.</p>",
            "<p><br></p>",
            "<p><b>📰 Значимые инфоповоды</b></p>",
            "<p><br></p>",
          ]
        : []),
      "<p><b>ONLY</b></p>",
      "<p><br></p>",
      "<p><b>Новости</b></p>",
      "<p><br></p>",
      "<p>Сводка недоступна или относится к другому срезу. Отсутствие данных не означает отсутствие событий.</p>",
    ].join("\n"))
  }
})

test("empty releases invent neither candidates nor media", () => {
  const release = buildTelegramRelease(fixture())
  assert.deepEqual(release.candidates, [])
  assert.deepEqual(release.richMessage.media, [])
  assert.equal(release.eligibleCount, 0)
  assert.equal(release.richMessage.html, [
    "<p><b>📊 Крипторадар | 1 октября 2026, 10:45 МСК</b></p>",
    "<p><br></p>",
    "<p><b>Монеты под наблюдением</b></p>",
    "<p><br></p>",
    "<p>Агент не выделил убедительных ранних кандидатов.</p>",
    "<p><br></p>",
    "<p><b>Новости</b></p>",
    "<p><br></p>",
    "<p>Сводка недоступна или относится к другому срезу. Отсутствие данных не означает отсутствие событий.</p>",
  ].join("\n"))
})

test("invalid snapshots and candidate lists are rejected", () => {
  for (const overrides of [{ asOf: "invalid" }, { asOf: "2026-10-01T00:01:00Z" }, { timeframe: "4h" }]) {
    assert.throws(() => buildTelegramRelease(fixture([], overrides)))
  }
  for (const coins of [null, {}, [null], [{ symbol: " " }], [{ symbol: 42 }]]) {
    assert.throws(() => selectTelegramCandidates({ coins }))
  }
})

test("structured summaries use social prose only for explicit significance, without caveats or raw evidence", () => {
  for (const socialSignificant of [true, false, null, "true"]) {
    const report = deepFreeze(fixture([coin("TEST", {
      topRank: 1, socialSignificant,
      technicalSummary: { observation: "TECH-OBSERVATION", caveat: "TECH-CAVEAT" },
      summary: { observation: "SOCIAL-OBSERVATION", caveat: "SOCIAL-CAVEAT" },
      technicalExplanation: "PRIVATE-LEGACY", explanation: "PRIVATE-ENRICHED", socialReason: "PRIVATE-REASON",
      drivers: ["PRIVATE-DRIVER"], counterSignals: ["PRIVATE-COUNTER"],
      information: { news: { error: "PRIVATE-SOURCE" } }, history: { warning: "PRIVATE-HISTORY" },
    })]))
    const text = visibleText(buildTelegramRelease(report).richMessage.html)
    const expected = socialSignificant === true ? "SOCIAL" : "TECH"
    assert.ok(text.includes(`${expected}-OBSERVATION`))
    assert.doesNotMatch(text, /CAVEAT|Оговорка:/u)
    assert.ok(!text.includes(socialSignificant === true ? "TECH-" : "SOCIAL-"))
    assert.doesNotMatch(text, /PRIVATE-/u)
  }
})

test("missing structured observations use only the appropriate legacy prose or significant social reason", () => {
  for (const [overrides, expected] of [
    [{}, "TECH-LEGACY"],
    [{ socialSignificant: true }, "SOCIAL-LEGACY"],
    [{ socialSignificant: true, explanation: "" }, "SOCIAL-REASON"],
    [{ technicalExplanation: undefined }, null],
    [{ socialSignificant: true, explanation: null, socialReason: null }, null],
  ]) {
    const report = fixture([coin("TEST", {
      topRank: 1, technicalExplanation: "TECH-LEGACY", explanation: "SOCIAL-LEGACY", socialReason: "SOCIAL-REASON",
      technicalSummary: { observation: "", caveat: "PRIVATE-CAVEAT" },
      summary: { observation: null, caveat: "PRIVATE-CAVEAT" }, counterSignals: ["PRIVATE-COUNTER"], ...overrides,
    })])
    const text = visibleText(buildTelegramRelease(report).richMessage.html)
    for (const value of ["TECH-LEGACY", "SOCIAL-LEGACY", "SOCIAL-REASON"]) {
      assert.equal(text.includes(value), value === expected)
    }
    assert.doesNotMatch(text, /PRIVATE-/u)
  }
})

test("missing caveats are not reconstructed from observations or counter-signals", () => {
  const observation = "Наблюдение, но не обещание результата."
  const report = fixture([coin("TEST", {
    topRank: 1, technicalSummary: { observation, caveat: null }, counterSignals: ["PRIVATE-COUNTER"],
  })])
  const text = visibleText(buildTelegramRelease(report).richMessage.html)
  assert.equal(text.split(observation).length - 1, 1)
  assert.doesNotMatch(text, /PRIVATE-/u)
})

test("market links use encoded symbols and are omitted for missing markets or demo reports", () => {
  const marketSymbol = "BINANCE:BTC/USDT.P?x=1&y=2"
  const report = fixture([coin("TEST", { topRank: 1, marketSymbol })])
  assert.deepEqual(links(buildTelegramRelease(report).richMessage.html), [{
    href: `https://www.tradingview.com/chart/?symbol=${encodeURIComponent(marketSymbol)}`, label: "Монета TEST",
  }])
  const demo = buildTelegramRelease({ ...report, demo: true })
  assert.equal(demo.demo, true)
  assert.deepEqual(links(demo.richMessage.html), [])
  const missing = fixture([coin("TEST", { topRank: 1, marketSymbol: null })])
  assert.deepEqual(links(buildTelegramRelease(missing).richMessage.html), [])
})

test("news keeps stored content, its item cap and source-based citations while discarding unsafe or unknown sources", () => {
  const report = deepFreeze(fixture([], { marketBrief: brief({
    items: [
      { title: "FIRST-TITLE", text: "FIRST-TEXT", sourceIds: ["missing", "unsafe", "b", "b", "a", "c"] },
      { title: "SECOND-TITLE", text: "SECOND-TEXT", sourceIds: ["c", "b"] },
      { text: "THIRD-TEXT", sourceIds: ["a"] },
      { title: "PRIVATE-EMPTY", text: " \n\t", sourceIds: ["unused"] },
      { text: "FIFTH-TEXT", sourceIds: ["missing"] },
      { title: "PRIVATE-SIXTH", text: "PRIVATE-SIXTH", sourceIds: ["unused"] },
    ],
    sources: [
      ...["a", "b", "c", "unused"].map(id => ({ id, url: `https://news.example/${id}?x=1&y=2`, title: "PRIVATE-SOURCE-TITLE" })),
      { id: "unsafe", url: "javascript:alert(1)" },
    ],
  }) }))
  const before = structuredClone(report)
  const { html } = buildTelegramRelease(report).richMessage
  const text = visibleText(html)
  for (const value of ["FIRST-TITLE", "FIRST-TEXT", "SECOND-TITLE", "SECOND-TEXT", "THIRD-TEXT", "FIFTH-TEXT"]) {
    assert.ok(text.includes(value))
  }
  assert.deepEqual(links(html), [
    { href: "https://news.example/b?x=1&y=2", label: "[1]" },
    { href: "https://news.example/a?x=1&y=2", label: "[2]" },
    { href: "https://news.example/c?x=1&y=2", label: "[3]" },
    { href: "https://news.example/b?x=1&y=2", label: "[1]" },
    { href: "https://news.example/a?x=1&y=2", label: "[2]" },
  ])
  assert.doesNotMatch(html, /PRIVATE-|javascript:|unused/u)
  assert.deepEqual(report, before)
})

test("news sentiment comes only from explicit stored labels, even without usable sources", () => {
  for (const [sentiment, expected] of [
    ["bullish", ["🚀"]], ["bearish", ["📉"]], ["neutral", []], [undefined, []], ["constructor", []], [["bullish"], []],
  ]) {
    const report = fixture([], { marketBrief: brief({ items: [
      { text: "Новость о росте и падении.", sentiment, sourceIds: ["missing"] },
      { text: "", sentiment: "bullish", sourceIds: [] },
    ] }) })
    const { html } = buildTelegramRelease(report).richMessage
    assert.deepEqual(html.match(/[🚀📉]/gu) ?? [], expected)
    assert.deepEqual(links(html), [])
  }
})

test("archived brief schemas retain their own content and do not acquire inferred titles or sentiment", () => {
  for (const [schemaVersion, content, expected, emoji] of [
    [1, { events: [{ title: "ARCHIVE-TITLE", summary: "ARCHIVE-TEXT", whyItMatters: "ARCHIVE-REASON", verification: "unconfirmed", sourceIds: ["s"] }] }, ["ARCHIVE-TITLE", "ARCHIVE-TEXT", "ARCHIVE-REASON", "Не подтверждено"], []],
    [2, { paragraphs: [{ text: "ARCHIVE-TEXT", sourceIds: ["s"] }] }, ["ARCHIVE-TEXT"], []],
    [3, { items: [{ text: "ARCHIVE-TEXT", sentiment: "bullish", sourceIds: ["s"] }] }, ["ARCHIVE-TEXT"], []],
    [4, { items: [{ text: "ARCHIVE-TEXT", sentiment: "bearish", sourceIds: ["s"] }] }, ["ARCHIVE-TEXT"], ["📉"]],
  ]) {
    const report = fixture([], { marketBrief: brief({
      schemaVersion, items: [{ title: "PRIVATE-WRONG-SCHEMA", text: "PRIVATE-WRONG-SCHEMA" }], ...content,
      sources: [{ id: "s", url: "https://news.example/archive", title: "PRIVATE-SOURCE-TITLE" }],
    }) })
    const { html } = buildTelegramRelease(report).richMessage
    const text = visibleText(html)
    expected.forEach(value => assert.ok(text.includes(value)))
    assert.deepEqual(links(html), [{ href: "https://news.example/archive", label: "[1]" }])
    assert.deepEqual(html.match(/[🚀📉]/gu) ?? [], emoji)
    assert.doesNotMatch(text, /PRIVATE-/u)
  }
})

test("missing, unsupported or mismatched briefs never expose stale content and sources", () => {
  for (const marketBrief of [undefined, brief({ schemaVersion: 99 }), brief({ marketAsOf: "2000-01-01T00:00:00Z" })]) {
    const report = fixture([], { marketBrief: marketBrief && {
      ...marketBrief, items: [{ title: "PRIVATE-STALE", text: "PRIVATE-STALE", sourceIds: ["s"] }],
      sources: [{ id: "s", url: "https://news.example/PRIVATE-STALE" }], warning: "PRIVATE-STALE",
    } })
    const { html } = buildTelegramRelease(report).richMessage
    assert.doesNotMatch(html, /PRIVATE-/u)
    assert.deepEqual(links(html), [])
    assert.match(visibleText(html), /недоступна/u)
  }
})

test("partial briefs retain available news and warnings; empty and unavailable briefs do not publish saved items", () => {
  for (const [status, hasContent] of [["partial", true], ["empty", false], ["unavailable", false]]) {
    const report = fixture([], { marketBrief: brief({
      status, warning: "PUBLIC-WARNING", items: [{ text: "SAVED-NEWS", sourceIds: [] }],
      coverage: [{ source: "twitter", error: "PRIVATE-ERROR" }],
    }) })
    const text = visibleText(buildTelegramRelease(report).richMessage.html)
    assert.equal(text.includes("SAVED-NEWS"), hasContent)
    assert.ok(text.includes("PUBLIC-WARNING"))
    assert.doesNotMatch(text, /PRIVATE-/u)
  }
})

test("news truncation budgets plain text and does not split Unicode or escaped entities", () => {
  for (const [text, expected] of [
    ["\"".repeat(250), "\"".repeat(250)],
    ["🙂".repeat(126), `${"🙂".repeat(124)}…`],
    ["а".repeat(251), `${"а".repeat(249)}…`],
  ]) {
    const report = fixture([], { marketBrief: brief({
      items: [{ text, sentiment: "bullish", sourceIds: ["s"] }], sources: [{ id: "s", url: "https://news.example/s" }],
    }) })
    const { html } = buildTelegramRelease(report).richMessage
    assert.ok(html.isWellFormed())
    assert.ok(visibleText(html).includes(expected))

    assert.equal(links(html).length, 1)
  }
})

test("every rendered field is escaped without exposing private source details", () => {
  const unsafe = "<script>alert(\"x\")</script>&"
  const escaped = "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;&amp;"
  const report = fixture([coin(`symbol ${unsafe}`, {
    topRank: 1, name: `name ${unsafe}`, technicalSummary: { observation: `observation ${unsafe}` },
    information: { news: { error: "PRIVATE-ERROR" } },
  })], { marketBrief: brief({
    items: [{ title: `title ${unsafe}`, text: `news ${unsafe}`, sourceIds: ["s"] }], warning: `warning ${unsafe}`,
    sources: [{ id: "s", url: "https://news.example/?a=1&b=2" }],
  }) })
  const { html } = buildTelegramRelease(report).richMessage
  for (const field of ["symbol", "name", "observation", "title", "news", "warning"]) {
    assert.ok(html.includes(`${field} ${escaped}`))
  }
  assert.doesNotMatch(html, /<script\b|PRIVATE-/iu)
  assert.ok(html.isWellFormed())
})

test("text escaping normalizes whitespace and truncates without partial entities or surrogate pairs", () => {
  assert.equal(telegramText(" \t<&\"x>\n\u0000 "), "&lt;&amp;&quot;x&gt;")
  for (const value of [null, 42, {}]) {
    assert.equal(telegramText(value), "")
  }
  for (const input of ["&".repeat(20), "🙂".repeat(20)]) {
    const text = telegramText(input, 8)
    assert.ok(text.length <= 8)
    assert.ok(text.isWellFormed())
    assert.doesNotMatch(text, /&(?!(?:amp|lt|gt|quot);)/u)
  }
})

test("links accept only safe HTTP URLs and never truncate a destination", () => {
  assert.equal(telegramLink("<Name>", "https://news.example/?x=1&y=2"),
    "<a href=\"https://news.example/?x=1&amp;y=2\">&lt;Name&gt;</a>")
  for (const url of [
    null, "invalid", "javascript:alert(1)", "data:text/html,x", "file:///etc/passwd",
    "https://user:secret@news.example/a", `https://news.example/${"a".repeat(1_000)}`, `https://news.example/${"&".repeat(130)}`,
  ]) {
    assert.equal(telegramLink("Источник", url), null)
  }
})

test("rich message limits count decoded Unicode characters, not bytes or markup", () => {
  for (const unit of ["я", "🙂", "&amp;"]) {
    assert.doesNotThrow(() => telegramRichMessage(`<p>${unit.repeat(32_768)}</p>`, []))
    assert.throws(() => telegramRichMessage(`<p>${unit.repeat(32_769)}</p>`, []), /32768/u)
  }
  const html = `<p>Заголовок</p>\n<p>${"я".repeat(5_000)}</p>`
  assert.ok(visibleText(html).includes("я".repeat(5_000)))
  assert.doesNotThrow(() => telegramRichMessage(html, []))
  const report = fixture(Array.from({ length: 30 }, (_, index) => coin(`LONG-${index}`, {
    topRank: index + 1, technicalExplanation: "я".repeat(1_200),
  })))
  assert.throws(() => buildTelegramRelease(report), /32768/u)
})

test("time formatting uses Moscow and archived creation-time fallbacks remain deterministic", () => {
  assert.match(reportTime("2026-12-31T23:15:00Z"), /01\.01\.2027.*02:15/u)
  assert.match(reportTitleTime("2026-12-31T23:15:00Z"), /2027.*02:15/u)
  for (const reportCreatedAt of [undefined, "invalid"]) {
    const report = fixture([], { reportCreatedAt })
    const release = buildTelegramRelease(report)
    assert.ok(visibleText(release.richMessage.html).includes("03:00"))
    assert.deepEqual(buildTelegramRelease(report), release)
  }
})

test("signal descriptions remove metric evidence without splitting quoted JSON", () => {
  assert.equal(signalText("relVolume=2: Объём растёт: нужен контроль."), "Объём растёт: нужен контроль.")
  assert.equal(signalText("evidence={\"note\":\"first: second\"}: Причина"), "Причина")
  assert.equal(signalText("Без метрик: обычное пояснение"), "Без метрик: обычное пояснение")
})
