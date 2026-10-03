import assert from "node:assert/strict"
import http from "node:http"
import https from "node:https"
import test, { beforeEach } from "node:test"

import { isArray, isObject, isString } from "../src/helpers/utils.typed.js"
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
    explanation: "Изменение активности требует наблюдения.",
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
  const section = release.richMessage.html.split(/(?=<p><b>(?:📰|⭐|🟢|🦎) )/u)
    .find(text => text.startsWith(`<p><b>${title}</b>`))
  assert.ok(section, `Missing section: ${title}`)
  return section
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
    const tag = token.match(/^<(\/?)(b|i|a|p|tg-collage)(?: href="([^"<>]+)")?>$/u)
    assert.ok(tag, `Unsupported or incomplete Telegram tag: ${token}`)
    const [, closing, name, href] = tag
    if (closing) {
      assert.equal(href, undefined)
      assert.equal(stack.pop(), name, "Telegram tags must be properly nested")
    } else {
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
  assert.equal(release.candidates.length, Math.min(10, release.eligibleCount))
  assert.equal(release.omittedCount, release.eligibleCount - release.candidates.length)
  assert.equal(new Set(release.candidates.map(item => item.symbol.trim().toUpperCase())).size, release.candidates.length)
  assert.equal(new Set(release.candidates.map(item => item.image)).size, release.candidates.length)
  assert.equal(Object.hasOwn(release, "messages"), false)
  assert.deepEqual(Object.keys(release.richMessage).sort(), ["html", "media"])
  const { html, media } = release.richMessage
  assertTelegramHtml(html)
  assert.deepEqual(media, release.candidates.map(item => ({
    id: item.mediaId, media: { type: "photo", media: `attach://${item.mediaId}` },
  })))
  assert.equal(new Set(media.map(item => item.id)).size, release.candidates.length)
  assert.deepEqual([...html.matchAll(/<img src="tg:\/\/photo\?id=([^"<>]+)"\/>/gu)].map(([, id]) => id), media.map(item => item.id))
  const photos = media.map(item => `<img src="tg://photo?id=${item.id}"/>`).join("")
  assert.ok(html.startsWith(media.length > 1 ? `<tg-collage>${photos}</tg-collage>\n<p>` : `${photos}${photos ? "\n" : ""}<p>`))
  assert.doesNotMatch(html.slice(html.indexOf("<p>")), /<img\b|<tg-collage>/u)
  assert.ok(html.includes("<p><b>📰 Новостная сводка за последние 6 часов</b></p>\n<p><br></p>\n"))
  for (const title of ["📰 Новостная сводка за последние 6 часов", "⭐ Топ агента", "🟢 Позитивные инфоповоды", "🦎 CoinGecko Trending"]) {
    assert.equal(html.split(`<b>${title}</b>`).length - 1, 1)
  }
  for (const [index, item] of release.candidates.entries()) {
    assert.equal(item.number, index + 1)
    assert.equal(item.symbol, report.coins[item.coinIndex].symbol, "coinIndex must refer to the original report order")
    assert.ok(["top", "positive", "coingecko"].includes(item.section))
    assert.match(item.image, /^cards\/\d{2}-[a-z\d_-]{1,40}\.png$/iu)
    assert.ok(item.image.startsWith(`cards/${String(item.number).padStart(2, "0")}-`))
    assert.equal(item.mediaId, `card_${index + 1}`)
    assert.deepEqual(Object.keys(item).sort(), ["coinIndex", "image", "mediaId", "number", "section", "symbol"])
  }
}

test("one shared ten-candidate budget follows topRank, positive news, then CoinGecko without promoting assessments", () => {
  const report = fixture([
    coin("CG-LOW", { movementProbability: 0.1, features: { coingeckoTrending: true } }),
    coin("POS-LOW", { movementProbability: 0.2, socialSignificant: true, socialSentiment: "positive" }),
    coin("TOP-THREE", { topRank: 3, movementProbability: 0.99 }),
    coin("ASSESSMENT-ONLY", { movementProbability: 1 }),
    coin("CG-FIRST", { movementProbability: 0.9, features: { coingeckoTrending: true } }),
    coin("TOP-ONE", { topRank: 1, movementProbability: 0.1, socialSignificant: true, socialSentiment: "positive", features: { coingeckoTrending: true } }),
    coin("POS-FIRST", { movementProbability: 0.8, socialSignificant: true, socialSentiment: "positive" }),
    coin("CG-SECOND", { movementProbability: 0.8, features: { coingeckoTrending: true } }),
    coin("POS-SECOND", { movementProbability: 0.7, socialSignificant: true, socialSentiment: "positive" }),
    coin("TOP-TWO", { topRank: 2, movementProbability: 0.05 }),
    coin("CG-THIRD", { movementProbability: 0.7, features: { coingeckoTrending: true } }),
    coin("POS-THIRD", { movementProbability: 0.6, socialSignificant: true, socialSentiment: "positive", features: { coingeckoTrending: true } }),
    coin("CG-FOURTH", { movementProbability: 0.6, features: { coingeckoTrending: true } }),
  ])
  const selected = selectTelegramCandidates(report)
  assert.deepEqual(selected.candidates.map(({ coinIndex, section }) => [coinIndex, section]), [
    [5, "top"], [9, "top"], [2, "top"], [6, "positive"], [8, "positive"], [11, "positive"], [1, "positive"],
    [4, "coingecko"], [7, "coingecko"], [10, "coingecko"],
  ])
  for (const item of selected.candidates) {
    assert.equal(item.coin, report.coins[item.coinIndex])
  }
  assert.equal(selected.eligibleCount, 12)
  assert.equal(selected.omittedCount, 2)
  const release = buildTelegramRelease(report)
  assertManifest(release, report)
  assert.deepEqual(release.candidates.map(({ coinIndex, section }) => [coinIndex, section]), selected.candidates.map(({ coinIndex, section }) => [coinIndex, section]))
  assert.equal(release.eligibleCount, 12)
  assert.match(release.richMessage.html, /Ещё 2 кандидатов не вошли в общий лимит 10\./u)
  assert.doesNotMatch(release.richMessage.html, /Кандидатов:/u)
  assert.doesNotMatch(release.richMessage.html, /ASSESSMENT-ONLY|CG-LOW|CG-FOURTH/u)
})

test("more than ten top candidates consume the entire shared budget before any supplementary group", () => {
  const coins = Array.from({ length: 14 }, (_, index) => coin(`TOP-${index + 1}`, {
    topRank: index + 1, movementProbability: index / 14,
    socialSignificant: true, socialSentiment: "positive", features: { coingeckoTrending: true },
  })).reverse()
  const report = fixture([
    coin("EXTRA-POS", { movementProbability: 1, socialSignificant: true, socialSentiment: "positive" }),
    ...coins,
    coin("EXTRA-CG", { movementProbability: 1, features: { coingeckoTrending: true } }),
    { ...coins[0], symbol: "TOP-14-ALIAS" },
  ])
  const release = buildTelegramRelease(report)
  assertManifest(release, report)
  assert.deepEqual(release.candidates.map(item => item.symbol), Array.from({ length: 10 }, (_, index) => `TOP-${index + 1}`))
  assert.ok(release.candidates.every(item => item.section === "top"))
  assert.equal(release.eligibleCount, 16, "Duplicates beyond the cap must not inflate omittedCount")
  assert.equal(release.omittedCount, 6)
})

test("an empty report produces explicit empty sections and no invented candidates or images", () => {
  const report = fixture()
  assert.deepEqual(selectTelegramCandidates(report), { candidates: [], eligibleCount: 0, omittedCount: 0 })
  const release = buildTelegramRelease(report)
  assertManifest(release, report)
  assert.deepEqual(release.candidates, [])
  assert.deepEqual(release.richMessage.media, [])
  assert.doesNotMatch(release.richMessage.html, /<img\b|<tg-collage>/u)
  assert.doesNotMatch(release.richMessage.html, /Кандидатов:/u)
  assert.match(sectionHtml(release, "⭐ Топ агента"), /Агент не выделил/u)
  assert.match(sectionHtml(release, "🟢 Позитивные инфоповоды"), /нет дополнительных монет/u)
  assert.match(sectionHtml(release, "🦎 CoinGecko Trending"), /нет дополнительных CoinGecko/u)
})

for (const [section, attributes] of [
  ["top", { topRank: 1 }],
  ["positive", { socialSignificant: true, socialSentiment: "positive" }],
  ["coingecko", { features: { coingeckoTrending: true } }],
]) {
  test(`a single ${section} candidate stays a single photo, without implicit filling or promotion`, () => {
    const report = fixture([coin("UNSELECTED", { movementProbability: 1 }), coin("ONLY", attributes)])
    const release = buildTelegramRelease(report)
    assertManifest(release, report)
    assert.equal(release.eligibleCount, 1)
    assert.equal(release.omittedCount, 0)
    assert.ok(release.richMessage.html.startsWith("<img src=\"tg://photo?id=card_1\"/>"))
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
    ...[false, "true", 1, null].map((socialSignificant, index) => coin(`SOCIAL-${index}`, { socialSignificant, socialSentiment: "positive" })),
    ...["negative", "mixed", "neutral", "Positive", null].map((socialSentiment, index) => coin(`SENTIMENT-${index}`, { socialSignificant: true, socialSentiment })),
    ...[false, "true", 1].map((coingeckoTrending, index) => coin(`CG-${index}`, { features: { coingeckoTrending } })),
  ], { candidateCount: 100, topCandidates: [{ symbol: "RANK-0" }] })
  assert.deepEqual(selectTelegramCandidates(report), { candidates: [], eligibleCount: 0, omittedCount: 0 })
  const release = buildTelegramRelease(report)
  assertManifest(release, report)
  assert.deepEqual(release.candidates, [])
})

test("overlaps, normalized symbols and canonical baseCurrencyId aliases occur once and retain selected badges", () => {
  const report = fixture([
    coin(" alpha ", { baseCurrencyId: "XTVCALPHA", topRank: 2, socialSignificant: true, socialSentiment: "positive", features: { coingeckoTrending: true } }),
    coin("ALPHA", { baseCurrencyId: "OTHER-ID", topRank: 5 }),
    coin("OLD-ALPHA", { baseCurrencyId: " XTVCALPHA ", socialSignificant: true, socialSentiment: "positive", movementProbability: 1 }),
    coin("BETA", { topRank: 1, socialSignificant: true, socialSentiment: "mixed", features: { coingeckoTrending: true } }),
    coin("BETA-ALIAS", { baseCurrencyId: "XTVCBETA", features: { coingeckoTrending: true } }),
    coin("GAMMA", { socialSignificant: true, socialSentiment: "positive", features: { coingeckoTrending: true } }),
    coin(" gamma ", { features: { coingeckoTrending: true } }),
    coin("DELTA", { baseCurrencyId: null, features: { coingeckoTrending: true } }),
    coin("EPSILON", { baseCurrencyId: "", features: { coingeckoTrending: true } }),
    coin("ZETA", { baseCurrencyId: " ", features: { coingeckoTrending: true } }),
  ])
  const release = buildTelegramRelease(report)
  assertManifest(release, report)
  assert.deepEqual(release.candidates.map(item => item.coinIndex), [3, 0, 5, 7, 8, 9])
  assert.equal(release.eligibleCount, 6)
  assert.equal(release.omittedCount, 0)
  assert.match(sectionHtml(release, "⭐ Топ агента"), /01 · BETA[\s\S]*<i>CoinGecko Trending · Смешанный фон<\/i>/u)
  assert.match(sectionHtml(release, "⭐ Топ агента"), /02 · alpha[\s\S]*<i>CoinGecko Trending · Позитивный инфоповод<\/i>/u)
  assert.equal(release.candidates[2].section, "positive")
  assert.match(sectionHtml(release, "🟢 Позитивные инфоповоды"), /03 · GAMMA[\s\S]*<i>CoinGecko Trending · Позитивный инфоповод<\/i>/u)
})

for (const [section, attributes] of [
  ["positive", { socialSignificant: true, socialSentiment: "positive" }],
  ["coingecko", { features: { coingeckoTrending: true } }],
]) {
  test(`${section} sorts valid probabilities descending and preserves input order for all ties`, () => {
    const report = fixture([null, 0.5, 1, 0.5, 0, NaN, "0.99", -0.1, Infinity, 1.1]
      .map((movementProbability, index) => coin(`COIN-${index}`, { ...attributes, movementProbability })))
    const selected = selectTelegramCandidates(report)
    assert.deepEqual(selected.candidates.map(item => item.coinIndex), [2, 1, 3, 4, 0, 5, 6, 7, 8, 9])
    assert.ok(selected.candidates.every(item => item.section === section))
    assert.equal(selected.eligibleCount, 10)
    assert.equal(selected.omittedCount, 0)
    assertManifest(buildTelegramRelease(report), report)
  })
}

test("equal topRank preserves original order instead of resorting by probability", () => {
  const report = fixture([
    coin("SECOND-RANK", { topRank: 2 }), coin("FIRST-TIE", { topRank: 1, movementProbability: 0.1 }),
    coin("SECOND-TIE", { topRank: 1, movementProbability: 0.9 }),
  ])
  assert.deepEqual(selectTelegramCandidates(report).candidates.map(item => item.coinIndex), [1, 2, 0])
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

for (const [sentiment, label] of [["negative", "Негативный инфоповод"], ["mixed", "Смешанный фон"]]) {
  for (const [section, attributes, title] of [
    ["top", { topRank: 1 }, "⭐ Топ агента"],
    ["coingecko", { features: { coingeckoTrending: true } }, "🦎 CoinGecko Trending"],
  ]) {
    test(`${sentiment} news is not positive and is not masked when selected through ${section}`, () => {
      const report = fixture([
        coin("SELECTED", { ...attributes, socialSignificant: true, socialSentiment: sentiment, socialReason: "У вывода есть существенные оговорки." }),
        coin("SOCIAL-ONLY", { socialSignificant: true, socialSentiment: sentiment, movementProbability: 1 }),
      ])
      const release = buildTelegramRelease(report)
      assertManifest(release, report)
      assert.equal(release.eligibleCount, 1)
      assert.equal(release.candidates[0].section, section)
      const text = sectionHtml(release, title)
      assert.ok(text.includes(label))
      assert.match(text, /Инфоповод: У вывода есть существенные оговорки\./u)
      assert.doesNotMatch(text, /Позитивный инфоповод/u)
    })
  }
}

test("stored movement probability is only displayed, never recomputed from social, technical or directional data", () => {
  const report = fixture([coin("TEST", {
    topRank: 1, movementProbability: 0.3749, estimateConfidence: "high", directionBias: "up",
    socialSignificant: true, socialSentiment: "positive",
    features: { coingeckoTrending: true, relVolume: 100, oiChange4h: 100, flags: ["short_squeeze_setup"] },
  })], { marketContext: { altMarketBackground: { status: "up" } } })
  const release = buildTelegramRelease(report)
  const text = release.richMessage.html
  assert.match(sectionHtml(release, "⭐ Топ агента"), /P движения: 37% · уверенность: высокая/u)
  assert.doesNotMatch(text, /P — оценка|без статистической калибровки|Срез по закрытым свечам/u)
  assert.doesNotMatch(text, /P роста|P падения|directionBias|short_squeeze_setup|прогноз направления/u)
  assert.equal(selectTelegramCandidates(report).candidates[0].coin.movementProbability, 0.3749)
  const changed = structuredClone(report)
  Object.assign(changed.coins[0], { directionBias: "down", socialSentiment: "negative", features: {} })
  assert.match(buildTelegramRelease(changed).richMessage.html, /P движения: 37%/u)
})

test("zero, one and missing or invalid probabilities remain distinct, without clamping or invented estimates", () => {
  for (const [movementProbability, expected] of [
    [0, "0%"], [1, "100%"], [0.625, "63%"], [null, "нет оценки"], [undefined, "нет оценки"],
    [NaN, "нет оценки"], [Infinity, "нет оценки"], [-0.01, "нет оценки"], [1.01, "нет оценки"], ["0.8", "нет оценки"],
  ]) {
    const report = fixture([coin("TEST", { topRank: 1, movementProbability, estimateConfidence: "unknown" })])
    const release = buildTelegramRelease(report)
    assertManifest(release, report)
    const text = sectionHtml(release, "⭐ Топ агента")
    assert.ok(text.includes(`P движения: ${expected} · уверенность: не указана`))
    assert.doesNotMatch(text, /NaN|Infinity/u)
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

test("candidate explanations, positive technical notes and counter-signals show prose rather than metric evidence", () => {
  const attributes = {
    explanation: "", drivers: [`peers=${JSON.stringify({ note: "a: \"b: c\"" })}: Ускорение интереса.`, "rvRatio=0.5: Сжатие диапазона.", "unused=1: ТРЕТИЙ ДРАЙВЕР"],
    counterSignals: ["risk={\"note\":\"x: y\"}: Нет подтверждения.", "funding=0.01: Перегрев позиций.", "unused=1: ТРЕТИЙ РИСК"],
  }
  const report = fixture([
    coin("TOP", { ...attributes, topRank: 1 }),
    coin("POS", { ...attributes, socialSignificant: true, socialSentiment: "positive", socialReason: "Новость требует проверки." }),
    coin("CG", { ...attributes, features: { coingeckoTrending: true } }),
  ])
  const release = buildTelegramRelease(report)
  assertManifest(release, report)
  for (const title of ["⭐ Топ агента", "🟢 Позитивные инфоповоды", "🦎 CoinGecko Trending"]) {
    const text = sectionHtml(release, title)
    assert.match(text, /Ускорение интереса\./u)
    assert.match(text, /⚠ Нет подтверждения\. Перегрев позиций\./u)
    assert.doesNotMatch(text, /peers=|rvRatio=|risk=|funding=|ТРЕТИЙ ДРАЙВЕР|ТРЕТИЙ РИСК/u)
  }
  assert.match(sectionHtml(release, "🟢 Позитивные инфоповоды"), /Техника: Ускорение интереса\./u)
  const withExplanation = buildTelegramRelease(fixture([coin("TOP", { ...attributes, topRank: 1, explanation: "Готовое объяснение агента." })]))
  assert.match(withExplanation.richMessage.html, /Готовое объяснение агента\./u)
  assert.doesNotMatch(withExplanation.richMessage.html, /Ускорение интереса/u)
})

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
  assert.match(release.richMessage.html, /<b>01 · HUGE-MARKET<\/b>/u)
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
    name: `NAME${unsafe}`, explanation: `WHY${unsafe}`, drivers: [`metric=1: DRIVER${unsafe}`],
    counterSignals: [`metric=2: RISK${unsafe}`], socialSignificant: true, socialSentiment: "positive", socialReason: `SOCIAL${unsafe}`,
    features: { coingeckoTrending: true, coingeckoTrendingCategories: [`CATEGORY${unsafe}`, 123] },
    history: { warning: `PRIVATE-HISTORY${unsafe}` }, information: { news: { status: "failed", error: `PRIVATE-ERROR${unsafe}` } },
  }
  const report = fixture([
    coin(`SYMBOL${unsafe}`, { ...attributes, topRank: 1, marketSymbol: `BINANCE:${unsafe}` }),
    coin("POS", attributes),
    coin("CG", { ...attributes, explanation: "", socialSentiment: "negative" }),
  ], { marketBrief: brief({
    paragraphs: [{ text: `BRIEF${unsafe}`, sourceIds: ["s"] }], warning: `WARNING${unsafe}`,
    sources: [{ id: "s", url: "https://news.example/?q=\" onclick=\"alert(1)&b=<script>", title: unsafe, publisher: unsafe }],
  }) })
  const release = buildTelegramRelease(report)
  assertManifest(release, report)
  const text = release.richMessage.html
  for (const prefix of ["SYMBOL", "NAME", "WHY", "DRIVER", "RISK", "SOCIAL", "CATEGORY", "BRIEF", "WARNING"]) {
    assert.ok(text.includes(`${prefix}${escaped}`), `Missing escaped ${prefix}`)
  }
  assert.ok(sectionHtml(release, "⭐ Топ агента").includes(`SYMBOL${escaped}`))
  assert.doesNotMatch(text, /<img src=x|<script|PRIVATE-ERROR|PRIVATE-HISTORY|metric=/u)
  assert.match(text, /График с оговорками/u)
  assert.match(text, /Не все источники новостей и обсуждений удалось загрузить/u)
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

for (const [section, title] of [["top", "⭐ Топ агента"], ["positive", "🟢 Позитивные инфоповоды"], ["coingecko", "🦎 CoinGecko Trending"]]) {
  test(`long escaped ${section} candidates keep whole blocks, concise fields and a single section title`, () => {
    const long = "<&\"🙂>".repeat(1_000)
    const report = fixture(Array.from({ length: 10 }, (_, index) => coin(`COIN-${index}-${long}`, {
      name: long, topRank: section === "top" ? index + 1 : null, marketSymbol: `BINANCE:${"X".repeat(450)}${index}`,
      explanation: long, drivers: [`metric=1: ${long}`], counterSignals: [`risk=1: ${long}`, long],
      socialSignificant: true, socialSentiment: section === "coingecko" ? "mixed" : "positive", socialReason: long,
      features: { coingeckoTrending: true, coingeckoTrendingCategories: [long] },
    })))
    const release = buildTelegramRelease(report)
    assertManifest(release, report)
    assert.equal(release.candidates.length, 10)
    assert.ok(release.candidates.every(item => item.section === section))
    const text = sectionHtml(release, title)
    assert.ok(text.length > 4_096)
    assert.equal(text.split(`<b>${title}</b>`).length - 1, 1)
    assert.deepEqual([...text.matchAll(/<p><b><a href="[^"]+">(\d{2}) · /gu)].map(match => Number(match[1])),
      Array.from({ length: 10 }, (_, index) => index + 1))
    const blocks = [...text.matchAll(/<p><b><a href=[\s\S]*?<\/p>/gu)].map(([block]) => block)
    assert.equal(blocks.length, 10)
    assert.ok(blocks.every(block => block.includes("…") && block.length < 2_300))
    assert.ok(text.startsWith(`<p><b>${title}</b><br>`))
    assert.doesNotMatch(release.richMessage.html, /P — оценка|в любую сторону за 4–12ч/u)
  })
}

for (const schemaVersion of [3, 4]) {
  for (const count of [0, 1, 2, 3, 4, 5, 6]) {
    test(`v${schemaVersion} renders ${count} items as at most five bullets with up to ten distinct citations, without mutating input`, () => {
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
      const text = sectionHtml(release, "📰 Новостная сводка за последние 6 часов")
      const bullets = [...text.matchAll(/<p>((?:•|<b>[⊕○⊖]<\/b>) [\s\S]*?)<\/p>/gu)].map(([, item]) => item)
      assert.equal(text.split("<p>──────</p>").length - 1, Math.max(0, Math.min(count, 5) - 1))
      assert.ok(text.includes(bullets.map(item => `<p>${item}</p>`).join("\n<p>──────</p>\n")))
      assert.deepEqual(bullets, items.slice(0, 5).map((item, index) => `${schemaVersion === 4 ? "<b>⊕</b> " : "• "}${item.text} ${item.sourceIds
        .map((id, citation) => `<a href="https://news.example/${id}">[${index * 2 + citation + 1}]</a>`).join(" ")}`))
      assert.equal([...text.matchAll(/<a href=/gu)].length, Math.min(count, 5) * 2)
      assert.doesNotMatch(text, /Сохранённая сводка рынка|НЕ ИСПОЛЬЗОВАТЬ V1|Пункт 6\./u)
      if (schemaVersion === 4) {
        assert.doesNotMatch(text, /•|🟢|⚪|🔴/u)
      }
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
    const text = sectionHtml(release, "📰 Новостная сводка за последние 6 часов")
    assert.equal(text.split("<p>──────</p>").length - 1, 3)
    assert.ok(text.startsWith(`<p><b>📰 Новостная сводка за последние 6 часов</b></p>\n<p><br></p>\n<p>${schemaVersion === 4 ? "<b>⊖</b>" : "•"} Первый`))
    assert.deepEqual([...text.matchAll(/<p>((?:•|<b>[⊕○⊖]<\/b>) [\s\S]*?)<\/p>/gu)].map(([, item]) => item), [
      ["⊖ ", "Первый &lt;пункт&gt; &amp; &quot;цитата&quot;. <a href=\"https://news.example/b?x=1&amp;y=2\">[1]</a> <a href=\"http://news.example/a\">[2]</a>"],
      ["⊕ ", "Второй пункт. <a href=\"https://news.example/c\">[3]</a> <a href=\"https://news.example/b?x=1&amp;y=2\">[1]</a>"],
      ["○ ", "Третий пункт. <a href=\"https://news.example/d\">[4]</a> <a href=\"http://news.example/a\">[2]</a>"],
      ["⊖ ", "Четвёртый пункт. <a href=\"https://news.example/d\">[4]</a>"],
    ].map(([marker, item]) => `${schemaVersion === 4 ? `<b>${marker.trim()}</b> ` : "• "}${item}`))
    assert.doesNotMatch(text, /javascript:|missing|\[5\]|🟢|⚪|🔴/u)
    if (schemaVersion === 4) {
      assert.doesNotMatch(text, /•/u)
    }
    assert.deepEqual(buildTelegramRelease(report), release)
    assert.deepEqual(report, before)
  })

  test(`v${schemaVersion} missing or malformed items never fall back to archival paragraphs or events`, () => {
    for (const items of [undefined, null, {}, "not an array"]) {
      const report = fixture([], { marketBrief: brief({ schemaVersion, items, events: [{ summary: "НЕ ИСПОЛЬЗОВАТЬ V1" }] }) })
      const release = buildTelegramRelease(report)
      assertManifest(release, report)
      const text = sectionHtml(release, "📰 Новостная сводка за последние 6 часов")
      assert.doesNotMatch(text, /──────/u)
      assert.match(text, /Содержательная сводка не подготовлена; доступных данных недостаточно/u)
      assert.doesNotMatch(text, /Сохранённая сводка рынка|НЕ ИСПОЛЬЗОВАТЬ V1|<p>(?:•|<b>[⊕○⊖]<\/b>) /u)
    }
  })
}

for (const [schemaVersion, sentiment, marker] of [[3, undefined, "• "], [4, "bullish", "⊕ "], [4, "neutral", "○ "], [4, "bearish", "⊖ "]]) {
  test(`v${schemaVersion} ${sentiment ?? "archival"} text keeps the 250 UTF-16 boundary excluding markers, links and HTML escaping`, () => {
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
      const bullets = [...sectionHtml(release, "📰 Новостная сводка за последние 6 часов").matchAll(/<p>((?:•|<b>[⊕○⊖]<\/b>) [\s\S]*?)<\/p>/gu)]
        .map(([, item]) => visibleText(item))
      assert.deepEqual(bullets, [`${marker}${expected} [1] [2]`])
      assert.ok(bullets[0].slice(marker.length).replace(/ \[1\] \[2\]$/u, "").length <= 250)
    }
  })
}

test("v3 archives never infer sentiment labels from news text", () => {
  const items = ["Позитивная новость о росте.", "Нейтральное обновление.", "Негативная новость о падении."]
    .map(text => ({ text, sourceIds: ["s"] }))
  const report = deepFreeze(fixture([], { marketBrief: brief({
    schemaVersion: 3, items, sources: [{ id: "s", url: "https://news.example/s" }],
  }) }))
  const release = buildTelegramRelease(report)
  assertManifest(release, report)
  const text = sectionHtml(release, "📰 Новостная сводка за последние 6 часов")
  assert.deepEqual([...text.matchAll(/<p>• ([\s\S]*?)<\/p>/gu)].map(([, item]) => visibleText(item)), items.map(item => `${item.text} [1]`))
  assert.doesNotMatch(text, /⊕|○|⊖|🟢|⚪|🔴/u)
})

test("v4 missing or invalid sentiment renders no marker without defaulting or inferring classification", () => {
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
    const text = sectionHtml(release, "📰 Новостная сводка за последние 6 часов")
    assert.deepEqual([...text.matchAll(/<p>(Позитивная новость[\s\S]*?)<\/p>/gu)].map(([, item]) => item), [
      "Позитивная новость &lt;&amp;&quot;&gt;. <a href=\"https://news.example/s\">[1]</a>",
    ])
    assert.doesNotMatch(text, /•|⊕|○|⊖|🟢|⚪|🔴/u)
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
  const text = sectionHtml(release, "📰 Новостная сводка за последние 6 часов")
  assert.ok(text.includes("Первый абзац. <a href=\"https://news.example/b?x=1&amp;y=2\">[1]</a> <a href=\"http://news.example/a\">[2]</a>"))
  assert.ok(text.includes("Второй абзац. <a href=\"http://news.example/a\">[2]</a> <a href=\"https://news.example/b?x=1&amp;y=2\">[1]</a>"))
  assert.doesNotMatch(text, /Лишний абзац|УСТАРЕВШЕЕ СОБЫТИЕ|НЕ ИСПОЛЬЗОВАТЬ V3|javascript:|\[3\]|<p>• /u)
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
  const paragraphs = [...sectionHtml(release, "📰 Новостная сводка за последние 6 часов").matchAll(/<p>((?:Первый|Второй) абзац\.[\s\S]*?)<\/p>/gu)]
    .map(([, text]) => text)
  assert.deepEqual(paragraphs, [
    "Первый абзац. <a href=\"https://news.example/a\">[1]</a> <a href=\"https://news.example/b\">[2]</a>",
    "Второй абзац. <a href=\"https://news.example/f\">[3]</a> <a href=\"https://news.example/c\">[4]</a>",
  ])
})

test("legacy v1 events retain unconfirmed warnings, summaries, significance and safe citations", () => {
  const report = fixture([], { marketBrief: brief({
    schemaVersion: 1, paragraphs: [{ text: "НЕ ИСПОЛЬЗОВАТЬ V2" }], items: [{ text: "НЕ ИСПОЛЬЗОВАТЬ V3" }],
    events: [
      { summary: "Возможный инцидент <не проверен>.", whyItMatters: "Доступность & ликвидность под вопросом.", verification: "unconfirmed", sourceIds: ["s"] },
      { summary: "Подтверждённое обновление.", whyItMatters: "Меняется инфраструктура.", verification: "confirmed", sourceIds: [] },
    ],
    sources: [{ id: "s", url: "https://news.example/event" }],
  }) })
  const release = buildTelegramRelease(report)
  assertManifest(release, report)
  const text = sectionHtml(release, "📰 Новостная сводка за последние 6 часов")
  assert.match(text, /Не подтверждено: Возможный инцидент &lt;не проверен&gt;\. Доступность &amp; ликвидность под вопросом\./u)
  assert.match(text, /Подтверждённое обновление\. Меняется инфраструктура\./u)
  assert.equal(text.split("Не подтверждено:").length - 1, 1)
  assert.match(text, /<a href="https:\/\/news\.example\/event">\[1\]<\/a>/u)
  assert.doesNotMatch(text, /НЕ ИСПОЛЬЗОВАТЬ V2|НЕ ИСПОЛЬЗОВАТЬ V3|<p>• /u)
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
    const text = sectionHtml(release, "📰 Новостная сводка за последние 6 часов")
    assert.ok(text.length > 4_096)
    assert.equal(text.split("<b>📰 Новостная сводка за последние 6 часов</b>").length - 1, 1)
    assert.equal(text.split("<p>──────</p>").length - 1, schemaVersion === 2 ? 1 : 4)
    assert.doesNotMatch(text, /<p>──────<\/p>\n<p>⚠/u)
    assert.equal([...text.matchAll(schemaVersion === 2 ? /Абзац-\d/gu : /Не подтверждено: Событие-\d/gu)].length, schemaVersion === 2 ? 2 : 5)
    assert.equal([...text.matchAll(/<a href=/gu)].length, schemaVersion === 2 ? 4 : 10)
    const prose = [...text.matchAll(/<p>((?:Абзац-|Не подтверждено: Событие-)[\s\S]*?) <a /gu)].map(([, paragraph]) => paragraph)
    assert.equal(prose.length, schemaVersion === 2 ? 2 : 5)
    assert.ok(prose.every(paragraph => visibleText(paragraph).length > 250))
    assert.doesNotMatch(text, /<p>• /u)
    assert.match(text, /⚠ Оговорка/u)
  })
}

test("missing, unsupported or mismatched market briefs never leak stale prose, links or publication windows", () => {
  for (const overrides of [
    undefined, null, ...[0, 5, 99, "4"].map(schemaVersion => ({ schemaVersion })),
    ...[1, 2, 3, 4].map(schemaVersion => ({ schemaVersion, marketAsOf: "2026-09-30T22:00:00.000Z" })),
  ]) {
    const marketBrief = overrides
      ? brief({
          ...overrides, status: "partial", warning: "НЕ ПОКАЗЫВАТЬ ОГОВОРКУ",
          items: [{ text: "НЕ ПОКАЗЫВАТЬ V3/V4", sentiment: "bearish", sourceIds: ["s"] }],
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
    assert.doesNotMatch(release.richMessage.html, /НЕ ПОКАЗЫВАТЬ|Публикации:|<a |⚠/u)
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
  for (const schemaVersion of [2, 3, 4]) {
    test(`v${schemaVersion} brief ${status}, ${paragraphs.length} entries and ${coverage[0]?.status ?? "healthy"} coverage have distinct wording`, () => {
      const report = fixture([], { marketBrief: brief({
        schemaVersion, status, paragraphs, items: paragraphs.map(item => ({ ...item, sentiment: "neutral" })), coverage, warning: "Оговорка <&\"🙂>",
      }) })
      const release = buildTelegramRelease(report)
      assertManifest(release, report)
      const text = sectionHtml(release, "📰 Новостная сводка за последние 6 часов")
      assert.match(text, expected)
      assert.doesNotMatch(text, absent)
      assert.doesNotMatch(text, /Публикации:|──────/u)
      assert.match(text, /⚠ Оговорка &lt;&amp;&quot;🙂&gt;/u)
    })
  }
}

test("failed coin news and Twitter sources warn instead of masquerading as a healthy empty sample", () => {
  for (const source of ["news", "twitter"]) {
    for (const status of ["available", "empty", "failed"]) {
      const report = fixture([coin("TEST", { topRank: 1, information: { [source]: { status, error: "PRIVATE-SOURCE-ERROR" } } })])
      const text = buildTelegramRelease(report).richMessage.html
      assert.equal(text.includes("Не все источники новостей и обсуждений удалось загрузить."), status === "failed")
      assert.doesNotMatch(text, /PRIVATE-SOURCE-ERROR/u)
    }
  }
})

test("unsafe and huge saved source URLs are omitted without fetching or dropping the grounded prose", () => {
  const sources = [
    "javascript:alert(1)", "data:text/html,<img src=x>", "https://user:secret@news.example/a", "file:///etc/passwd",
    `https://news.example/${"x".repeat(1_000)}`, "https://news.example/safe",
  ].map((url, index) => ({ id: `s${index}`, url }))
  const paragraphs = [{ text: "Сохранённое сообщение с ограничениями.", sourceIds: sources.map(source => source.id) }]
  for (const schemaVersion of [2, 3, 4]) {
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

test("title keeps report creation time while the publication window is replaced by a blank line", () => {
  for (const schemaVersion of [2, 3, 4]) {
    const marketBrief = brief({ schemaVersion, items: [{ text: "Сохранённая сводка рынка.", sentiment: "neutral", sourceIds: [] }] })
    const report = fixture([coin("TEST", { topRank: 1 })], { marketBrief })
    const release = buildTelegramRelease(report)
    assertManifest(release, report)
    assert.equal(release.closedAt, "2026-10-01T00:00:00.000Z")
    assert.match(release.richMessage.html, /📊 Крипторадар \| 1 октября 2026, 10:45 МСК/u)
    assert.doesNotMatch(release.richMessage.html, /Публикации:|01\.10\.2026, 03:30|01\.10\.2026, 09:30/u)
    assert.doesNotMatch(release.richMessage.html, /1 октября 2026, 03:00|30\.09\.2026, 23:00/u)
    for (const window of [
      { from: "invalid" }, { asOf: "invalid" }, { from: "2026-10-01T07:00:00.000Z" }, { from: null },
    ]) {
      const result = buildTelegramRelease(fixture([], { marketBrief: { ...marketBrief, ...window } }))
      assert.match(result.richMessage.html, /Сохранённая сводка рынка/u)
      assert.doesNotMatch(result.richMessage.html, /Публикации:/u)
    }
  }
  assert.equal(reportTime("2026-12-31T23:00:00.000Z"), "01.01.2027, 02:00")
  assert.throws(() => reportTime("not a date"), RangeError)
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
    assert.deepEqual(buildTelegramRelease(report), release)
  }
})

test("compact opening has bold sentiment markers, news separators and blank lines without changing later sections", () => {
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
  assert.ok(html.includes("<p><b>📊 Крипторадар | 27 сентября 2026, 11:03 МСК</b></p>\n<p><br></p>\n<p><b>📰 Новостная сводка за последние 6 часов</b></p>\n<p><br></p>\n<p><b>⊕</b> Новость 1."))
  for (const [index, marker] of ["⊕", "○", "⊖"].entries()) {
    assert.ok(html.includes(`<p><b>${marker}</b> Новость ${index + 1}. <a href="https://news.example/source">[1]</a></p>`))
  }
  assert.ok(html.includes("Новость 3. <a href=\"https://news.example/source\">[1]</a></p>\n<p><br></p>\n<p><b>⭐ Топ агента</b><br>Ранние кандидаты в исходном порядке агента.</p>"))
  assert.equal(html.split("<p><br></p>").length - 1, 3)
  assert.equal(html.split("<p>──────</p>").length - 1, 2)
  assert.doesNotMatch(html, /Крипто-пульс|Публикации:|Кандидатов:|Срез по закрытым свечам|P — оценка|без статистической калибровки|Покрытие новостных источников|• [⊕○⊖]/u)
  assert.match(sectionHtml(release, "⭐ Топ агента"), /P движения: 50% · уверенность: средняя/u)
  assert.match(sectionHtml(release, "⭐ Топ агента"), /⚠ Нет подтверждения интересом\./u)
  assert.match(sectionHtml(release, "🟢 Позитивные инфоповоды"), /нет дополнительных монет/u)
  assert.match(sectionHtml(release, "🦎 CoinGecko Trending"), /нет дополнительных CoinGecko/u)
  assert.deepEqual(report, before)
})

test("only an explicit demo flag labels the single post synthetic and suppresses market links", () => {
  for (const demo of [true, false, "true"]) {
    const report = fixture([coin("TEST", { topRank: 1 })], { demo })
    const release = buildTelegramRelease(report)
    assertManifest(release, report)
    assert.equal(release.demo, demo === true)
    assert.equal([...release.richMessage.html.matchAll(/ДЕМО · синтетические данные/giu)].length, demo === true ? 1 : 0)
    assert.equal(release.richMessage.html.includes("https://www.tradingview.com/chart/?symbol=BINANCE%3ATESTUSDT.P"), demo !== true)
  }
})

test("rich media IDs map deterministically to unique local candidates without leaking paths, credentials or raw history", () => {
  const report = fixture([
    coin("SECOND", { topRank: 2, image: "https://remote.example/private.png", mediaId: "PRIVATE-ID" }),
    coin("FIRST", { topRank: 1, image: "/Users/private/card.png", history: { candles: [{ secret: "PRIVATE-HISTORY" }] } }),
    coin("FIRST-ALIAS", { baseCurrencyId: "XTVCFIRST", features: { coingeckoTrending: true } }),
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
    explanation: `Описание-${index} ${long}`, drivers: [`metric=1: Техника-${index} ${long}`], counterSignals: [long, long],
    socialSignificant: true, socialSentiment: index < 7 ? "positive" : "mixed", socialReason: `Фон-${index} ${long}`,
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
  assert.equal([...html.matchAll(/Фон-\d/gu)].length, 10)
  assert.equal([...html.matchAll(/<p><b><a href=/gu)].length, 10)
  const titles = ["📰 Новостная сводка за последние 6 часов", "⭐ Топ агента", "🟢 Позитивные инфоповоды", "🦎 CoinGecko Trending"]
  const positions = [html.indexOf("</tg-collage>"), ...titles.map(title => html.indexOf(`<b>${title}</b>`))]
  assert.deepEqual(positions, [...positions].sort((first, second) => first - second))
  assert.match(sectionHtml(release, "🟢 Позитивные инфоповоды"), /Позитивная новость — не технический сигнал.*не у всего рынка/u)
  assert.match(sectionHtml(release, "🦎 CoinGecko Trending"), /Поисковое внимание — не сигнал роста/u)
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
