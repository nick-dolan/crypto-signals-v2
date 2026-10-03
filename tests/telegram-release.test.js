import assert from "node:assert/strict"
import http from "node:http"
import https from "node:https"
import test, { beforeEach } from "node:test"

import { isArray, isFinite, isObject, isString } from "../src/helpers/utils.typed.js"
import { buildTelegramRelease, selectTelegramCandidates } from "../src/reports/telegram/build-telegram-release.js"
import { reportTime, reportTitleTime, signalText, telegramLink, telegramRichMessage, telegramSection, telegramText } from "../src/reports/telegram/telegram-format.js"

beforeEach((t) => {
  const requests = [[globalThis, "fetch"], [http, "request"], [http, "get"], [https, "request"], [https, "get"]]
    .map(([target, method]) => t.mock.method(target, method, () => assert.fail("Unexpected network request")))
  t.after(() => requests.forEach(request => assert.equal(request.mock.callCount(), 0)))
})

function coin (symbol, overrides = {}) {
  return {
    symbol, baseCurrencyId: `XTVC${symbol}`, name: `Монета ${symbol}`, marketSymbol: `BINANCE:${symbol}USDT.P`,
    topRank: null, movementProbability: 0.5, estimateConfidence: "medium",
    technicalExplanation: "Изменение активности требует наблюдения.",
    explanation: overrides.topRank
      ? "Изменение активности требует наблюдения. Сохранённый новостной контекст."
      : "Сохранённый новостной контекст.",
    drivers: ["relVolume=2: Объём растёт."], counterSignals: ["oiChange4h=0: Нет подтверждения интересом."],
    socialSignificant: false, socialSentiment: null, socialReason: null, features: {},
    ...overrides,
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
    schemaVersion: 2, marketAsOf: "2026-09-30T23:00:00.000Z",
    from: "2026-10-01T00:30:00.000Z", asOf: "2026-10-01T06:30:00.000Z", status: "available",
    paragraphs: [{ text: "Сохранённая сводка рынка.", sourceIds: [] }], sources: [], coverage: [],
    ...overrides,
  }
}

function deepFreeze (value) {
  if (isArray(value) || isObject(value)) {
    Object.values(value).forEach(deepFreeze)
    Object.freeze(value)
  }
  return value
}

function sectionHtml (release, title) {
  const section = release.richMessage.html.split(/\n(?:<p><br><\/p>\n)?(?=<p><b>)/u)
    .find(text => text.startsWith(`<p><b>${title}</b>`))
  assert.ok(section, `Missing section: ${title}`)
  return section
}

function candidateParagraphs (release, title) {
  return [...sectionHtml(release, title).matchAll(/<p>(<code>[\s\S]*?)<\/p>/gu)].map(([, text]) => text)
}

function assertEscaped (text) {
  assert.doesNotMatch(text, /[<>]|&(?!(?:amp|lt|gt|quot);)/u, "Unescaped text or incomplete HTML entity")
}

function decodeEntities (text) {
  return text.replace(/&(amp|lt|gt|quot);/gu, (_, name) => ({ amp: "&", lt: "<", gt: ">", quot: "\"" })[name])
}

function visibleText (html) {
  return decodeEntities(html.replace(/<[^>]*>/gu, ""))
}

function assertTelegramHtml (text, limit = 32_768) {
  assert.ok(isString(text))
  assert.ok([...visibleText(text)].length <= limit, `Visible text exceeds ${limit} characters`)
  assert.ok(text.isWellFormed(), "Truncation must not split a surrogate pair")
  const stack = []
  let blocks = 0
  for (const [token] of text.matchAll(/<[^>]*>|[^<]+|</gu)) {
    if (!token.startsWith("<")) {
      assertEscaped(token)
      continue
    }
    if (token === "<br>") {
      assert.equal(stack.at(-1), "p")
      continue
    }
    if (/^<img src="tg:\/\/photo\?id=card_[1-9]\d*"\/>$/u.test(token)) {
      assert.ok(!stack.length || stack.at(-1) === "tg-collage")
      blocks++
      continue
    }
    const tag = token.match(/^<(\/?)(b|i|a|code|p|tg-collage)(?: href="([^"<>]+)")?>$/u)
    assert.ok(tag, `Unsupported or incomplete Telegram tag: ${token}`)
    const [, closing, name, href] = tag
    if (closing) {
      assert.equal(href, undefined)
      assert.equal(stack.pop(), name, "Telegram tags must be properly nested")
    } else {
      assert.ok(!stack.includes("code"), "Ticker code must contain only escaped text, never links or nested tags")
      if (name === "code") {
        assert.ok(!stack.includes("a"), "Ticker code must not be wrapped in a link")
      }
      if (name === "a") {
        assert.ok(href, "Links require an href and no other attributes")
        assertEscaped(href)
        const url = new URL(decodeEntities(href))
        assert.ok(["http:", "https:"].includes(url.protocol))
        assert.equal(url.username, "")
        assert.equal(url.password, "")
        assert.ok(!stack.includes("a"), "Links cannot be nested")
      } else {
        assert.equal(href, undefined)
      }
      if (["p", "tg-collage"].includes(name)) {
        assert.equal(stack.length, 0, "Blocks must not be nested")
        blocks++
      }
      stack.push(name)
      assert.ok(stack.length <= 16)
    }
  }
  assert.ok(blocks <= 500)
  assert.deepEqual(stack, [], "The post must close all its tags")
}

function assertManifest (release, report) {
  assert.equal(Object.getPrototypeOf(release), Object.prototype)
  assert.deepEqual(JSON.parse(JSON.stringify(release)), release, "Manifest must contain only plain JSON data")
  assert.equal(release.schemaVersion, 2)
  assert.equal(release.asOf, report.asOf)
  assert.equal(Date.parse(release.closedAt) - Date.parse(report.asOf), 3_600_000)
  assert.equal(release.candidates.length, release.eligibleCount)
  assert.equal(release.omittedCount, 0)
  assert.equal(new Set(release.candidates.map(item => item.symbol.trim().toUpperCase())).size, release.candidates.length)
  assert.equal(new Set(release.candidates.map(item => item.image)).size, release.candidates.length)
  assert.equal(Object.hasOwn(release, "messages"), false)
  assert.deepEqual(Object.keys(release.richMessage).sort(), ["html", "media"])
  const { html, media } = release.richMessage
  assertTelegramHtml(html)
  assert.doesNotMatch(html, /Данные рынка на|Период:|Период новостей недоступен/u)
  assert.doesNotMatch(html, /· · ·|<p>[-•] <code>|[🟩⬜🟥]|Топ агента|Новостная сводка за последние|<b>(?:📰 Новостная сводка|⭐ Монеты под наблюдением)/u)
  assert.deepEqual(media, release.candidates.map(item => ({
    id: item.mediaId, media: { type: "photo", media: `attach://${item.mediaId}` },
  })))
  assert.equal(new Set(media.map(item => item.id)).size, release.candidates.length)
  assert.deepEqual([...html.matchAll(/<img src="tg:\/\/photo\?id=([^"<>]+)"\/>/gu)].map(([, id]) => id), media.map(item => item.id))
  const photos = media.map(item => `<img src="tg://photo?id=${item.id}"/>`).join("")
  const storedBrief = report.marketBrief?.marketAsOf === report.asOf && [1, 2, 3, 4, 5].includes(report.marketBrief.schemaVersion)
    ? report.marketBrief
    : null
  const from = isString(storedBrief?.from) ? Date.parse(storedBrief.from) : NaN
  const until = isString(storedBrief?.asOf) ? Date.parse(storedBrief.asOf) : NaN
  const validWindow = isFinite(from) && isFinite(until) && from < until
  const newsTitle = validWindow && until - from === 6 * 3_600_000
    ? "Новости за последние 6 часов"
    : validWindow && until - from === 24 * 3_600_000 ? "Новости за последние 24 часа" : "Новости"
  const briefSection = sectionHtml(release, newsTitle)
  assert.ok(briefSection.startsWith(`<p><b>${newsTitle}</b></p>\n<p><br></p>\n`))
  for (const title of [newsTitle, "Монеты под наблюдением"]) {
    assert.equal(html.split(`<b>${title}</b>`).length - 1, 1)
  }
  assert.doesNotMatch(html, /<b>Графики<\/b>/u)
  assert.equal(html.split("<tg-collage>").length - 1, media.length > 1 ? 1 : 0)
  assert.doesNotMatch(html, /<b>(?:🟢 Позитивные инфоповоды|🦎 CoinGecko Trending)<\/b>|В выпуске нет дополнительных монет/u)
  const top = candidateParagraphs(release, "Монеты под наблюдением")
  const newsCount = release.candidates.filter(item => item.section === "news").length
  const news = newsCount ? candidateParagraphs(release, "📰 Значимые инфоповоды") : []
  assert.equal(html.split("<b>📰 Значимые инфоповоды</b>").length - 1, newsCount ? 1 : 0)
  assert.equal(top.length, release.candidates.length - newsCount)
  assert.equal(news.length, newsCount)
  const createdAt = isString(report.reportCreatedAt) && isFinite(Date.parse(report.reportCreatedAt)) ? report.reportCreatedAt : release.closedAt
  assert.equal(html, [
    `<p><b>📊 Крипторадар | ${reportTitleTime(createdAt)} МСК</b></p>`,
    ...(photos
      ? [
          "<p><br></p>",
          media.length > 1 ? `<tg-collage>${photos}</tg-collage>` : photos,
        ]
      : ["<p><br></p>"]),
    "<p><b>Монеты под наблюдением</b></p>", "<p><br></p>",
    top.length
      ? top.map(text => `<p>${text}</p>`).join("\n<p><br></p>\n")
      : "<p>Агент не выделил убедительных ранних кандидатов.</p>",
    ...(newsCount
      ? [
          "<p><br></p>", "<p><b>📰 Значимые инфоповоды</b></p>", "<p><br></p>",
          news.map(text => `<p>${text}</p>`).join("\n<p><br></p>\n"),
        ]
      : []),
    "<p><br></p>", briefSection,
  ].join("\n"), "The complete post must preserve section order, photos and exact blank-line spacing")
  for (const paragraph of [...top, ...news]) {
    assert.match(paragraph, /^<code>[^<>]*<\/code>(?: · <b>(?:<a href="[^"<>]+">[^<>]*<\/a>|[^<>]+)<\/b>)?(?:<br>[^<>]+)?(?:<br><b>Оговорка:<\/b> [^<>]+)?$/u)
    assert.equal([...paragraph.matchAll(/<code>/gu)].length, 1)
    assert.doesNotMatch(paragraph, /^• |<i>/u)
  }
  for (const [index, item] of release.candidates.entries()) {
    assert.equal(item.number, index + 1)
    assert.equal(item.symbol, report.coins[item.coinIndex].symbol, "coinIndex must refer to the original report order")
    assert.ok(["top", "news"].includes(item.section))
    assert.match(item.image, /^cards\/\d{2}-[a-z\d_-]{1,40}\.png$/iu)
    assert.ok(item.image.startsWith(`cards/${String(item.number).padStart(2, "0")}-`))
    assert.equal(item.mediaId, `card_${index + 1}`)
    assert.deepEqual(Object.keys(item).sort(), ["coinIndex", "image", "mediaId", "number", "section", "symbol"])
  }
}

test("all eligible candidates follow topRank then significant positive or negative news, without promoting assessments or CoinGecko", () => {
  const report = fixture([
    coin("CG-LOW", { movementProbability: 0.1, features: { coingeckoTrending: true } }),
    coin("NEG-LOW", { movementProbability: 0.2, socialSignificant: true, socialSentiment: "negative" }),
    coin("TOP-THREE", { topRank: 3, movementProbability: 0.99 }),
    coin("ASSESSMENT-ONLY", { movementProbability: 1 }),
    coin("CG-FIRST", { movementProbability: 0.9, features: { coingeckoTrending: true } }),
    coin("TOP-ONE", { topRank: 1, movementProbability: 0.1, socialSignificant: true, socialSentiment: "positive", features: { coingeckoTrending: true } }),
    coin("POS-FIRST", { movementProbability: 0.8, socialSignificant: true, socialSentiment: "positive" }),
    coin("CG-SECOND", { movementProbability: 0.8, features: { coingeckoTrending: true } }),
    coin("NEG-SECOND", { movementProbability: 0.7, socialSignificant: true, socialSentiment: "negative" }),
    coin("TOP-TWO", { topRank: 2, movementProbability: 0.05 }),
    coin("CG-THIRD", { movementProbability: 0.7, features: { coingeckoTrending: true } }),
    coin("POS-THIRD", { movementProbability: 0.6, socialSignificant: true, socialSentiment: "positive", features: { coingeckoTrending: true } }),
    coin("CG-FOURTH", { movementProbability: 0.6, features: { coingeckoTrending: true } }),
  ])
  const selected = selectTelegramCandidates(report)
  assert.deepEqual(selected.candidates.map(({ coinIndex, section }) => [coinIndex, section]), [
    [5, "top"], [9, "top"], [2, "top"], [6, "news"], [8, "news"], [11, "news"], [1, "news"],
  ])
  for (const item of selected.candidates) {
    assert.equal(item.coin, report.coins[item.coinIndex])
  }
  assert.equal(selected.eligibleCount, 7)
  assert.equal(selected.omittedCount, 0)
  const release = buildTelegramRelease(report)
  assertManifest(release, report)
  assert.deepEqual(release.candidates.map(({ coinIndex, section }) => [coinIndex, section]), selected.candidates.map(({ coinIndex, section }) => [coinIndex, section]))
  assert.equal(release.eligibleCount, 7)
  assert.doesNotMatch(release.richMessage.html, /общий лимит|не вошли|Кандидатов:/u)
  assert.doesNotMatch(JSON.stringify(release), /ASSESSMENT-ONLY|CG-(?:LOW|FIRST|SECOND|THIRD|FOURTH)/u)
  assert.match(sectionHtml(release, "📰 Значимые инфоповоды"), /<code>POS-FIRST<\/code>[\s\S]*<code>NEG-SECOND<\/code>[\s\S]*<code>POS-THIRD<\/code>[\s\S]*<code>NEG-LOW<\/code>/u)
})

test("more than ten top candidates retain supplementary news without a limit and deduplicate overlapping entries", () => {
  const coins = Array.from({ length: 14 }, (_, index) => coin(`TOP-${index + 1}`, {
    topRank: index + 1, movementProbability: index / 14,
    socialSignificant: true, socialSentiment: "positive", features: { coingeckoTrending: true },
  })).reverse()
  const report = fixture([
    coin("EXTRA-POS", { movementProbability: 1, socialSignificant: true, socialSentiment: "positive" }),
    ...coins,
    coin("EXTRA-CG", { movementProbability: 1, features: { coingeckoTrending: true } }),
    coin("EXTRA-NEG", { movementProbability: 0, socialSignificant: true, socialSentiment: "negative" }),
    { ...coins[0], symbol: "TOP-14-ALIAS" },
  ])
  const release = buildTelegramRelease(report)
  assertManifest(release, report)
  assert.deepEqual(release.candidates.map(item => item.symbol), [
    ...Array.from({ length: 14 }, (_, index) => `TOP-${index + 1}`), "EXTRA-POS", "EXTRA-NEG",
  ])
  assert.deepEqual(release.candidates.map(item => item.section), [...Array(14).fill("top"), "news", "news"])
  assert.doesNotMatch(JSON.stringify(release), /EXTRA-CG/u)
  assert.equal(release.eligibleCount, 16, "Duplicate aliases must not inflate the candidate count")
  assert.equal(release.omittedCount, 0)
})

test("an empty report keeps the empty top and its blank line, without news or invented candidates and images", () => {
  const report = fixture()
  assert.deepEqual(selectTelegramCandidates(report), { candidates: [], eligibleCount: 0, omittedCount: 0 })
  const release = buildTelegramRelease(report)
  assertManifest(release, report)
  assert.deepEqual(release.candidates, [])
  assert.deepEqual(release.richMessage.media, [])
  assert.doesNotMatch(release.richMessage.html, /<img\b|<tg-collage>/u)
  assert.doesNotMatch(release.richMessage.html, /Кандидатов:/u)
  assert.equal(sectionHtml(release, "Монеты под наблюдением"), "<p><b>Монеты под наблюдением</b></p>\n<p><br></p>\n<p>Агент не выделил убедительных ранних кандидатов.</p>")
  assert.doesNotMatch(release.richMessage.html, /Значимые инфоповоды|В выпуске нет дополнительных монет|· · ·/u)
})

for (const [topCount, topBlocks] of [
  [0, ["<p>Агент не выделил убедительных ранних кандидатов.</p>"]],
  [1, ["<p><code>TOP-1</code><br>Техника.</p>"]],
  [3, [
    "<p><code>TOP-1</code><br>Техника.</p>", "<p><br></p>",
    "<p><code>TOP-2</code><br>Техника.</p>", "<p><br></p>",
    "<p><code>TOP-3</code><br>Техника.</p>",
  ]],
]) {
  for (const [newsCount, newsBlocks] of [
    [0, []],
    [1, ["<p><code>NEWS-1</code><br>Инфоповод.</p>"]],
    [3, [
      "<p><code>NEWS-1</code><br>Инфоповод.</p>", "<p><br></p>",
      "<p><code>NEWS-2</code><br>Инфоповод.</p>", "<p><br></p>",
      "<p><code>NEWS-3</code><br>Инфоповод.</p>",
    ]],
  ]) {
    test(`${topCount} top and ${newsCount} news candidates keep exact paragraphs, spacing and graphs before candidates`, () => {
      const report = deepFreeze(fixture([
        ...Array.from({ length: topCount }, (_, index) => coin(`TOP-${index + 1}`, {
          topRank: index + 1, name: null, technicalExplanation: "Техника.",
        })),
        ...Array.from({ length: newsCount }, (_, index) => coin(`NEWS-${index + 1}`, {
          name: null, socialSignificant: true, socialSentiment: index % 2 ? "negative" : "positive", explanation: "Инфоповод.",
        })),
      ], { marketBrief: brief() }))
      const before = structuredClone(report)
      const release = buildTelegramRelease(report)
      assertManifest(release, report)
      const { html } = release.richMessage
      const photos = Array.from({ length: topCount + newsCount }, (_, index) => `<img src="tg://photo?id=card_${index + 1}"/>`).join("")
      assert.equal(html, [
        "<p><b>📊 Крипторадар | 1 октября 2026, 10:45 МСК</b></p>",
        "<p><br></p>",
        ...(photos ? [topCount + newsCount > 1 ? `<tg-collage>${photos}</tg-collage>` : photos] : []),
        "<p><b>Монеты под наблюдением</b></p>", "<p><br></p>", ...topBlocks,
        ...(newsCount ? ["<p><br></p>", "<p><b>📰 Значимые инфоповоды</b></p>", "<p><br></p>", ...newsBlocks] : []),
        "<p><br></p>", "<p><b>Новости за последние 6 часов</b></p>", "<p><br></p>",
        "<p>• Сохранённая сводка рынка.</p>",
      ].join("\n"))
      assert.equal(html.split("<p><br></p>").length - 1, 4 + Math.max(0, topCount - 1) + (newsCount ? newsCount + 1 : 0))
      assert.doesNotMatch(html, /· · ·|<p>- <code>|[🟩⬜🟥]/u)
      assert.deepEqual(report, before)
    })
  }
}

test("news fully deduplicated against top leaves no news heading, placeholder or extra blank line", () => {
  const report = deepFreeze(fixture([
    coin("BCH", {
      topRank: 1, name: null, socialSignificant: true, socialSentiment: "negative", explanation: "Готовое объяснение.",
    }),
    coin(" bch ", { baseCurrencyId: "OTHER-ID", socialSignificant: true, socialSentiment: "positive", movementProbability: 1 }),
    coin("BCH-ALIAS", { baseCurrencyId: " XTVCBCH ", socialSignificant: true, socialSentiment: "negative", movementProbability: 1 }),
  ]))
  const before = structuredClone(report)
  const release = buildTelegramRelease(report)
  assertManifest(release, report)
  assert.deepEqual(release.candidates.map(({ coinIndex, section }) => [coinIndex, section]), [[0, "top"]])
  assert.equal(sectionHtml(release, "Монеты под наблюдением"), "<p><b>Монеты под наблюдением</b></p>\n<p><br></p>\n<p><code>BCH</code><br>Готовое объяснение.</p>")
  assert.equal(release.richMessage.html, buildTelegramRelease(fixture([report.coins[0]])).richMessage.html)
  assert.doesNotMatch(release.richMessage.html, /Значимые инфоповоды|В выпуске нет дополнительных монет|· · ·/u)
  assert.deepEqual(report, before)
})

for (const [section, attributes] of [
  ["top", { topRank: 1 }],
  ["news", { socialSignificant: true, socialSentiment: "positive" }],
  ["news", { socialSignificant: true, socialSentiment: "negative" }],
]) {
  test(`a single ${attributes.socialSentiment ?? section} candidate stays a single photo, without implicit filling or promotion`, () => {
    const report = fixture([coin("UNSELECTED", { movementProbability: 1 }), coin("ONLY", attributes)])
    const release = buildTelegramRelease(report)
    assertManifest(release, report)
    assert.equal(release.eligibleCount, 1)
    assert.equal(release.omittedCount, 0)
    assert.ok(release.richMessage.html.includes("<img src=\"tg://photo?id=card_1\"/>\n<p><b>Монеты под наблюдением</b></p>"))
    assert.doesNotMatch(release.richMessage.html, /<tg-collage>/u)
    assert.deepEqual(release.candidates.map(({ symbol, section, coinIndex, number }) => ({ symbol, section, coinIndex, number })), [
      { symbol: "ONLY", section, coinIndex: 1, number: 1 },
    ])
  })
}

test("truthy flags, invalid ranks and high-probability assessments do not implicitly qualify", () => {
  const report = fixture([
    ...[null, undefined, 0, -1, 1.5, "1", true, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]
      .map((topRank, index) => coin(`RANK-${index}`, { topRank, movementProbability: 1 })),
    ...[false, "true", 1, null, undefined, {}, []].flatMap((socialSignificant, index) => ["positive", "negative"]
      .map(socialSentiment => coin(`SOCIAL-${index}-${socialSentiment}`, { socialSignificant, socialSentiment }))),
    ...["mixed", "neutral", "Positive", "Negative", "positive ", " negative", "", null, undefined, true, ["positive"], {}]
      .map((socialSentiment, index) => coin(`SENTIMENT-${index}`, { socialSignificant: true, socialSentiment, features: { coingeckoTrending: true } })),
    ...[true, false, "true", 1].map((coingeckoTrending, index) => coin(`CG-${index}`, { features: { coingeckoTrending } })),
  ], { candidateCount: 100, topCandidates: [{ symbol: "RANK-0" }] })
  assert.deepEqual(selectTelegramCandidates(report), { candidates: [], eligibleCount: 0, omittedCount: 0 })
  const release = buildTelegramRelease(report)
  assertManifest(release, report)
  assert.deepEqual(release.candidates, [])
})

test("overlaps, normalized symbols and canonical baseCurrencyId aliases occur once without visible badges", () => {
  const report = fixture([
    coin(" alpha ", { baseCurrencyId: "XTVCALPHA", topRank: 2, socialSignificant: true, socialSentiment: "positive", features: { coingeckoTrending: true } }),
    coin("ALPHA", { baseCurrencyId: "OTHER-ID", topRank: 5 }),
    coin("OLD-ALPHA", { baseCurrencyId: " XTVCALPHA ", socialSignificant: true, socialSentiment: "positive", movementProbability: 1 }),
    coin("BETA", { topRank: 1, socialSignificant: true, socialSentiment: "mixed", features: { coingeckoTrending: true } }),
    coin("BETA-ALIAS", { baseCurrencyId: "XTVCBETA", socialSignificant: true, socialSentiment: "negative", features: { coingeckoTrending: true } }),
    coin("GAMMA", { socialSignificant: true, socialSentiment: "positive", features: { coingeckoTrending: true } }),
    coin(" gamma ", { socialSignificant: true, socialSentiment: "negative", features: { coingeckoTrending: true } }),
    coin("DELTA", { baseCurrencyId: null, socialSignificant: true, socialSentiment: "negative" }),
    coin("EPSILON", { baseCurrencyId: "", socialSignificant: true, socialSentiment: "positive" }),
    coin("ZETA", { baseCurrencyId: " ", socialSignificant: true, socialSentiment: "negative" }),
  ])
  const release = buildTelegramRelease(report)
  assertManifest(release, report)
  assert.deepEqual(release.candidates.map(item => item.coinIndex), [3, 0, 5, 7, 8, 9])
  assert.equal(release.eligibleCount, 6)
  assert.equal(release.omittedCount, 0)
  assert.match(sectionHtml(release, "Монеты под наблюдением"), /<p><code>BETA<\/code> · <b><a [\s\S]*<p><code>alpha<\/code> · <b><a /u)
  assert.deepEqual(release.candidates.map(item => item.section), ["top", "top", "news", "news", "news", "news"])
  assert.match(sectionHtml(release, "📰 Значимые инфоповоды"), /<p><code>GAMMA<\/code> · <b><a /u)
  assert.doesNotMatch(release.richMessage.html, /CoinGecko Trending|Смешанный фон|Позитивный инфоповод|Негативный инфоповод/u)
  assert.doesNotMatch([...candidateParagraphs(release, "Монеты под наблюдением"), ...candidateParagraphs(release, "📰 Значимые инфоповоды")].join(""), /<i>/u)
})

for (const sentiment of ["positive", "negative", "alternating"]) {
  test(`${sentiment} news sorts valid probabilities descending and preserves input order for all ties without a limit`, () => {
    const report = deepFreeze(fixture([null, 0.5, 1, 0.5, 0, NaN, "0.99", -0.1, Infinity, 1.1, undefined, -Infinity]
      .map((movementProbability, index) => coin(`COIN-${index}`, {
        movementProbability, socialSignificant: true,
        socialSentiment: sentiment === "alternating" ? index % 2 ? "negative" : "positive" : sentiment,
      }))))
    const before = structuredClone(report)
    const selected = selectTelegramCandidates(report)
    assert.deepEqual(selected.candidates.map(item => item.coinIndex), [2, 1, 3, 4, 0, 5, 6, 7, 8, 9, 10, 11])
    assert.ok(selected.candidates.every(item => item.section === "news"))
    assert.equal(selected.eligibleCount, 12)
    assert.equal(selected.omittedCount, 0)
    for (const item of selected.candidates) {
      assert.equal(item.coin, report.coins[item.coinIndex])
      assert.equal(item.coin.movementProbability, before.coins[item.coinIndex].movementProbability)
    }
    assertManifest(buildTelegramRelease(report), report)
    assert.deepEqual(report, before)
  })
}

test("equal topRank preserves original order instead of resorting by probability", () => {
  const report = fixture([
    coin("SECOND-RANK", { topRank: 2 }), coin("FIRST-TIE", { topRank: 1, movementProbability: 0.1 }),
    coin("SECOND-TIE", { topRank: 1, movementProbability: 0.9 }),
    coin("LAST-RANK", { topRank: Number.MAX_SAFE_INTEGER, movementProbability: 1 }),
  ])
  assert.deepEqual(selectTelegramCandidates(report).candidates.map(item => item.coinIndex), [1, 2, 0, 3])
})

test("selection and repeated builds do not mutate even deeply frozen source reports", () => {
  const report = fixture([
    coin("SECOND", { topRank: 2, features: { coingeckoTrending: true, coingeckoTrendingCategories: ["DeFi"] }, history: { candles: [{ time: 1, close: 2 }] } }),
    coin("POS", { socialSignificant: true, socialSentiment: "positive" }),
    coin("FIRST", { topRank: 1 }),
  ], { marketBrief: brief({ sources: [{ id: "s", url: "https://news.example/article" }], paragraphs: [{ text: "Сводка", sourceIds: ["s", "s"] }] }) })
  const before = structuredClone(report)
  deepFreeze(report)
  const selected = selectTelegramCandidates(report)
  const release = buildTelegramRelease(report)
  assert.deepEqual(selected.candidates.map(item => item.coinIndex), [2, 0, 1])
  assert.deepEqual(buildTelegramRelease(report), release)
  assertManifest(release, report)
  assert.deepEqual(report, before)
})

for (const sentiment of ["positive", "negative", "mixed", "neutral", null, undefined, "unknown"]) {
  test(`significant ${sentiment} background uses the prepared explanation in top, but only positive or negative news qualifies outside top`, () => {
    const report = fixture([
      coin("TOP", {
        topRank: 1, socialSignificant: true, socialSentiment: sentiment,
        technicalExplanation: "Объём растёт.", explanation: "Объём растёт. У вывода есть новостные оговорки.",
        socialReason: "НЕ ДОБАВЛЯТЬ ОТДЕЛЬНЫЙ ФОН", features: { coingeckoTrending: true },
      }),
      coin("SOCIAL-ONLY", {
        socialSignificant: true, socialSentiment: sentiment, movementProbability: 1,
        explanation: "Готовый инфоповод вне топа.", technicalExplanation: "НЕ ДОБАВЛЯТЬ ТЕХНИКУ ВНЕ ТОПА",
        socialReason: "НЕ ДУБЛИРОВАТЬ ИНФОПОВОД", features: { coingeckoTrending: true },
      }),
    ])
    const release = buildTelegramRelease(report)
    assertManifest(release, report)
    assert.equal(release.eligibleCount, ["positive", "negative"].includes(sentiment) ? 2 : 1)
    assert.equal(release.candidates[0].section, "top")
    assert.deepEqual(candidateParagraphs(release, "Монеты под наблюдением"), [
      "<code>TOP</code> · <b><a href=\"https://www.tradingview.com/chart/?symbol=BINANCE%3ATOPUSDT.P\">Монета TOP</a></b><br>Объём растёт. У вывода есть новостные оговорки.",
    ])
    if (["positive", "negative"].includes(sentiment)) {
      assert.deepEqual(candidateParagraphs(release, "📰 Значимые инфоповоды"), [
        "<code>SOCIAL-ONLY</code> · <b><a href=\"https://www.tradingview.com/chart/?symbol=BINANCE%3ASOCIAL-ONLYUSDT.P\">Монета SOCIAL-ONLY</a></b><br>Готовый инфоповод вне топа.",
      ])
    } else {
      assert.doesNotMatch(release.richMessage.html, /Значимые инфоповоды|SOCIAL-ONLY/u)
    }
    assert.doesNotMatch(release.richMessage.html, /НЕ ДОБАВЛЯТЬ|НЕ ДУБЛИРОВАТЬ|Инфоповод:|Техника:|CoinGecko Trending/u)
    assert.doesNotMatch(candidateParagraphs(release, "Монеты под наблюдением").join(""), /<i>/u)
  })
}

test("structured summaries are selected only by exact social significance and never mix technical and social prose", () => {
  for (const socialSignificant of [true, false, null, undefined, "true", 1, {}, []]) {
    const report = deepFreeze(fixture([coin("BCH", {
      topRank: 1, name: "Bitcoin Cash", socialSignificant, socialSentiment: "mixed",
      technicalSummary: { observation: "Объём растёт. Цена ещё в диапазоне.", caveat: "Закрепления за границей нет." },
      summary: { observation: "Объём растёт на фоне подтверждённого обновления.", caveat: "Обновление не подтверждает пробой." },
      technicalExplanation: "PRIVATE-LEGACY-TECH", explanation: "PRIVATE-LEGACY-SOCIAL", socialReason: "PRIVATE-SOCIAL-REASON",
      drivers: ["PRIVATE-DRIVER"], counterSignals: ["PRIVATE-COUNTER"],
    })]))
    const before = structuredClone(report)
    const release = buildTelegramRelease(report)
    assertManifest(release, report)
    assert.deepEqual(candidateParagraphs(release, "Монеты под наблюдением"), [
      "<code>BCH</code> · <b><a href=\"https://www.tradingview.com/chart/?symbol=BINANCE%3ABCHUSDT.P\">Bitcoin Cash</a></b><br>"
      + (socialSignificant === true
        ? "Объём растёт на фоне подтверждённого обновления.<br><b>Оговорка:</b> Обновление не подтверждает пробой."
        : "Объём растёт. Цена ещё в диапазоне.<br><b>Оговорка:</b> Закрепления за границей нет."),
    ])
    assert.doesNotMatch(release.richMessage.html, /PRIVATE-|Значимые инфоповоды|<p>• <code>/u)
    assert.deepEqual(buildTelegramRelease(report), release)
    assert.deepEqual(report, before)
  }
})

for (const socialSignificant of [false, true]) {
  test(`${socialSignificant ? "enriched" : "technical"} structured observation is retained without inventing a missing or invalid caveat`, () => {
    for (const caveat of [null, undefined, "", " \t\n\u0000", 42, true, {}, []]) {
      const report = deepFreeze(fixture([coin("ONLY", {
        topRank: 1, name: null, socialSignificant,
        [socialSignificant ? "summary" : "technicalSummary"]: { observation: "Есть наблюдение, но не обещание результата.", caveat },
        explanation: "PRIVATE-LEGACY", technicalExplanation: "PRIVATE-LEGACY", counterSignals: ["PRIVATE-COUNTER"],
      })]))
      const before = structuredClone(report)
      const release = buildTelegramRelease(report)
      assertManifest(release, report)
      assert.deepEqual(candidateParagraphs(release, "Монеты под наблюдением"), ["<code>ONLY</code><br>Есть наблюдение, но не обещание результата."])
      assert.doesNotMatch(release.richMessage.html, /Оговорка:|PRIVATE-/u)
      assert.deepEqual(report, before)
    }
  })

  test(`${socialSignificant ? "enriched" : "technical"} missing structured observation uses only its legacy fallback and never splits prose heuristically`, () => {
    for (const summary of [
      undefined, null, "text", 42, [], {},
      ...[undefined, null, "", " \t\n\u0000", 42, true, {}, []].map(observation => ({ observation, caveat: "PRIVATE-ORPHAN-CAVEAT" })),
    ]) {
      const legacy = "Объём растёт, но пробой не подтверждён. Однако фон изменился. Оговорка: часть исходного абзаца."
      const report = deepFreeze(fixture([coin("FALLBACK", {
        topRank: 1, name: null, socialSignificant,
        [socialSignificant ? "summary" : "technicalSummary"]: summary,
        [socialSignificant ? "technicalSummary" : "summary"]: { observation: "PRIVATE-OTHER-SUMMARY", caveat: "PRIVATE-OTHER-CAVEAT" },
        technicalExplanation: socialSignificant ? "PRIVATE-TECH" : legacy,
        explanation: socialSignificant ? legacy : "PRIVATE-ENRICHED",
        socialReason: "PRIVATE-SOCIAL", counterSignals: ["PRIVATE-COUNTER"],
      })]))
      const before = structuredClone(report)
      const release = buildTelegramRelease(report)
      assertManifest(release, report)
      assert.deepEqual(candidateParagraphs(release, "Монеты под наблюдением"), [`<code>FALLBACK</code><br>${legacy}`])
      assert.doesNotMatch(release.richMessage.html, /<b>Оговорка:|PRIVATE-/u)
      assert.deepEqual(report, before)
    }
  })

  test(`${socialSignificant ? "enriched" : "technical"} structured fields escape injection independently and preserve their encoded budgets`, () => {
    for (const long of [false, true]) {
      const observation = long ? "<&\"🙂>".repeat(500) : " \tНаблюдение </p><script>alert(1)</script> & \"цитата\".\n"
      const caveat = long ? "<&\"🙂>".repeat(400) : "\n Оговорка <img src=x> & \"ограничение\".\u0000 "
      const report = deepFreeze(fixture([coin("SAFE", {
        topRank: 1, name: null, socialSignificant,
        [socialSignificant ? "summary" : "technicalSummary"]: { observation, caveat },
        explanation: "PRIVATE-LEGACY", technicalExplanation: "PRIVATE-LEGACY", socialReason: "PRIVATE-REASON",
      })]))
      const before = structuredClone(report)
      const release = buildTelegramRelease(report)
      assertManifest(release, report)
      assert.deepEqual(candidateParagraphs(release, "Монеты под наблюдением"), [
        `<code>SAFE</code><br>${telegramText(observation, 1_200)}<br><b>Оговорка:</b> ${telegramText(caveat, 720)}`,
      ])
      assert.equal(release.richMessage.html.split("<b>Оговорка:</b>").length - 1, 1)
      assert.doesNotMatch(release.richMessage.html, /<script|<img src=x|PRIVATE-/u)
      assert.deepEqual(report, before)
    }
  })
}

test("supplementary positive and negative news uses structured summaries and falls back to socialReason without an observation", () => {
  const report = deepFreeze(fixture(["positive", "negative"].map((socialSentiment, index) => coin(`NEWS-${index}`, {
    name: null, socialSignificant: true, socialSentiment,
    summary: index === 0 ? { observation: "Подтверждённое событие.", caveat: "Эффект пока неясен." } : { observation: "", caveat: "PRIVATE-CAVEAT" },
    technicalSummary: { observation: "PRIVATE-TECH", caveat: null },
    explanation: "", socialReason: "Сохранённое основание значимости.",
  }))))
  const before = structuredClone(report)
  const release = buildTelegramRelease(report)
  assertManifest(release, report)
  assert.deepEqual(candidateParagraphs(release, "📰 Значимые инфоповоды"), [
    "<code>NEWS-0</code><br>Подтверждённое событие.<br><b>Оговорка:</b> Эффект пока неясен.",
    "<code>NEWS-1</code><br>Сохранённое основание значимости.",
  ])
  assert.doesNotMatch(release.richMessage.html, /PRIVATE-/u)
  assert.deepEqual(report, before)
})

test("BCH-like insignificant or unknown social background leaves only the separately saved technical explanation", () => {
  for (const socialSignificant of [false, null, undefined, "true", 1, {}, []]) {
    const report = deepFreeze(fixture([coin("BCH", {
      topRank: 1, name: "Bitcoin Cash", socialSignificant, socialSentiment: "positive",
      technicalExplanation: "BCH сжимает диапазон при растущем объёме.",
      explanation: "BCH сжимает диапазон при растущем объёме. В соцсетях обсуждают старую новость.",
      socialReason: "В соцсетях обсуждают старую новость.",
      drivers: ["relVolume=2: НЕ ВОССТАНАВЛИВАТЬ ТЕХНИКУ"],
    })]))
    const before = structuredClone(report)
    const release = buildTelegramRelease(report)
    assertManifest(release, report)
    assert.deepEqual(candidateParagraphs(release, "Монеты под наблюдением"), [
      "<code>BCH</code> · <b><a href=\"https://www.tradingview.com/chart/?symbol=BINANCE%3ABCHUSDT.P\">Bitcoin Cash</a></b><br>BCH сжимает диапазон при растущем объёме.",
    ])
    assert.doesNotMatch(release.richMessage.html, /соцсетях|старую новость|НЕ ВОССТАНАВЛИВАТЬ/u)
    assert.deepEqual(report, before)
  }
})

for (const [section, sentiment, title] of [
  ["top", "mixed", "Монеты под наблюдением"],
  ["news", "positive", "📰 Значимые инфоповоды"],
  ["news", "negative", "📰 Значимые инфоповоды"],
]) {
  test(`${section} ${sentiment} uses socialReason up to 320 only when a significant prepared explanation is empty or invalid`, () => {
    const socialReason = "Готовый инфоповод <&\"🙂>. ".repeat(100)
    for (const explanation of [undefined, null, "", " \t\n\u0000", 42, true, {}, []]) {
      const report = fixture([coin("FALLBACK", {
        topRank: section === "top" ? 1 : null, name: null,
        socialSignificant: true, socialSentiment: sentiment, explanation, socialReason,
        technicalExplanation: "НЕ ПОДСТАВЛЯТЬ ТЕХНИКУ", drivers: ["metric=1: НЕ ПОДСТАВЛЯТЬ ДРАЙВЕР"],
      })])
      const release = buildTelegramRelease(report)
      assertManifest(release, report)
      assert.deepEqual(candidateParagraphs(release, title), [`<code>FALLBACK</code><br>${telegramText(socialReason, 320)}`])
      assert.doesNotMatch(release.richMessage.html, /НЕ ПОДСТАВЛЯТЬ|Инфоповод:|Техника:/u)
    }
  })
}

test("missing or invalid significant explanations and social reasons leave the heading without invented text or a dash", () => {
  for (const socialReason of [undefined, null, "", " \t\n\u0000", 42, true, {}, []]) {
    const report = fixture([coin("EMPTY", {
      topRank: 1, name: null, socialSignificant: true, socialSentiment: "neutral", explanation: null, socialReason,
      technicalExplanation: "НЕ ИСПОЛЬЗОВАТЬ ТЕХНИЧЕСКИЙ FALLBACK",
    }), coin("NEWS", {
      name: null, socialSignificant: true, socialSentiment: "negative", explanation: "", socialReason,
    })])
    const release = buildTelegramRelease(report)
    assertManifest(release, report)
    assert.deepEqual(candidateParagraphs(release, "Монеты под наблюдением"), ["<code>EMPTY</code>"])
    assert.deepEqual(candidateParagraphs(release, "📰 Значимые инфоповоды"), ["<code>NEWS</code>"])
  }
})

test("empty or invalid technicalExplanation never falls back to enriched prose, socialReason or drivers", () => {
  for (const technicalExplanation of [undefined, null, "", " \t\n\u0000", 42, true, {}, []]) {
    for (const socialSignificant of [false, null, "true"]) {
      const report = fixture([coin("EMPTY", {
        topRank: 1, name: null, technicalExplanation, socialSignificant,
        socialSentiment: "negative", socialReason: "НЕ ПОКАЗЫВАТЬ ФОН",
      })])
      const release = buildTelegramRelease(report)
      assertManifest(release, report)
      assert.deepEqual(candidateParagraphs(release, "Монеты под наблюдением"), ["<code>EMPTY</code>"])
    }
  }
})

test("legacy archives without technicalExplanation never reconstruct technical prose from enriched explanations", () => {
  for (const socialSignificant of [false, null, undefined, "true"]) {
    const archived = coin("LEGACY", {
      topRank: 1, name: null, socialSignificant,
      explanation: "Объём растёт.\nИнфоповод: старое обсуждение. Техника: не восстанавливать эвристикой.",
      socialReason: "Старое обсуждение.",
    })
    delete archived.technicalExplanation
    const report = deepFreeze(fixture([archived]))
    const before = structuredClone(report)
    const release = buildTelegramRelease(report)
    assertManifest(release, report)
    assert.deepEqual(candidateParagraphs(release, "Монеты под наблюдением"), ["<code>LEGACY</code>"])
    assert.deepEqual(report, before)
    assert.equal(Object.hasOwn(archived, "technicalExplanation"), false)
  }
})

test("stored movement probability is neither displayed nor recomputed from social, technical or directional data", () => {
  const report = fixture([coin("TEST", {
    topRank: 1, movementProbability: 0.3749, estimateConfidence: "high", directionBias: "up",
    socialSignificant: true, socialSentiment: "positive",
    features: { coingeckoTrending: true, relVolume: 100, oiChange4h: 100, flags: ["short_squeeze_setup"] },
  })], { marketContext: { altMarketBackground: { status: "up" } } })
  const release = buildTelegramRelease(report)
  const text = release.richMessage.html
  assertManifest(release, report)
  assert.doesNotMatch(text, /P движения|уверенность|37%|0\.3749|estimateConfidence|movementProbability/u)
  assert.doesNotMatch(text, /P — оценка|без статистической калибровки|Срез по закрытым свечам/u)
  assert.doesNotMatch(text, /P роста|P падения|directionBias|short_squeeze_setup|прогноз направления/u)
  assert.equal(selectTelegramCandidates(report).candidates[0].coin.movementProbability, 0.3749)
  const changed = structuredClone(report)
  Object.assign(changed.coins[0], { directionBias: "down", socialSentiment: "negative", features: {} })
  assert.equal(selectTelegramCandidates(changed).candidates[0].coin.movementProbability, 0.3749)
  assert.equal(buildTelegramRelease(changed).richMessage.html, text)
})

test("zero, one and missing or invalid probabilities remain unchanged and never affect candidate text", () => {
  const expected = buildTelegramRelease(fixture([coin("TEST", { topRank: 1 })])).richMessage.html
  for (const movementProbability of [0, 1, 0.625, null, undefined, NaN, Infinity, -0.01, 1.01, "0.8"]) {
    const report = deepFreeze(fixture([coin("TEST", { topRank: 1, movementProbability, estimateConfidence: "unknown" })]))
    const release = buildTelegramRelease(report)
    assertManifest(release, report)
    assert.equal(selectTelegramCandidates(report).candidates[0].coin.movementProbability, movementProbability)
    assert.equal(report.coins[0].movementProbability, movementProbability)
    assert.equal(release.richMessage.html, expected)
    assert.doesNotMatch(visibleText(sectionHtml(release, "Монеты под наблюдением")), /P движения|уверенность|нет оценки|NaN|Infinity|%/u)
  }
})

test("signal descriptions drop metric evidence but skip separators inside JSON strings and escaped quotes", () => {
  for (const [input, expected] of [
    ["relVolume=2, oiChange4h=3: Объём растёт: нужен контроль.", "Объём растёт: нужен контроль."],
    [`peers=${JSON.stringify([{ note: "Alert: \"now: go\"", url: "https://news.example/a: b", path: "C:\\notes: x", value: "x=y" }])}: Сигнал: с оговоркой.`, "Сигнал: с оговоркой."],
    ["evidence=\"first: second\": Причина", "Причина"],
    ["evidence={\"note\":\"first: second\"}", "evidence={\"note\":\"first: second\"}"],
    ["Без метрик: обычное пояснение", "Без метрик: обычное пояснение"],
    ["Примечание: relVolume=2", "Примечание: relVolume=2"],
    ["x=2 без разделителя", "x=2 без разделителя"],
    [null, ""], [undefined, ""], [42, ""], [{ text: "not a signal" }, ""], [[], ""],
  ]) {
    assert.equal(signalText(input), expected)
  }
})

test("candidate paragraphs never append drivers, counter-signals, badges, categories or source and history warnings", () => {
  const attributes = {
    drivers: [`peers=${JSON.stringify({ note: "a: \"b: c\"" })}: PRIVATE-DRIVER`, "rvRatio=0.5: PRIVATE-COMPRESSION"],
    counterSignals: ["risk={\"note\":\"x: y\"}: PRIVATE-RISK", "funding=0.01: PRIVATE-FUNDING"],
    features: { coingeckoTrending: true, coingeckoTrendingCategories: ["PRIVATE-CATEGORY"] },
    information: { news: { status: "failed", error: "PRIVATE-NEWS" }, twitter: { status: "failed", error: "PRIVATE-TWITTER" } },
    history: { warning: "PRIVATE-HISTORY" }, name: null,
  }
  const report = fixture([
    coin("TOP", { ...attributes, topRank: 1, technicalExplanation: "Готовое техническое объяснение." }),
    coin("POS", { ...attributes, socialSignificant: true, socialSentiment: "positive", explanation: "Готовый позитивный инфоповод." }),
    coin("NEG", { ...attributes, socialSignificant: true, socialSentiment: "negative", explanation: "Готовый негативный инфоповод." }),
    coin("CG-ONLY", attributes),
  ])
  const release = buildTelegramRelease(report)
  assertManifest(release, report)
  assert.deepEqual(candidateParagraphs(release, "Монеты под наблюдением"), ["<code>TOP</code><br>Готовое техническое объяснение."])
  assert.deepEqual(candidateParagraphs(release, "📰 Значимые инфоповоды"), [
    "<code>POS</code><br>Готовый позитивный инфоповод.", "<code>NEG</code><br>Готовый негативный инфоповод.",
  ])
  assert.doesNotMatch(release.richMessage.html, /PRIVATE-|peers=|rvRatio=|risk=|funding=|⚠|CoinGecko|Категории:|Техника:|Инфоповод:|P движения|уверенность/u)
  assert.doesNotMatch(JSON.stringify(release), /CG-ONLY/u)
})

test("the ticker is unlinked code and only the name links to the encoded TradingView market", () => {
  for (const marketSymbol of ["BINANCE:WLDUSDT.P", "BINANCE:WLD/USDT?x=1&y=\"<🙂>#"]) {
    const report = fixture([coin("WLD", {
      topRank: 1, name: "Worldcoin", marketSymbol, technicalExplanation: "готовое описание",
    })])
    const release = buildTelegramRelease(report)
    assertManifest(release, report)
    assert.deepEqual(candidateParagraphs(release, "Монеты под наблюдением"), [
      `<code>WLD</code> · <b><a href="https://www.tradingview.com/chart/?symbol=${encodeURIComponent(marketSymbol)}">Worldcoin</a></b><br>готовое описание`,
    ])
  }
})

test("ticker code and name escape tag injection without nesting code or moving the link onto the ticker", () => {
  for (const demo of [false, true]) {
    const report = fixture([coin("WLD</code>&\"", {
      topRank: 1, name: "<code>Worldcoin</code>&\"", marketSymbol: "BINANCE:WLD/?x=\"&y=<code>",
      technicalExplanation: "Текст <code>не разметка</code>.",
    })], { demo })
    const release = buildTelegramRelease(report)
    assertManifest(release, report)
    const name = "&lt;code&gt;Worldcoin&lt;/code&gt;&amp;&quot;"
    assert.deepEqual(candidateParagraphs(release, "Монеты под наблюдением"), [
      `<code>WLD&lt;/code&gt;&amp;&quot;</code> · <b>${demo ? name : `<a href="https://www.tradingview.com/chart/?symbol=BINANCE%3AWLD%2F%3Fx%3D%22%26y%3D%3Ccode%3E">${name}</a>`}</b><br>Текст &lt;code&gt;не разметка&lt;/code&gt;.`,
    ])
    assert.equal([...release.richMessage.html.matchAll(/<code>/gu)].length, 1)
    assert.equal([...release.richMessage.html.matchAll(/<a href=/gu)].length, demo ? 0 : 1)
  }
  assert.throws(() => assertTelegramHtml("<p><code><a href=\"https://example.com\">WLD</a></code></p>"), /Ticker code must contain only escaped text/u)
  assert.throws(() => assertTelegramHtml("<p>• <a href=\"https://example.com\"><code>WLD</code></a></p>"), /Ticker code must not be wrapped in a link/u)
})

test("missing, empty or invalid names leave just the symbol without a link or duplicated code", () => {
  for (const name of [undefined, null, "", " \t\n\u0000", 42, true, {}, []]) {
    const report = fixture([coin("WLD", { topRank: 1, name, technicalExplanation: null })])
    const release = buildTelegramRelease(report)
    assertManifest(release, report)
    assert.deepEqual(candidateParagraphs(release, "Монеты под наблюдением"), ["<code>WLD</code>"])
    assert.doesNotMatch(release.richMessage.html, /<a /u)
  }
})

test("missing or invalid market symbols keep the name as plain text without inventing a TradingView URL", () => {
  for (const marketSymbol of [undefined, null, "", " \t\n", 42, true, {}, []]) {
    const report = fixture([coin("WLD", { topRank: 1, name: "Worldcoin", marketSymbol, technicalExplanation: null })])
    const release = buildTelegramRelease(report)
    assertManifest(release, report)
    assert.deepEqual(candidateParagraphs(release, "Монеты под наблюдением"), ["<code>WLD</code> · <b>Worldcoin</b>"])
    assert.doesNotMatch(release.richMessage.html, /<a /u)
  }
})

for (const socialSignificant of [false, true]) {
  test(`${socialSignificant ? "prepared" : "technical"} explanation uses the 1200 encoded-character budget without appending other prose`, () => {
    for (const description of ["я".repeat(1_199), "я".repeat(1_200), "я".repeat(1_201), "<&\"🙂>".repeat(1_000)]) {
      const report = fixture([coin("LONG", {
        topRank: 1, name: null, socialSignificant, socialSentiment: "positive",
        technicalExplanation: socialSignificant ? "НЕ ДУБЛИРОВАТЬ ТЕХНИКУ" : description,
        explanation: socialSignificant ? description : "НЕ ПОКАЗЫВАТЬ СКЛЕЕННЫЙ ТЕКСТ",
        socialReason: "НЕ ДОБАВЛЯТЬ ФОН",
      })])
      const release = buildTelegramRelease(report)
      assertManifest(release, report)
      assert.deepEqual(candidateParagraphs(release, "Монеты под наблюдением"), [`<code>LONG</code><br>${telegramText(description, 1_200)}`])
      assert.doesNotMatch(release.richMessage.html, /НЕ ДУБЛИРОВАТЬ|НЕ ПОКАЗЫВАТЬ|НЕ ДОБАВЛЯТЬ/u)
    }
  })
}

test("telegramText escapes every untrusted HTML character and normalizes whitespace and controls", () => {
  assert.equal(telegramText(" \u0000\tПривет\n<&>\"\r \u0007🙂 "), "Привет &lt;&amp;&gt;&quot; 🙂")
  assert.equal(telegramText("&amp; <b>текст</b>"), "&amp;amp; &lt;b&gt;текст&lt;/b&gt;")
  assert.equal(telegramText("abcdef", 5), "abcd…")
  assert.equal(telegramText("&<\"", 10), "&amp;&lt;…")
  assert.equal(telegramText("🙂🙂", 4), "🙂…")
  for (const value of [null, undefined, 123, true, {}, []]) {
    assert.equal(telegramText(value), "")
  }
  assert.ok(telegramText("x".repeat(2_000)).length <= 1_000)
  for (const limit of [1, 2, 3, 5, 6, 90, 100, 220, 300, 320, 360, 520, 1_024, 1_200, 4_096]) {
    const text = telegramText("<&\"🙂>".repeat(2_000), limit)
    assert.ok(text.length <= limit, "Existing encoded field budgets must stay intact")
    assertTelegramHtml(text, limit)
    assert.ok(text.endsWith("…"))
  }
})

test("telegramLink accepts only credential-free HTTP(S) and escapes labels and attribute injection attempts", () => {
  assert.equal(telegramLink("<Источник> & \"цитата\"", "http://news.example/a?x=1&y=2"),
    "<a href=\"http://news.example/a?x=1&amp;y=2\">&lt;Источник&gt; &amp; &quot;цитата&quot;</a>")
  const link = telegramLink("<b>Источник</b>", "https://news.example/a?q=\" onclick=\"alert(1)&x=<img>")
  assertTelegramHtml(link, 800)
  assert.match(link, /%22/u)
  assert.match(link, /&amp;x=/u)
  assert.match(link, /&lt;b&gt;Источник&lt;\/b&gt;/u)
  for (const url of [
    "javascript:alert(1)", "JaVaScRiPt:alert(1)", "data:text/html,<script>alert(1)</script>", "file:///etc/passwd",
    "ftp://news.example/a", "blob:https://news.example/id", "tg://resolve?domain=test", "//news.example/a", "/relative",
    "not a URL", "https://", "https://user@news.example/", "https://user:secret@news.example/",
    "https://:secret@news.example/", "https://user%40mail@news.example/", null, undefined, 12, {},
  ]) {
    assert.equal(telegramLink("Источник", url), null, String(url))
  }
})

test("huge link URLs are dropped rather than truncated, including growth caused by HTML escaping", () => {
  const prefix = "https://news.example/"
  for (const length of [599, 600]) {
    const url = prefix + "a".repeat(length - prefix.length)
    const link = telegramLink("Источник", url)
    assert.ok(link.includes(`href="${url}"`))
    assertTelegramHtml(link, 800)
  }
  for (const url of [prefix + "a".repeat(601 - prefix.length), prefix + "a".repeat(10_000), `${prefix}?q=${"&".repeat(130)}`]) {
    assert.equal(telegramLink("Источник", url), null)
  }
  const link = telegramLink("<&🙂".repeat(100), prefix)
  assertTelegramHtml(link, 800)
  assert.ok(link.endsWith("…</a>"))
  const report = fixture([coin("HUGE-MARKET", { topRank: 1, marketSymbol: "X".repeat(1_000) })])
  const release = buildTelegramRelease(report)
  assertManifest(release, report)
  assert.deepEqual(candidateParagraphs(release, "Монеты под наблюдением"), ["<code>HUGE-MARKET</code> · <b>Монета HUGE-MARKET</b><br>Изменение активности требует наблюдения."])
  assert.doesNotMatch(release.richMessage.html, /<a /u)
})

test("telegramSection keeps whole escaped blocks above 4096, with paragraphs and one heading", () => {
  const heading = "<b>Рынок &amp; новости</b>"
  const block = `<i>${"x".repeat(5_000)}&amp;🙂</i>\nПродолжение`
  const blocks = deepFreeze([null, "", block, "<b>Следующая &lt;монета&gt;</b>"])
  const html = telegramSection(heading, blocks)
  assert.equal(html, `<p>${heading}</p>\n<p>${block.replace("\n", "<br>")}</p>\n<p>${blocks[3]}</p>`)
  assert.equal(html.split(heading).length - 1, 1)
  assertTelegramHtml(html)
  assert.equal(telegramSection(heading, [null, ""]), `<p>${heading}</p>`)
  assert.equal(telegramSection("", []), "")
})

test("rich text limit counts Unicode characters, not bytes, UTF-16 units, markup or escaped entities", () => {
  const html = `<p><b>${"🙂Я&amp;".repeat(10_922)}&lt;&quot;</b></p>`
  const media = deepFreeze([{ id: "card_1", media: { type: "photo", media: "attach://card_1" } }])
  assert.equal([...visibleText(html)].length, 32_768)
  assert.ok(visibleText(html).length > 32_768)
  assert.ok(Buffer.byteLength(visibleText(html), "utf8") > 32_768)
  assert.deepEqual(telegramRichMessage(html, media), { html, media })
  assertTelegramHtml(html)
  assert.throws(() => telegramRichMessage(`${html}<p>я</p>`, media), /rich-поста.*лимит 32768 символов: 32769/u)
  assert.equal(telegramRichMessage(`<p>${"x".repeat(32_763)}&amp;amp;</p>`, []).html, `<p>${"x".repeat(32_763)}&amp;amp;</p>`)
  assert.throws(() => telegramRichMessage(`<p>${"x".repeat(32_764)}&amp;amp;</p>`, []), /32769/u, "Entities must be decoded only once")
})

test("rich text validation rejects total overflow across valid sections without truncating HTML", () => {
  const section = telegramSection("<b>Заголовок</b>", [`<i>${"x".repeat(17_000)}</i>`])
  assertTelegramHtml(section)
  assert.equal(telegramRichMessage(section, []).html, section)
  assert.throws(() => telegramRichMessage(section + section, []), /превышает лимит 32768 символов/u)
  assert.throws(() => telegramRichMessage(telegramSection(`<b>${"x".repeat(32_769)}</b>`, []), []), /32769/u)
})

test("all rendered report fields are escaped, while raw source errors and history warnings remain private", () => {
  const unsafe = "<img src=x onerror=\"alert(1)\">&"
  const escaped = "&lt;img src=x onerror=&quot;alert(1)&quot;&gt;&amp;"
  const attributes = {
    name: `NAME${unsafe}`, technicalExplanation: `TECH${unsafe}`, explanation: `WHY${unsafe}`, drivers: [`metric=1: DRIVER${unsafe}`],
    counterSignals: [`metric=2: RISK${unsafe}`], socialSignificant: true, socialSentiment: "positive", socialReason: `SOCIAL${unsafe}`,
    features: { coingeckoTrending: true, coingeckoTrendingCategories: [`CATEGORY${unsafe}`, 123] },
    history: { warning: `PRIVATE-HISTORY${unsafe}` }, information: { news: { status: "failed", error: `PRIVATE-ERROR${unsafe}` } },
  }
  const report = fixture([
    coin(`SYMBOL${unsafe}`, { ...attributes, topRank: 1, marketSymbol: `BINANCE:${unsafe}` }),
    coin("POS", attributes),
    coin("NEG", { ...attributes, explanation: "", socialSentiment: "negative" }),
    coin("TECH", { ...attributes, topRank: 2, socialSignificant: false }),
  ], { marketBrief: brief({
    paragraphs: [{ text: `BRIEF${unsafe}`, sourceIds: ["s"] }], warning: `WARNING${unsafe}`,
    sources: [{ id: "s", url: "https://news.example/?q=\" onclick=\"alert(1)&b=<script>", title: unsafe, publisher: unsafe }],
  }) })
  const release = buildTelegramRelease(report)
  assertManifest(release, report)
  const text = release.richMessage.html
  for (const prefix of ["SYMBOL", "NAME", "TECH", "WHY", "SOCIAL", "BRIEF", "WARNING"]) {
    assert.ok(text.includes(`${prefix}${escaped}`), `Missing escaped ${prefix}`)
  }
  assert.ok(sectionHtml(release, "Монеты под наблюдением").includes(`SYMBOL${escaped}`))
  assert.doesNotMatch(text, /<img src=x|<script|PRIVATE-ERROR|PRIVATE-HISTORY|metric=|DRIVER|RISK|CATEGORY/u)
  assert.doesNotMatch(text, /График с оговорками|Не все источники новостей и обсуждений удалось загрузить/u)
})

test("card paths stay unique and local even for traversal-like symbols and identical sanitized stems", () => {
  const report = fixture(["../../outside", "A/B", "A?B", `${"X".repeat(45)}1`, `${"X".repeat(45)}2`, "💥<>&"]
    .map((symbol, index) => coin(symbol, { topRank: index + 1 })))
  const release = buildTelegramRelease(report)
  assertManifest(release, report)
  assert.equal(release.candidates.length, 6)
  assert.equal(release.candidates[1].image, "cards/02-A_B.png")
  assert.equal(release.candidates[2].image, "cards/03-A_B.png")
  assert.ok(release.candidates.every(item => !item.image.includes("..")))
})

for (const [section, title, demo] of [
  ["top", "Монеты под наблюдением", false], ["news", "📰 Значимые инфоповоды", false],
  ["top", "Монеты под наблюдением", true], ["news", "📰 Значимые инфоповоды", true],
]) {
  test(`long escaped ${section} ${demo ? "demo" : "linked"} candidates keep one paragraph each, 100-character symbols and names, and 1200-character descriptions`, () => {
    const long = "<&\"🙂>".repeat(1_000)
    const report = fixture(Array.from({ length: 10 }, (_, index) => coin(`COIN-${index}-${long}`, {
      name: long, topRank: section === "top" ? index + 1 : null, marketSymbol: `BINANCE:${"X".repeat(450)}${index}`,
      technicalExplanation: long, explanation: section === "top" ? "PRIVATE-ENRICHED" : long,
      drivers: ["metric=1: PRIVATE-DRIVER"], counterSignals: ["risk=1: PRIVATE-RISK"],
      socialSignificant: section === "news", socialSentiment: index % 2 ? "negative" : "positive", socialReason: "PRIVATE-SOCIAL",
      features: { coingeckoTrending: true, coingeckoTrendingCategories: ["PRIVATE-CATEGORY"] },
    })), { demo })
    const release = buildTelegramRelease(report)
    assertManifest(release, report)
    assert.equal(release.candidates.length, 10)
    assert.ok(release.candidates.every(item => item.section === section))
    const text = sectionHtml(release, title)
    assert.ok(text.length > 4_096)
    assert.equal(text.split(`<b>${title}</b>`).length - 1, 1)
    const paragraphs = candidateParagraphs(release, title)
    assert.deepEqual(paragraphs, report.coins.map((coin) => {
      const name = telegramText(coin.name, 100)
      const heading = demo ? name : `<a href="https://www.tradingview.com/chart/?symbol=${encodeURIComponent(coin.marketSymbol)}">${name}</a>`
      return `<code>${telegramText(coin.symbol, 100)}</code> · <b>${heading}</b><br>${telegramText(long, 1_200)}`
    }))
    assert.equal([...text.matchAll(/<a href=/gu)].length, demo ? 0 : 10)
    assert.ok(paragraphs.every(paragraph => paragraph.includes("…") && paragraph.length < 2_000))
    assert.ok(text.startsWith(`<p><b>${title}</b></p>\n<p><br></p>\n<p><code>`))
    assert.doesNotMatch(release.richMessage.html, /PRIVATE-|P — оценка|в любую сторону за 4–12ч/u)
  })
}

for (const schemaVersion of [1, 2, 3, 4, 5]) {
  test(`v${schemaVersion} news uses one bullet regardless of sentiment, one blank line between items and an unbulleted warning`, () => {
    for (const sentiment of ["bullish", "neutral", "bearish", undefined, null, "unknown"]) {
      const paragraphs = ["Первая новость.", "Вторая новость."].map(text => ({ text, sentiment, sourceIds: ["s"] }))
      const report = deepFreeze(fixture([], { marketBrief: brief({
        schemaVersion, status: "partial", paragraphs, items: paragraphs,
        events: paragraphs.map(item => ({ summary: item.text, sentiment, verification: "confirmed", sourceIds: item.sourceIds })),
        warning: "Оговорка <&\"🙂>", sources: [{ id: "s", url: "https://news.example/s" }],
      }) }))
      const before = structuredClone(report)
      const release = buildTelegramRelease(report)
      assertManifest(release, report)
      assert.equal(sectionHtml(release, "Новости за последние 6 часов"), [
        "<p><b>Новости за последние 6 часов</b></p>", "<p><br></p>",
        "<p>• Первая новость. <a href=\"https://news.example/s\">[1]</a></p>", "<p><br></p>",
        "<p>• Вторая новость. <a href=\"https://news.example/s\">[1]</a></p>",
        "<p>⚠ Оговорка &lt;&amp;&quot;🙂&gt;</p>",
      ].join("\n"))
      assert.deepEqual(report, before)
    }
  })

  test(`v${schemaVersion} empty or invalid news text adds no bullet, citation or extra blank line`, () => {
    for (const text of [undefined, null, "", " \t\n\u0000", 42, true, {}, []]) {
      const paragraphs = [{ text, sourceIds: ["s"] }, { text: "Содержательная новость.", sourceIds: ["s"] }]
      const report = deepFreeze(fixture([], { marketBrief: brief({
        schemaVersion, paragraphs, items: paragraphs,
        events: paragraphs.map(item => ({ summary: item.text, verification: "confirmed", sourceIds: item.sourceIds })),
        warning: "Оговорка.", sources: [{ id: "s", url: "https://news.example/s" }],
      }) }))
      const before = structuredClone(report)
      const release = buildTelegramRelease(report)
      assertManifest(release, report)
      assert.equal(sectionHtml(release, "Новости за последние 6 часов"), [
        "<p><b>Новости за последние 6 часов</b></p>", "<p><br></p>",
        "<p>• Содержательная новость. <a href=\"https://news.example/s\">[1]</a></p>",
        "<p>⚠ Оговорка.</p>",
      ].join("\n"))
      assert.deepEqual(report, before)
    }
  })
}

for (const schemaVersion of [3, 4, 5]) {
  for (const count of [0, 1, 2, 3, 4, 5, 6]) {
    test(`v${schemaVersion} renders ${count} items as at most five uniform bullets separated by blank lines, with up to ten distinct citations and no mutation`, () => {
      const items = Array.from({ length: count }, (_, index) => ({
        text: `Пункт ${index + 1}.`, sentiment: "bullish", sourceIds: [`s${index * 2 + 1}`, `s${index * 2 + 2}`],
      }))
      const sources = items.flatMap(item => item.sourceIds).map(id => ({ id, url: `https://news.example/${id}` }))
      const report = deepFreeze(fixture([], { marketBrief: brief({
        schemaVersion, items, sources, events: [{ summary: "НЕ ИСПОЛЬЗОВАТЬ V1" }],
      }) }))
      const before = structuredClone(report)
      const release = buildTelegramRelease(report)
      assertManifest(release, report)
      const text = sectionHtml(release, "Новости за последние 6 часов")
      const bullets = [...text.matchAll(/<p>(• [\s\S]*?)<\/p>/gu)].map(([, item]) => item)
      assert.equal(text.split("<p><br></p>").length - 1, 1 + Math.max(0, Math.min(count, 5) - 1))
      assert.ok(text.includes(bullets.map(item => `<p>${item}</p>`).join("\n<p><br></p>\n")))
      assert.deepEqual(bullets, items.slice(0, 5).map((item, index) => `• ${item.text} ${item.sourceIds
        .map((id, citation) => `<a href="https://news.example/${id}">[${index * 2 + citation + 1}]</a>`).join(" ")}`))
      assert.equal([...text.matchAll(/<a href=/gu)].length, Math.min(count, 5) * 2)
      assert.doesNotMatch(text, /Сохранённая сводка рынка|НЕ ИСПОЛЬЗОВАТЬ V1|Пункт 6\.|· · ·|🟩|⬜|🟥|🟢|⚪|🔴/u)
      assert.deepEqual(buildTelegramRelease(report), release)
      assert.deepEqual(report, before)
    })
  }

  test(`v${schemaVersion} keeps stored order, escaped text and source-based numbering with at most two valid links per item`, () => {
    const report = deepFreeze(fixture([], { marketBrief: brief({
      schemaVersion,
      items: [
        { text: " \n\t", sentiment: "bullish", sourceIds: ["c"] },
        { text: "Первый <пункт> & \"цитата\".", sentiment: "bearish", sourceIds: ["missing", "unsafe", "b", "b", "a", "c"] },
        { text: "Второй пункт.", sentiment: "bullish", sourceIds: ["c", "b"] },
        { text: "Третий пункт.", sentiment: "neutral", sourceIds: ["d", "a"] },
        { text: "Четвёртый пункт.", sentiment: "bearish", sourceIds: ["d"] },
      ],
      sources: [
        { id: "d", url: "https://news.example/d" }, { id: "c", url: "https://news.example/c" },
        { id: "a", url: "http://news.example/a" }, { id: "b", url: "https://news.example/b?x=1&y=2" },
        { id: "unsafe", url: "javascript:alert(1)" },
      ],
    }) }))
    const before = structuredClone(report)
    const release = buildTelegramRelease(report)
    assertManifest(release, report)
    const text = sectionHtml(release, "Новости за последние 6 часов")
    assert.equal(text.split("<p><br></p>").length - 1, 4)
    assert.ok(text.startsWith("<p><b>Новости за последние 6 часов</b></p>\n<p><br></p>\n<p>• Первый"))
    assert.deepEqual([...text.matchAll(/<p>(• [\s\S]*?)<\/p>/gu)].map(([, item]) => item), [
      "• Первый &lt;пункт&gt; &amp; &quot;цитата&quot;. <a href=\"https://news.example/b?x=1&amp;y=2\">[1]</a> <a href=\"http://news.example/a\">[2]</a>",
      "• Второй пункт. <a href=\"https://news.example/c\">[3]</a> <a href=\"https://news.example/b?x=1&amp;y=2\">[1]</a>",
      "• Третий пункт. <a href=\"https://news.example/d\">[4]</a> <a href=\"http://news.example/a\">[2]</a>",
      "• Четвёртый пункт. <a href=\"https://news.example/d\">[4]</a>",
    ])
    assert.doesNotMatch(text, /javascript:|missing|\[5\]|· · ·|🟩|⬜|🟥|🟢|⚪|🔴/u)
    assert.deepEqual(buildTelegramRelease(report), release)
    assert.deepEqual(report, before)
  })

  test(`v${schemaVersion} missing or malformed items never fall back to archival paragraphs or events`, () => {
    for (const items of [undefined, null, {}, "not an array"]) {
      const report = fixture([], { marketBrief: brief({ schemaVersion, items, events: [{ summary: "НЕ ИСПОЛЬЗОВАТЬ V1" }] }) })
      const release = buildTelegramRelease(report)
      assertManifest(release, report)
      const text = sectionHtml(release, "Новости за последние 6 часов")
      assert.doesNotMatch(text, /· · ·/u)
      assert.match(text, /Содержательная сводка не подготовлена; доступных данных недостаточно/u)
      assert.doesNotMatch(text, /Сохранённая сводка рынка|НЕ ИСПОЛЬЗОВАТЬ V1|<p>[•🟩⬜🟥] /u)
    }
  })
}

for (const [schemaVersion, sentiment] of [[3, undefined], [4, "bullish"], [4, "neutral"], [4, "bearish"], [5, "bullish"], [5, "neutral"], [5, "bearish"]]) {
  test(`v${schemaVersion} ${sentiment ?? "archival"} text keeps the 250 UTF-16 boundary excluding the bullet prefix, links and HTML escaping`, () => {
    for (const [text, expected] of [
      [`${"а ".repeat(124)}а`, `${"а ".repeat(124)}а`],
      [`${"а ".repeat(124)}аб`, `${"а ".repeat(124)}аб`],
      [`${"а ".repeat(124)}абв`, `${"а ".repeat(124)}а…`],
      ["\"".repeat(250), "\"".repeat(250)],
      [`${"<&\"".repeat(83)}!`, `${"<&\"".repeat(83)}!`],
      ["🙂".repeat(125), "🙂".repeat(125)],
      [`${"🙂".repeat(125)}!`, `${"🙂".repeat(124)}…`],
      [`${"а".repeat(247)}🙂!!`, `${"а".repeat(247)}🙂…`],
      ["а".repeat(1_000), `${"а".repeat(249)}…`],
      [" \t\n Короткий\u0000 &   текст. \n", "Короткий & текст."],
    ]) {
      const report = fixture([], { marketBrief: brief({
        schemaVersion, items: [{ text, sentiment, sourceIds: ["a", "b"] }],
        sources: ["a", "b"].map(id => ({ id, url: `https://news.example/${id}` })),
      }) })
      const release = buildTelegramRelease(report)
      assertManifest(release, report)
      const bullets = [...sectionHtml(release, "Новости за последние 6 часов").matchAll(/<p>(• [\s\S]*?)<\/p>/gu)]
        .map(([, item]) => visibleText(item))
      assert.deepEqual(bullets, [`• ${expected} [1] [2]`])
      assert.ok(bullets[0].slice(2).replace(/ \[1\] \[2\]$/u, "").length <= 250)
    }
  })
}

test("v5 renders stored bold titles above text with safe consecutive citations, a five-item cap and no mutation", () => {
  const report = deepFreeze(fixture([], { marketBrief: brief({
    schemaVersion: 5,
    items: [
      { title: "Первый <заголовок> & \"цитата\"", text: "Событие <не разметка>.", sourceIds: ["missing", "unsafe", "b", "b", "a", "c"] },
      { title: "Второй заголовок", text: "Второе событие.", sourceIds: ["c", "b"] },
      { title: null, text: "Новость без заголовка. Не делать первое предложение заголовком.", sourceIds: ["a"] },
      { title: "PRIVATE-EMPTY-TEXT", text: " \t\n", sourceIds: ["unused"] },
      { title: "Последний заголовок", text: "Последняя сохранённая новость.", sourceIds: ["d"] },
      { title: "PRIVATE-SIXTH-TITLE", text: "PRIVATE-SIXTH-TEXT", sourceIds: ["unused"] },
    ],
    paragraphs: [{ text: "PRIVATE-V2" }], events: [{ title: "PRIVATE-V1", summary: "PRIVATE-V1" }],
    sources: [
      ...["a", "b", "c", "d", "unused"].map(id => ({ id, url: `https://news.example/${id}?x=1&y=2`, title: "PRIVATE-SOURCE-TITLE" })),
      { id: "unsafe", url: "javascript:alert(1)" },
    ],
  }) }))
  const before = structuredClone(report)
  const release = buildTelegramRelease(report)
  assertManifest(release, report)
  const text = sectionHtml(release, "Новости за последние 6 часов")
  assert.deepEqual([...text.matchAll(/<p>(• [\s\S]*?)<\/p>/gu)].map(([, item]) => item), [
    "• <b>Первый &lt;заголовок&gt; &amp; &quot;цитата&quot;</b><br>Событие &lt;не разметка&gt;. <a href=\"https://news.example/b?x=1&amp;y=2\">[1]</a> <a href=\"https://news.example/a?x=1&amp;y=2\">[2]</a>",
    "• <b>Второй заголовок</b><br>Второе событие. <a href=\"https://news.example/c?x=1&amp;y=2\">[3]</a> <a href=\"https://news.example/b?x=1&amp;y=2\">[1]</a>",
    "• Новость без заголовка. Не делать первое предложение заголовком. <a href=\"https://news.example/a?x=1&amp;y=2\">[2]</a>",
    "• <b>Последний заголовок</b><br>Последняя сохранённая новость. <a href=\"https://news.example/d?x=1&amp;y=2\">[4]</a>",
  ])
  assert.equal(text.split("<p><br></p>").length - 1, 4)
  assert.doesNotMatch(text, /PRIVATE-|javascript:|unused|\[5\]/u)
  assert.deepEqual(buildTelegramRelease(report), release)
  assert.deepEqual(report, before)
})

for (const schemaVersion of [1, 5]) {
  test(`v${schemaVersion} missing or invalid titles never invent a headline or an empty line above the stored prose`, () => {
    for (const title of [undefined, null, "", " \t\n\u0000", 42, true, {}, []]) {
      const report = deepFreeze(fixture([], { marketBrief: brief({
        schemaVersion,
        events: [{ title, summary: "Первое предложение. Второе предложение.", verification: "confirmed" }],
        items: [{ title, text: "Первое предложение. Второе предложение." }],
      }) }))
      const release = buildTelegramRelease(report)
      assertManifest(release, report)
      const bullets = [...sectionHtml(release, "Новости за последние 6 часов").matchAll(/<p>(• [\s\S]*?)<\/p>/gu)].map(([, item]) => item)
      assert.deepEqual(bullets, ["• Первое предложение. Второе предложение."])
    }
  })
}

test("v2 through v4 never borrow or fabricate news titles", () => {
  for (const schemaVersion of [2, 3, 4]) {
    const report = deepFreeze(fixture([], { marketBrief: brief({
      schemaVersion,
      paragraphs: [{ title: "PRIVATE-TITLE", text: "Первое предложение. Второе предложение.", sourceIds: ["s"] }],
      items: [{ title: "PRIVATE-TITLE", text: "Первое предложение. Второе предложение.", sourceIds: ["s"] }],
      sources: [{ id: "s", url: "https://news.example/s", title: "PRIVATE-SOURCE-TITLE" }],
    }) }))
    const release = buildTelegramRelease(report)
    assertManifest(release, report)
    assert.deepEqual([...sectionHtml(release, "Новости за последние 6 часов").matchAll(/<p>(• [\s\S]*?)<\/p>/gu)].map(([, item]) => item), [
      "• Первое предложение. Второе предложение. <a href=\"https://news.example/s\">[1]</a>",
    ])
    assert.doesNotMatch(release.richMessage.html, /PRIVATE-/u)
  }
})

test("v5 title and body limits are independent and do not truncate citations or split escaped characters", () => {
  const title = "<&\"🙂>".repeat(200)
  const report = deepFreeze(fixture([], { marketBrief: brief({
    schemaVersion: 5, items: [{ title, text: "я".repeat(251), sourceIds: ["s"] }],
    sources: [{ id: "s", url: "https://news.example/s" }],
  }) }))
  const release = buildTelegramRelease(report)
  assertManifest(release, report)
  assert.deepEqual([...sectionHtml(release, "Новости за последние 6 часов").matchAll(/<p>(• [\s\S]*?)<\/p>/gu)].map(([, item]) => item), [
    `• <b>${telegramText(title, 400)}</b><br>${"я".repeat(249)}… <a href="https://news.example/s">[1]</a>`,
  ])
})

test("v3 archives never infer sentiment labels from news text", () => {
  const items = ["Позитивная новость о росте.", "Нейтральное обновление.", "Негативная новость о падении."]
    .map(text => ({ text, sourceIds: ["s"] }))
  const report = deepFreeze(fixture([], { marketBrief: brief({
    schemaVersion: 3, items, sources: [{ id: "s", url: "https://news.example/s" }],
  }) }))
  const release = buildTelegramRelease(report)
  assertManifest(release, report)
  const text = sectionHtml(release, "Новости за последние 6 часов")
  assert.deepEqual([...text.matchAll(/<p>• ([\s\S]*?)<\/p>/gu)].map(([, item]) => visibleText(item)), items.map(item => `${item.text} [1]`))
  assert.doesNotMatch(text, /🟩|⬜|🟥|⊕|○|⊖|🟢|⚪|🔴/u)
})

test("v4 missing or invalid sentiment still renders one bullet without defaulting or inferring classification", () => {
  for (const overrides of [
    {}, ...[undefined, null, "", "unknown", "positive", "negative", "Neutral", "neutral ", "toString", "constructor", "__proto__", 0, false, {}, ["neutral"]]
      .map(sentiment => ({ sentiment })),
  ]) {
    const report = deepFreeze(fixture([], { marketBrief: brief({
      schemaVersion: 4, items: [{ text: "Позитивная новость <&\">.", sourceIds: ["s"], ...overrides }],
      sources: [{ id: "s", url: "https://news.example/s" }],
    }) }))
    const release = buildTelegramRelease(report)
    assertManifest(release, report)
    const text = sectionHtml(release, "Новости за последние 6 часов")
    assert.deepEqual([...text.matchAll(/<p>(• [\s\S]*?)<\/p>/gu)].map(([, item]) => item), [
      "• Позитивная новость &lt;&amp;&quot;&gt;. <a href=\"https://news.example/s\">[1]</a>",
    ])
    assert.doesNotMatch(text, /• •|🟩|⬜|🟥|⊕|○|⊖|🟢|⚪|🔴/u)
  }
})

test("v2 paragraphs use stored prose and stable deduplicated citations, ignoring other schemas and unknown sources", () => {
  const report = fixture([], { marketBrief: brief({
    paragraphs: [
      { text: "Первый абзац.", sourceIds: ["missing", "unsafe", "b", "b", "a"] },
      { text: "Второй абзац.", sourceIds: ["a", "b"] },
      { text: "Лишний абзац.", sourceIds: [] },
    ],
    sources: [
      { id: "a", url: "http://news.example/a" }, { id: "b", url: "https://news.example/b?x=1&y=2" },
      { id: "unsafe", url: "javascript:alert(1)" },
    ],
    events: [{ summary: "УСТАРЕВШЕЕ СОБЫТИЕ", verification: "unconfirmed" }],
    items: [{ text: "НЕ ИСПОЛЬЗОВАТЬ V3", sourceIds: ["a"] }],
  }) })
  const release = buildTelegramRelease(report)
  assertManifest(release, report)
  const text = sectionHtml(release, "Новости за последние 6 часов")
  assert.deepEqual([...text.matchAll(/<p>(• [\s\S]*?)<\/p>/gu)].map(([, paragraph]) => paragraph), [
    "• Первый абзац. <a href=\"https://news.example/b?x=1&amp;y=2\">[1]</a> <a href=\"http://news.example/a\">[2]</a>",
    "• Второй абзац. <a href=\"http://news.example/a\">[2]</a> <a href=\"https://news.example/b?x=1&amp;y=2\">[1]</a>",
  ])
  assert.doesNotMatch(text, /Лишний абзац|УСТАРЕВШЕЕ СОБЫТИЕ|НЕ ИСПОЛЬЗОВАТЬ V3|javascript:|\[3\]/u)
})

test("v2 citations stay consecutive when previously omitted sources appear in the next paragraph", () => {
  const report = fixture([], { marketBrief: brief({
    paragraphs: [
      { text: "Первый абзац.", sourceIds: ["a", "b", "c", "d", "e"] },
      { text: "Второй абзац.", sourceIds: ["f", "c"] },
    ],
    sources: ["a", "b", "c", "d", "e", "f"].map(id => ({ id, url: `https://news.example/${id}` })),
  }) })
  const release = buildTelegramRelease(report)
  assertManifest(release, report)
  const paragraphs = [...sectionHtml(release, "Новости за последние 6 часов").matchAll(/<p>(• [\s\S]*?)<\/p>/gu)]
    .map(([, text]) => text)
  assert.deepEqual(paragraphs, [
    "• Первый абзац. <a href=\"https://news.example/a\">[1]</a> <a href=\"https://news.example/b\">[2]</a>",
    "• Второй абзац. <a href=\"https://news.example/f\">[3]</a> <a href=\"https://news.example/c\">[4]</a>",
  ])
})

test("legacy v1 events retain unconfirmed warnings, summaries, significance and safe citations", () => {
  const report = fixture([], { marketBrief: brief({
    schemaVersion: 1, from: "2026-09-30T06:30:00.000Z",
    paragraphs: [{ text: "НЕ ИСПОЛЬЗОВАТЬ V2" }], items: [{ text: "НЕ ИСПОЛЬЗОВАТЬ V3" }],
    events: [
      { title: "Инцидент <&\">", summary: "Возможный инцидент <не проверен>.", whyItMatters: "Доступность & ликвидность под вопросом.", verification: "unconfirmed", sourceIds: ["s"] },
      { summary: "Подтверждённое обновление.", whyItMatters: "Меняется инфраструктура.", verification: "confirmed", sourceIds: [] },
    ],
    sources: [{ id: "s", url: "https://news.example/event" }],
  }) })
  const release = buildTelegramRelease(report)
  assertManifest(release, report)
  const text = sectionHtml(release, "Новости за последние 24 часа")
  assert.ok(text.startsWith("<p><b>Новости за последние 24 часа</b></p>\n<p><br></p>\n"))
  assert.deepEqual([...text.matchAll(/<p>(• [\s\S]*?)<\/p>/gu)].map(([, item]) => item), [
    "• <b>Инцидент &lt;&amp;&quot;&gt;</b><br>Не подтверждено: Возможный инцидент &lt;не проверен&gt;. Доступность &amp; ликвидность под вопросом. <a href=\"https://news.example/event\">[1]</a>",
    "• Подтверждённое обновление. Меняется инфраструктура.",
  ])
  assert.equal(text.split("Не подтверждено:").length - 1, 1)
  assert.match(text, /<a href="https:\/\/news\.example\/event">\[1\]<\/a>/u)
  assert.doesNotMatch(text, /НЕ ИСПОЛЬЗОВАТЬ V2|НЕ ИСПОЛЬЗОВАТЬ V3/u)
})

for (const schemaVersion of [1, 2]) {
  test(`v${schemaVersion} long briefs keep citations, entities and warnings intact under one news title`, () => {
    const sources = ["a", "b"].map(id => ({ id, url: `https://news.example/${id}/${"x".repeat(540)}` }))
    const report = fixture([], { marketBrief: brief({
      schemaVersion, sources, warning: "Оговорка <&\"🙂>".repeat(100),
      paragraphs: Array.from({ length: 2 }, (_, index) => ({ text: `Абзац-${index} ${"<&\"🙂>".repeat(500)}`, sourceIds: ["a", "b"] })),
      events: Array.from({ length: 5 }, (_, index) => ({ summary: `Событие-${index} ${"<&\"🙂>".repeat(500)}`, verification: "unconfirmed", sourceIds: ["a", "b"] })),
    }) })
    const release = buildTelegramRelease(report)
    assertManifest(release, report)
    const text = sectionHtml(release, "Новости за последние 6 часов")
    assert.ok(text.length > 4_096)
    assert.equal(text.split("<b>Новости за последние 6 часов</b>").length - 1, 1)
    assert.equal(text.split("<p><br></p>").length - 1, schemaVersion === 2 ? 2 : 5)
    assert.doesNotMatch(text, /· · ·|<p><br><\/p>\n<p>⚠/u)
    assert.equal([...text.matchAll(schemaVersion === 2 ? /Абзац-\d/gu : /Не подтверждено: Событие-\d/gu)].length, schemaVersion === 2 ? 2 : 5)
    assert.equal([...text.matchAll(/<a href=/gu)].length, schemaVersion === 2 ? 4 : 10)
    const prose = [...text.matchAll(/<p>• ((?:Абзац-|Не подтверждено: Событие-)[\s\S]*?) <a /gu)].map(([, paragraph]) => paragraph)
    assert.equal(prose.length, schemaVersion === 2 ? 2 : 5)
    assert.ok(prose.every(paragraph => visibleText(paragraph).length > 250))
    assert.equal([...text.matchAll(/<p>• /gu)].length, schemaVersion === 2 ? 2 : 5)
    assert.match(text, /<p>⚠ Оговорка/u)
  })
}

test("missing, unsupported or mismatched market briefs never leak stale prose, links or publication windows", () => {
  for (const overrides of [
    undefined, null, ...[0, 6, 99, "4", "5"].map(schemaVersion => ({ schemaVersion })),
    ...[1, 2, 3, 4, 5].flatMap(schemaVersion => ["2026-09-30T22:00:00.000Z", "invalid", undefined, null, 42]
      .map(marketAsOf => ({ schemaVersion, marketAsOf }))),
  ]) {
    const marketBrief = overrides
      ? brief({
          ...overrides, status: "partial", warning: "НЕ ПОКАЗЫВАТЬ ОГОВОРКУ",
          from: "2041-03-10T20:30:00.000Z", asOf: "2041-03-11T02:30:00.000Z",
          items: [{ title: "НЕ ПОКАЗЫВАТЬ V5", text: "НЕ ПОКАЗЫВАТЬ V3/V4/V5", sentiment: "bearish", sourceIds: ["s"] }],
          paragraphs: [{ text: "НЕ ПОКАЗЫВАТЬ V2", sourceIds: ["s"] }],
          events: [{ summary: "НЕ ПОКАЗЫВАТЬ V1", sourceIds: ["s"] }],
          sources: [{ id: "s", url: "https://news.example/stale" }],
        })
      : overrides
    const report = fixture([], { marketBrief })
    const release = buildTelegramRelease(report)
    assertManifest(release, report)
    assert.match(release.richMessage.html, /Сводка недоступна или относится к другому срезу/u)
    assert.match(release.richMessage.html, /Отсутствие данных не означает отсутствие событий/u)
    assert.doesNotMatch(release.richMessage.html, /НЕ ПОКАЗЫВАТЬ|2041|23:30|05:30|Период:|Новости за последние|Публикации:|<a |⚠|•/u)
    assert.equal(sectionHtml(release, "Новости"), [
      "<p><b>Новости</b></p>", "<p><br></p>",
      "<p>Сводка недоступна или относится к другому срезу. Отсутствие данных не означает отсутствие событий.</p>",
    ].join("\n"))
  }
})

for (const [status, paragraphs, coverage, expected, absent] of [
  ["unavailable", [{ text: "НЕ ПОКАЗЫВАТЬ" }], [], /Сводка недоступна\. Отсутствие данных не означает отсутствие событий/u, /НЕ ПОКАЗЫВАТЬ|нет сообщений|Покрытие/u],
  ["empty", [{ text: "НЕ ПОКАЗЫВАТЬ" }], [], /В полученной выборке нет сообщений для сводки/u, /НЕ ПОКАЗЫВАТЬ|Сводка недоступна|Покрытие/u],
  ["partial", [{ text: "Доступная часть новостей." }], [], /Доступная часть новостей\./u, /нет сообщений|Сводка недоступна|Покрытие/u],
  ["partial", [{ text: " \n\t", sourceIds: ["missing"] }, { text: null }], [], /Содержательная сводка не подготовлена/u, /нет сообщений|Сводка недоступна|Покрытие|<a /u],
  ["available", [], [], /Содержательная сводка не подготовлена; доступных данных недостаточно/u, /нет сообщений|Сводка недоступна|Покрытие/u],
  ["available", [{ text: "Доступная часть новостей." }], [{ source: "twitter", status: "failed", error: "PRIVATE-HTTP-429" }], /Доступная часть новостей\./u, /PRIVATE-HTTP-429|Сводка недоступна|Покрытие/u],
  ["empty", [], [{ source: "tradingview", status: "partial" }], /нет сообщений для сводки/u, /Сводка недоступна|Покрытие/u],
]) {
  for (const schemaVersion of [1, 2, 3, 4, 5]) {
    test(`v${schemaVersion} brief ${status}, ${paragraphs.length} entries and ${coverage[0]?.status ?? "healthy"} coverage keep distinct wording and only news gets bullets`, () => {
      const report = fixture([], { marketBrief: brief({
        schemaVersion, status, paragraphs, items: paragraphs.map(item => ({ ...item, sentiment: "neutral" })),
        events: paragraphs.map(item => ({ summary: item.text, sourceIds: item.sourceIds })),
        coverage, warning: "Оговорка <&\"🙂>",
      }) })
      const release = buildTelegramRelease(report)
      assertManifest(release, report)
      const text = sectionHtml(release, "Новости за последние 6 часов")
      assert.match(text, expected)
      assert.doesNotMatch(text, absent)
      assert.doesNotMatch(text, /Публикации:|· · ·/u)
      assert.deepEqual([...text.matchAll(/<p>• ([\s\S]*?)<\/p>/gu)].map(([, item]) => item),
        ["available", "partial"].includes(status) ? paragraphs.map(item => telegramText(item.text)).filter(Boolean) : [])
      assert.match(text, /<\/p>\n<p>⚠ Оговорка &lt;&amp;&quot;🙂&gt;<\/p>$/u)
      assert.equal(text.split("<p><br></p>").length - 1, 1)
    })
  }
}

test("coin news and Twitter source statuses never add service warnings to candidate text", () => {
  const expected = buildTelegramRelease(fixture([coin("TEST", { topRank: 1 })])).richMessage.html
  for (const source of ["news", "twitter"]) {
    for (const status of ["available", "empty", "failed"]) {
      const report = fixture([coin("TEST", { topRank: 1, information: { [source]: { status, error: "PRIVATE-SOURCE-ERROR" } } })])
      const text = buildTelegramRelease(report).richMessage.html
      assert.equal(text, expected)
      assert.doesNotMatch(text, /PRIVATE-SOURCE-ERROR|Не все источники новостей и обсуждений удалось загрузить/u)
    }
  }
})

test("unsafe and huge saved source URLs are omitted without fetching or dropping the grounded prose", () => {
  const sources = [
    "javascript:alert(1)", "data:text/html,<img src=x>", "https://user:secret@news.example/a", "file:///etc/passwd",
    `https://news.example/${"x".repeat(1_000)}`, "https://news.example/safe",
  ].map((url, index) => ({ id: `s${index}`, url }))
  const paragraphs = [{ text: "Сохранённое сообщение с ограничениями.", sourceIds: sources.map(source => source.id) }]
  for (const schemaVersion of [2, 3, 4, 5]) {
    const report = fixture([], { marketBrief: brief({
      schemaVersion, sources, paragraphs, items: paragraphs.map(item => ({ ...item, sentiment: "bullish" })),
    }) })
    const release = buildTelegramRelease(report)
    assertManifest(release, report)
    assert.match(release.richMessage.html, /Сохранённое сообщение с ограничениями\./u)
    assert.deepEqual([...release.richMessage.html.matchAll(/<a href="([^"]+)">\[(\d+)\]<\/a>/gu)].map(([, url, number]) => [url, number]), [
      ["https://news.example/safe", "1"],
    ])
    assert.doesNotMatch(release.richMessage.html, /javascript:|data:|file:|secret/u)
  }
})

test("creation time stays in the title while market metadata and stored news duration remain independent for all brief versions", () => {
  for (const schemaVersion of [1, 2, 3, 4, 5]) {
    const report = fixture([coin("TEST", { topRank: 1 })], { marketBrief: brief({
      schemaVersion,
      events: [{ summary: "Сохранённая сводка рынка." }],
      items: [{ text: "Сохранённая сводка рынка.", sentiment: "neutral", sourceIds: [] }],
    }) })
    const release = buildTelegramRelease(report)
    assertManifest(release, report)
    assert.equal(release.closedAt, "2026-10-01T00:00:00.000Z")
    assert.ok(release.richMessage.html.startsWith("<p><b>📊 Крипторадар | 1 октября 2026, 10:45 МСК</b></p>\n<p><br></p>"))
    assert.equal(sectionHtml(release, "Новости за последние 6 часов"), [
      "<p><b>Новости за последние 6 часов</b></p>", "<p><br></p>", "<p>• Сохранённая сводка рынка.</p>",
    ].join("\n"))
    assert.doesNotMatch(release.richMessage.html, /Публикации:|1 октября 2026, 03:00|30\.09\.2026, 23:00|01\.10\.2026, (?:03:00|03:30|09:30)/u)
  }
  assert.equal(reportTime("2026-12-31T23:00:00.000Z"), "01.01.2027, 02:00")
  assert.throws(() => reportTime("not a date"), RangeError)
})

test("news heading follows the exact stored duration across a Moscow day or year without exposing window timestamps", () => {
  for (const [schemaVersion, from, asOf, title, period] of [
    [5, "2026-09-30T20:30:00.000Z", "2026-10-01T02:30:00.000Z", "Новости за последние 6 часов", "30.09.2026, 23:30 — 01.10.2026, 05:30"],
    [1, "2026-12-30T22:15:00.000Z", "2026-12-31T22:15:00.000Z", "Новости за последние 24 часа", "31.12.2026, 01:15 — 01.01.2027, 01:15"],
    [5, "2026-09-30T20:30:00.000Z", "2026-10-01T14:30:00.000Z", "Новости", "30.09.2026, 23:30 — 01.10.2026, 17:30"],
    [5, "2026-09-30T20:30:00.000Z", "2026-10-01T02:29:59.000Z", "Новости", "30.09.2026, 23:30 — 01.10.2026, 05:29"],
    [5, "2026-09-30T20:30:00.000Z", "2026-10-01T20:30:01.000Z", "Новости", "30.09.2026, 23:30 — 01.10.2026, 23:30"],
  ]) {
    const report = deepFreeze(fixture([], { marketBrief: brief({
      schemaVersion, from, asOf, lookbackHours: 99,
      events: [{ summary: "Сохранённая новость." }], items: [{ text: "Сохранённая новость." }],
    }) }))
    const before = structuredClone(report)
    const release = buildTelegramRelease(report)
    assertManifest(release, report)
    assert.equal(sectionHtml(release, title), [
      `<p><b>${title}</b></p>`, "<p><br></p>", "<p>• Сохранённая новость.</p>",
    ].join("\n"))
    assert.equal(release.richMessage.html.match(/<p><b>Новости[^<]*<\/b><\/p>/gu).length, 1)
    assert.equal(release.closedAt, "2026-10-01T00:00:00.000Z")
    assert.ok([from, asOf, ...period.split(" — ")].every(timestamp => !release.richMessage.html.includes(timestamp)))
    assert.doesNotMatch(release.richMessage.html, /99 часов|Период новостей недоступен/u)
    assert.deepEqual(report, before)
  }
})

for (const schemaVersion of [1, 2, 3, 4, 5]) {
  test(`v${schemaVersion} invalid, missing, zero or reversed windows expose no partial timestamps or fabricated duration`, () => {
    for (const window of [
      ...[undefined, null, "", "invalid", "2041-13-40T99:00:00Z", 2_246_745_600_000, true, {}, new Date("2041-03-10T20:30:00.000Z")]
        .flatMap(value => [{ from: value }, { asOf: value }]),
      { from: "2041-03-11T02:30:00.000Z" },
      { from: "2041-03-11T03:30:00.000Z" },
    ]) {
      const report = deepFreeze(fixture([], { marketBrief: brief({
        schemaVersion, from: "2041-03-10T20:30:00.000Z", asOf: "2041-03-11T02:30:00.000Z", ...window,
        paragraphs: [{ text: "Сохранённая новость." }], events: [{ summary: "Сохранённая новость." }], items: [{ text: "Сохранённая новость." }],
      }) }))
      const before = structuredClone(report)
      const release = buildTelegramRelease(report)
      assertManifest(release, report)
      assert.equal(sectionHtml(release, "Новости"), [
        "<p><b>Новости</b></p>", "<p><br></p>", "<p>• Сохранённая новость.</p>",
      ].join("\n"))
      assert.doesNotMatch(release.richMessage.html, /2041|23:30|05:30|Период:|Новости за последние|Invalid Date|NaN/u)
      assert.deepEqual(report, before)
    }
  })
}

test("market metadata uses candle close across Moscow midnight, not creation time or saved closedAt, without appearing in the post", () => {
  const report = deepFreeze(fixture([], {
    asOf: "2026-12-31T20:00:00.000Z", reportCreatedAt: "2027-01-01T06:45:00.000Z", closedAt: "2041-03-11T02:30:00.000Z",
  }))
  const before = structuredClone(report)
  const release = buildTelegramRelease(report)
  assertManifest(release, report)
  assert.equal(release.closedAt, "2026-12-31T21:00:00.000Z")
  assert.ok(release.richMessage.html.startsWith("<p><b>📊 Крипторадар | 1 января 2027, 09:45 МСК</b></p>\n<p><br></p>"))
  assert.doesNotMatch(release.richMessage.html, /2041|31\.12\.2026, 23:00|01\.01\.2027, 00:00|Данные рынка на/u)
  assert.deepEqual(report, before)
})

test("title uses a long Russian date in Moscow with report creation minutes and no locale filler", () => {
  for (const [timestamp, expected] of [
    ["2026-09-27T08:03:00.000Z", "27 сентября 2026, 11:03"],
    ["2026-12-31T23:00:00.000Z", "1 января 2027, 02:00"],
    ["2026-09-26T21:03:00.000Z", "27 сентября 2026, 00:03"],
  ]) {
    assert.equal(reportTitleTime(timestamp), expected)
    const report = fixture([], { reportCreatedAt: timestamp })
    const release = buildTelegramRelease(report)
    assert.ok(release.richMessage.html.includes(`<b>📊 Крипторадар | ${expected} МСК</b>`))
    assert.deepEqual(buildTelegramRelease(report), release)
  }
  assert.throws(() => reportTitleTime("invalid"), RangeError)
})

test("archived reports without a valid creation timestamp use the stored candle close, never the current clock", () => {
  for (const reportCreatedAt of [undefined, null, "", "invalid", 1_759_276_800_000, {}]) {
    const report = fixture([], { reportCreatedAt })
    const release = buildTelegramRelease(report)
    assertManifest(release, report)
    assert.match(release.richMessage.html, /📊 Крипторадар \| 1 октября 2026, 03:00 МСК/u)
    assert.doesNotMatch(release.richMessage.html, /Данные рынка на|01\.10\.2026, 03:00/u)
    assert.deepEqual(buildTelegramRelease(report), release)
  }
})

test("the complete post puts charts after the title, then candidates and uniform legacy news bullets without service dates", () => {
  const report = deepFreeze(fixture([coin("TOP", { topRank: 1 })], {
    asOf: "2026-09-27T07:00:00.000Z", reportCreatedAt: "2026-09-27T08:03:00.000Z",
    marketBrief: brief({
      schemaVersion: 4, marketAsOf: "2026-09-27T07:00:00.000Z",
      from: "2026-09-27T02:03:00.000Z", asOf: "2026-09-27T08:03:00.000Z", status: "partial",
      coverage: [{ source: "twitter", status: "partial", error: null }],
      items: ["bullish", "neutral", "bearish"].map((sentiment, index) => ({ text: `Новость ${index + 1}.`, sentiment, sourceIds: ["s"] })),
      sources: [{ id: "s", url: "https://news.example/source" }],
    }),
  }))
  const before = structuredClone(report)
  const release = buildTelegramRelease(report)
  assertManifest(release, report)
  const { html } = release.richMessage
  assert.ok(html.startsWith("<p><b>📊 Крипторадар | 27 сентября 2026, 11:03 МСК</b></p>\n<p><br></p>\n<img src=\"tg://photo?id=card_1\"/>\n<p><b>Монеты под наблюдением</b></p>\n<p><br></p>\n<p><code>TOP</code>"))
  for (const number of [1, 2, 3]) {
    assert.ok(html.includes(`<p>• Новость ${number}. <a href="https://news.example/source">[1]</a></p>`))
  }
  assert.ok(html.includes("<br>Изменение активности требует наблюдения.</p>\n<p><br></p>\n<p><b>Новости за последние 6 часов</b></p>\n<p><br></p>\n<p>• Новость 1."))
  assert.ok(html.endsWith("<p>• Новость 3. <a href=\"https://news.example/source\">[1]</a></p>"))
  assert.equal(html.split("<p><br></p>").length - 1, 6)
  assert.doesNotMatch(html, /· · ·|🟩|⬜|🟥|• •|⊕|○|⊖|──────|Крипто-пульс|Публикации:|Кандидатов:|Срез по закрытым свечам|P — оценка|без статистической калибровки|Покрытие новостных источников/u)
  assert.deepEqual(candidateParagraphs(release, "Монеты под наблюдением"), [
    "<code>TOP</code> · <b><a href=\"https://www.tradingview.com/chart/?symbol=BINANCE%3ATOPUSDT.P\">Монета TOP</a></b><br>Изменение активности требует наблюдения.",
  ])
  assert.doesNotMatch(html, /Значимые инфоповоды|В выпуске нет дополнительных монет/u)
  assert.doesNotMatch(html, /P движения|уверенность|Нет подтверждения интересом|CoinGecko|Ранние кандидаты в исходном порядке агента/u)
  assert.deepEqual(report, before)
})

test("demo does not change the post heading but still suppresses market links", () => {
  for (const demo of [true, false, "true"]) {
    const report = fixture([coin("TEST", { topRank: 1 })], { demo })
    const release = buildTelegramRelease(report)
    assertManifest(release, report)
    assert.equal(release.demo, demo === true)
    assert.doesNotMatch(release.richMessage.html, /ДЕМО · синтетические данные/iu)
    assert.equal(release.richMessage.html.includes("https://www.tradingview.com/chart/?symbol=BINANCE%3ATESTUSDT.P"), demo !== true)
    assert.deepEqual(candidateParagraphs(release, "Монеты под наблюдением"), [
      `<code>TEST</code> · <b>${demo === true ? "Монета TEST" : "<a href=\"https://www.tradingview.com/chart/?symbol=BINANCE%3ATESTUSDT.P\">Монета TEST</a>"}</b><br>Изменение активности требует наблюдения.`,
    ])
  }
})

test("rich media IDs map deterministically to unique local candidates without leaking paths, credentials or raw history", () => {
  const report = fixture([
    coin("SECOND", { topRank: 2, image: "https://remote.example/private.png", mediaId: "PRIVATE-ID" }),
    coin("FIRST", { topRank: 1, image: "/Users/private/card.png", history: { candles: [{ secret: "PRIVATE-HISTORY" }] } }),
    coin("FIRST-ALIAS", { baseCurrencyId: "XTVCFIRST", socialSignificant: true, socialSentiment: "negative", features: { coingeckoTrending: true } }),
  ], { directory: "/Users/private", source: "PRIVATE-SOURCE", token: "PRIVATE-TOKEN" })
  const release = buildTelegramRelease(report)
  assertManifest(release, report)
  assert.deepEqual(release.candidates.map(({ symbol, mediaId, image }) => ({ symbol, mediaId, image })), [
    { symbol: "FIRST", mediaId: "card_1", image: "cards/01-FIRST.png" },
    { symbol: "SECOND", mediaId: "card_2", image: "cards/02-SECOND.png" },
  ])
  assert.doesNotMatch(JSON.stringify(release.richMessage), /PRIVATE-|\/Users\/|remote\.example|cards\/|history|candles|parse_mode|caption/u)
  assert.deepEqual(buildTelegramRelease(report), release)
})

test("one rich post keeps news and all candidate sections above ordinary text and caption limits", () => {
  const long = "Явное усиление активности требует наблюдения. ".repeat(200)
  const report = fixture(Array.from({ length: 10 }, (_, index) => coin(`LONG-${index}`, {
    topRank: index < 3 ? index + 1 : null,
    technicalExplanation: `Техника-${index} ${long}`,
    explanation: `${index < 3 ? "Техника и новости" : "Инфоповод"}-${index} ${long}`,
    drivers: [`metric=1: PRIVATE-DRIVER-${index}`], counterSignals: ["PRIVATE-RISK"],
    socialSignificant: true, socialSentiment: index < 7 ? "positive" : "negative", socialReason: `PRIVATE-SOCIAL-${index}`,
    features: { coingeckoTrending: true, coingeckoTrendingCategories: [long] },
  })), { marketBrief: brief({
    schemaVersion: 1,
    events: Array.from({ length: 5 }, (_, index) => ({ summary: `Событие-${index} ${long}`, verification: "confirmed" })),
  }) })
  const release = buildTelegramRelease(report)
  assertManifest(release, report)
  const { html } = release.richMessage
  assert.ok([...visibleText(html)].length > 4_096)
  assert.ok(Buffer.byteLength(visibleText(html), "utf8") > 32_768, "Byte limits must not replace character limits")
  assert.equal([...html.matchAll(/Событие-\d/gu)].length, 5)
  assert.equal([...html.matchAll(/Техника и новости-\d/gu)].length, 3)
  assert.equal([...html.matchAll(/Инфоповод-\d/gu)].length, 7)
  assert.equal([...html.matchAll(/<p><code>LONG-\d<\/code> · <b><a href=/gu)].length, 10)
  assert.doesNotMatch(html, /PRIVATE-|Категории:|CoinGecko Trending/u)
  const positions = ["📊 Крипторадар", "</tg-collage>", "<b>Монеты под наблюдением</b>", "<b>📰 Значимые инфоповоды</b>", "<b>Новости за последние 6 часов</b>"]
    .map(marker => html.indexOf(marker))
  assert.ok(positions.every(position => position >= 0))
  assert.deepEqual(positions, [...positions].sort((first, second) => first - second))
  assert.equal(candidateParagraphs(release, "Монеты под наблюдением").length, 3)
  assert.equal(candidateParagraphs(release, "📰 Значимые инфоповоды").length, 7)
  assert.doesNotMatch(html, /Ранние кандидаты в исходном порядке|Дополнительные монеты вне топа|не у всего рынка|Поисковое внимание — не сигнал роста/u)
})

test("invalid report time or timeframe fails explicitly instead of constructing a plausible release", () => {
  for (const report of [
    null, undefined, {}, fixture([], { timeframe: "4h" }), fixture([], { timeframe: undefined }),
    ...[null, undefined, "invalid", "", 1_759_276_800_000, new Date("2026-09-30T23:00:00.000Z"),
      "2026-09-30T23:30:00.000Z", "2026-09-30T23:00:01.000Z", "2026-09-30T23:00:00.001Z"]
      .map(asOf => fixture([], { asOf })),
  ]) {
    assert.throws(() => buildTelegramRelease(report), /часовой отчёт \(asOf, 1h\)/u)
  }
})

test("candidate selection rejects malformed coin lists and empty or non-string symbols", () => {
  for (const report of [
    null, undefined, {}, ...[null, {}, "coins", [null], [[]], [{}], [{ symbol: " \t" }], [{ symbol: 123 }]]
      .map(coins => fixture(coins)),
  ]) {
    assert.throws(() => selectTelegramCandidates(report), /coins с непустыми символами/u)
  }
})
