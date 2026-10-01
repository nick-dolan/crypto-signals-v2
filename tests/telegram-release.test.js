import assert from "node:assert/strict"
import http from "node:http"
import https from "node:https"
import test, { beforeEach } from "node:test"

import { isArray, isObject, isString } from "../src/helpers/utils.typed.js"
import { buildTelegramRelease, selectTelegramCandidates } from "../src/reports/telegram/build-telegram-release.js"
import { reportTime, signalText, telegramLink, telegramMessages, telegramText } from "../src/reports/telegram/telegram-format.js"

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

function sectionMessages (release, title) {
  return release.messages.filter(({ text }) => text.includes(`<b>${title}</b>`))
}

function assertEscaped (text) {
  assert.doesNotMatch(text, /[<>]|&(?!(?:amp|lt|gt|quot);)/u, "Unescaped text or incomplete HTML entity")
}

function decodeEntities (text) {
  return text.replace(/&(amp|lt|gt|quot);/gu, (_, name) => ({ amp: "&", lt: "<", gt: ">", quot: "\"" })[name])
}

function assertTelegramHtml (text, limit) {
  assert.ok(isString(text))
  assert.ok(text.length <= limit, `Encoded HTML has ${text.length} characters; limit is ${limit}`)
  assert.ok(text.isWellFormed(), "Truncation must not split a surrogate pair")
  const stack = []
  // Validate each message independently: tags and entities cannot continue on another page.
  for (const [token] of text.matchAll(/<[^>]*>|[^<]+|</gu)) {
    if (!token.startsWith("<")) {
      assertEscaped(token)
      continue
    }
    const tag = token.match(/^<(\/?)(b|i|a)(?: href="([^"<>]+)")?>$/u)
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
      stack.push(name)
    }
  }
  assert.deepEqual(stack, [], "Each message must close all its own tags")
}

function assertManifest (release, report) {
  assert.equal(Object.getPrototypeOf(release), Object.prototype)
  assert.deepEqual(JSON.parse(JSON.stringify(release)), release, "Manifest must contain only plain JSON data")
  assert.equal(release.schemaVersion, 1)
  assert.equal(release.asOf, report.asOf)
  assert.equal(Date.parse(release.closedAt) - Date.parse(report.asOf), 3_600_000)
  assert.equal(release.candidates.length, Math.min(10, release.eligibleCount))
  assert.equal(release.omittedCount, release.eligibleCount - release.candidates.length)
  assert.equal(new Set(release.candidates.map(item => item.symbol.trim().toUpperCase())).size, release.candidates.length)
  assert.equal(new Set(release.candidates.map(item => item.image)).size, release.candidates.length)
  assert.ok(release.messages.length > 0)
  for (const message of release.messages) {
    assertTelegramHtml(message.text, 4_096)
    assert.equal(message.parse_mode, "HTML")
    assert.deepEqual(message.link_preview_options, { is_disabled: true })
  }
  for (const [index, item] of release.candidates.entries()) {
    assert.equal(item.number, index + 1)
    assert.equal(item.symbol, report.coins[item.coinIndex].symbol, "coinIndex must refer to the original report order")
    assert.ok(["top", "positive", "coingecko"].includes(item.section))
    assert.match(item.image, /^cards\/\d{2}-[a-z\d_-]{1,40}\.png$/iu)
    assert.ok(item.image.startsWith(`cards/${String(item.number).padStart(2, "0")}-`))
    assert.equal(item.parse_mode, "HTML")
    assertTelegramHtml(item.caption, 1_024)
    assert.equal(Object.hasOwn(item, "coin"), false)
    assert.equal(Object.hasOwn(item, "history"), false)
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
  assert.match(release.messages[0].text, /Кандидатов: 10\/10.*\nЕщё 2 кандидатов/su)
  assert.doesNotMatch(release.messages.map(item => item.text).join("\n"), /ASSESSMENT-ONLY|CG-LOW|CG-FOURTH/u)
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
  assert.equal(release.messages.length, 4)
  assert.match(release.messages[0].text, /Кандидатов: 0\/10/u)
  assert.match(release.messages[1].text, /Агент не выделил/u)
  assert.match(release.messages[2].text, /нет дополнительных монет/u)
  assert.match(release.messages[3].text, /нет дополнительных CoinGecko/u)
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
  assert.match(release.candidates[0].caption, /Топ агента.*Также в CoinGecko Trending\..*Смешанный фон/su)
  assert.match(release.candidates[1].caption, /Топ агента.*Также в CoinGecko Trending\..*Позитивный инфоповод/su)
  assert.equal(release.candidates[2].section, "positive")
  assert.match(release.candidates[2].caption, /Позитивный инфоповод.*Также в CoinGecko Trending\./su)
  assert.match(sectionMessages(release, "⭐ Топ агента")[0].text, /<i>CoinGecko Trending · Позитивный инфоповод<\/i>/u)
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
      assert.ok(release.candidates[0].caption.includes(label))
      const text = sectionMessages(release, title).map(item => item.text).join("\n")
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
  const text = sectionMessages(release, "⭐ Топ агента")[0].text
  for (const output of [text, release.candidates[0].caption]) {
    assert.match(output, /P движения: 37% · уверенность: высокая/u)
    assert.match(output, /в любую сторону/u)
    assert.match(output, /4–12ч/u)
    assert.match(output, /не откалибрована|без статистической калибровки/u)
    assert.doesNotMatch(output, /P роста|P падения|directionBias|short_squeeze_setup|прогноз направления/u)
  }
  assert.equal(selectTelegramCandidates(report).candidates[0].coin.movementProbability, 0.3749)
  const changed = structuredClone(report)
  Object.assign(changed.coins[0], { directionBias: "down", socialSentiment: "negative", features: {} })
  assert.match(buildTelegramRelease(changed).candidates[0].caption, /P движения: 37%/u)
})

test("zero, one and missing or invalid probabilities remain distinct, without clamping or invented estimates", () => {
  for (const [movementProbability, expected] of [
    [0, "0%"], [1, "100%"], [0.625, "63%"], [null, "нет оценки"], [undefined, "нет оценки"],
    [NaN, "нет оценки"], [Infinity, "нет оценки"], [-0.01, "нет оценки"], [1.01, "нет оценки"], ["0.8", "нет оценки"],
  ]) {
    const report = fixture([coin("TEST", { topRank: 1, movementProbability, estimateConfidence: "unknown" })])
    const release = buildTelegramRelease(report)
    assertManifest(release, report)
    for (const output of [release.candidates[0].caption, sectionMessages(release, "⭐ Топ агента")[0].text]) {
      assert.ok(output.includes(`P движения: ${expected} · уверенность: не указана`))
      assert.doesNotMatch(output, /NaN|Infinity/u)
    }
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
    const text = sectionMessages(release, title)[0].text
    assert.match(text, /Ускорение интереса\./u)
    assert.match(text, /⚠ Нет подтверждения\. Перегрев позиций\./u)
    assert.doesNotMatch(text, /peers=|rvRatio=|risk=|funding=|ТРЕТИЙ ДРАЙВЕР|ТРЕТИЙ РИСК/u)
  }
  assert.match(sectionMessages(release, "🟢 Позитивные инфоповоды")[0].text, /Техника: Ускорение интереса\./u)
  const withExplanation = buildTelegramRelease(fixture([coin("TOP", { ...attributes, topRank: 1, explanation: "Готовое объяснение агента." })]))
  assert.match(withExplanation.messages[1].text, /Готовое объяснение агента\./u)
  assert.doesNotMatch(withExplanation.messages[1].text, /Ускорение интереса/u)
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
  assert.match(release.messages[1].text, /<b>01 · HUGE-MARKET<\/b>/u)
  assert.doesNotMatch(release.messages[1].text, /<a /u)
})

test("telegramMessages packs complete escaped blocks to the exact cap, repeating titles across page boundaries", () => {
  const heading = "<b>Рынок &amp; новости</b>"
  const block = `<i>${"x".repeat(4_096 - heading.length - 2 - "<i>&amp;🙂</i>".length)}&amp;🙂</i>`
  const blocks = deepFreeze([null, "", block, "<b>Следующая &lt;монета&gt;</b>"])
  const messages = telegramMessages(heading, blocks)
  assert.deepEqual(messages.map(item => item.text), [`${heading}\n\n${block}`, `${heading}\n\n${blocks[3]}`])
  assert.equal(messages[0].text.length, 4_096)
  for (const message of messages) {
    assertTelegramHtml(message.text, 4_096)
    assert.equal(message.parse_mode, "HTML")
    assert.deepEqual(message.link_preview_options, { is_disabled: true })
  }
  assert.deepEqual(telegramMessages(heading, [null, ""]).map(item => item.text), [heading])
  assert.throws(() => telegramMessages(heading, [`${block}x`]), /блок.*превышает лимит/iu)
})

test("telegramMessages rejects an oversized heading even when there are no content blocks", () => {
  const heading = `<b>${"x".repeat(4_096 - 7)}</b>`
  assertTelegramHtml(telegramMessages(heading, [])[0].text, 4_096)
  assert.throws(() => telegramMessages(`${heading}x`, []), /лимит/iu)
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
  const text = release.messages.map(item => item.text).join("\n")
  for (const prefix of ["SYMBOL", "NAME", "WHY", "DRIVER", "RISK", "SOCIAL", "CATEGORY", "BRIEF", "WARNING"]) {
    assert.ok(text.includes(`${prefix}${escaped}`), `Missing escaped ${prefix}`)
  }
  assert.ok(release.candidates[0].caption.includes(`SYMBOL${escaped}`))
  assert.doesNotMatch(text, /<img|<script|PRIVATE-ERROR|PRIVATE-HISTORY|metric=/u)
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
  test(`long escaped ${section} candidates paginate on whole blocks with repeated titles and bounded captions`, () => {
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
    assert.ok(release.candidates.every(item => item.section === section && item.caption.includes("…")))
    const pages = sectionMessages(release, title)
    assert.ok(pages.length > 1, "Fixture must exercise real pagination")
    assert.deepEqual(pages.flatMap(({ text }) => [...text.matchAll(/^<b><a href="[^"]+">(\d{2}) · /gmu)].map(match => Number(match[1]))),
      Array.from({ length: 10 }, (_, index) => index + 1))
    for (const { text } of pages) {
      assert.ok(text.startsWith(`<b>${title}</b>\n`))
      assert.match(text, /в любую сторону за 4–12ч/u)
    }
  })
}

test("v2 paragraphs use stored prose and stable deduplicated citations, ignoring legacy events and unknown sources", () => {
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
  }) })
  const release = buildTelegramRelease(report)
  assertManifest(release, report)
  const text = release.messages[0].text
  assert.ok(text.includes("Первый абзац. <a href=\"https://news.example/b?x=1&amp;y=2\">[1]</a> <a href=\"http://news.example/a\">[2]</a>"))
  assert.ok(text.includes("Второй абзац. <a href=\"http://news.example/a\">[2]</a> <a href=\"https://news.example/b?x=1&amp;y=2\">[1]</a>"))
  assert.doesNotMatch(text, /Лишний абзац|УСТАРЕВШЕЕ СОБЫТИЕ|javascript:|\[3\]/u)
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
  const paragraphs = sectionMessages(release, "📰 Новостная сводка")
    .flatMap(({ text }) => text.split("\n\n"))
    .filter(block => /^(?:Первый|Второй) абзац\./u.test(block))
  assert.deepEqual(paragraphs, [
    "Первый абзац. <a href=\"https://news.example/a\">[1]</a> <a href=\"https://news.example/b\">[2]</a>",
    "Второй абзац. <a href=\"https://news.example/f\">[3]</a> <a href=\"https://news.example/c\">[4]</a>",
  ])
})

test("legacy v1 events retain unconfirmed warnings, summaries, significance and safe citations", () => {
  const report = fixture([], { marketBrief: brief({
    schemaVersion: 1, paragraphs: [{ text: "НЕ ИСПОЛЬЗОВАТЬ V2" }],
    events: [
      { summary: "Возможный инцидент <не проверен>.", whyItMatters: "Доступность & ликвидность под вопросом.", verification: "unconfirmed", sourceIds: ["s"] },
      { summary: "Подтверждённое обновление.", whyItMatters: "Меняется инфраструктура.", verification: "confirmed", sourceIds: [] },
    ],
    sources: [{ id: "s", url: "https://news.example/event" }],
  }) })
  const release = buildTelegramRelease(report)
  assertManifest(release, report)
  assert.match(release.messages[0].text, /Не подтверждено: Возможный инцидент &lt;не проверен&gt;\. Доступность &amp; ликвидность под вопросом\./u)
  assert.match(release.messages[0].text, /Подтверждённое обновление\. Меняется инфраструктура\./u)
  assert.equal(release.messages[0].text.split("Не подтверждено:").length - 1, 1)
  assert.match(release.messages[0].text, /<a href="https:\/\/news\.example\/event">\[1\]<\/a>/u)
  assert.doesNotMatch(release.messages[0].text, /НЕ ИСПОЛЬЗОВАТЬ V2/u)
})

for (const schemaVersion of [1, 2]) {
  test(`v${schemaVersion} long briefs keep citations, entities, warnings and repeated news titles intact across pages`, () => {
    const sources = ["a", "b"].map(id => ({ id, url: `https://news.example/${id}/${"x".repeat(540)}` }))
    const report = fixture([], { marketBrief: brief({
      schemaVersion, sources, warning: "Оговорка <&\"🙂>".repeat(100),
      paragraphs: Array.from({ length: 2 }, (_, index) => ({ text: `Абзац-${index} ${"<&\"🙂>".repeat(500)}`, sourceIds: ["a", "b"] })),
      events: Array.from({ length: 5 }, (_, index) => ({ summary: `Событие-${index} ${"<&\"🙂>".repeat(500)}`, verification: "unconfirmed", sourceIds: ["a", "b"] })),
    }) })
    const release = buildTelegramRelease(report)
    assertManifest(release, report)
    const pages = sectionMessages(release, "📰 Новостная сводка")
    assert.ok(pages.length > 1)
    const heading = pages[0].text.split("<b>📰 Новостная сводка</b>")[0] + "<b>📰 Новостная сводка</b>"
    for (const { text } of pages) {
      assert.ok(text.startsWith(heading))
    }
    const text = pages.map(item => item.text).join("\n")
    assert.equal([...text.matchAll(schemaVersion === 2 ? /Абзац-\d/gu : /Не подтверждено: Событие-\d/gu)].length, schemaVersion === 2 ? 2 : 5)
    assert.equal([...text.matchAll(/<a href=/gu)].length, schemaVersion === 2 ? 4 : 10)
    assert.match(text, /⚠ Оговорка/u)
  })
}

test("missing, unsupported or mismatched market briefs never leak stale prose, links or publication windows", () => {
  for (const marketBrief of [undefined, null, brief({ schemaVersion: 3 }), brief({ marketAsOf: "2026-09-30T22:00:00.000Z" })]) {
    const report = fixture([], { marketBrief })
    const release = buildTelegramRelease(report)
    assertManifest(release, report)
    assert.match(release.messages[0].text, /Сводка недоступна или относится к другому срезу/u)
    assert.match(release.messages[0].text, /Отсутствие данных не означает отсутствие событий/u)
    assert.doesNotMatch(release.messages[0].text, /Сохранённая сводка|Публикации:|<a /u)
  }
})

for (const [status, paragraphs, coverage, expected, absent] of [
  ["unavailable", [{ text: "НЕ ПОКАЗЫВАТЬ" }], [], /Сводка недоступна\. Отсутствие данных не означает отсутствие событий/u, /НЕ ПОКАЗЫВАТЬ|нет сообщений|Покрытие/u],
  ["empty", [{ text: "НЕ ПОКАЗЫВАТЬ" }], [], /В полученной выборке нет сообщений для сводки/u, /НЕ ПОКАЗЫВАТЬ|Сводка недоступна|Покрытие/u],
  ["partial", [{ text: "Доступная часть новостей." }], [], /Доступная часть новостей\.[\s\S]*Покрытие новостных источников неполное/u, /нет сообщений|Сводка недоступна/u],
  ["partial", [{ text: " \n\t", sourceIds: ["missing"] }, { text: null }], [], /Содержательная сводка не подготовлена[\s\S]*Покрытие новостных источников неполное/u, /нет сообщений|Сводка недоступна|<a /u],
  ["available", [], [], /Содержательная сводка не подготовлена; доступных данных недостаточно/u, /нет сообщений|Сводка недоступна|Покрытие/u],
  ["available", [{ text: "Доступная часть новостей." }], [{ source: "twitter", status: "failed", error: "PRIVATE-HTTP-429" }], /Доступная часть новостей\.[\s\S]*Покрытие новостных источников неполное/u, /PRIVATE-HTTP-429|Сводка недоступна/u],
  ["empty", [], [{ source: "tradingview", status: "partial" }], /нет сообщений для сводки[\s\S]*Покрытие новостных источников неполное/u, /Сводка недоступна/u],
]) {
  test(`brief ${status}, ${paragraphs.length} paragraphs and ${coverage[0]?.status ?? "healthy"} coverage have distinct wording`, () => {
    const report = fixture([], { marketBrief: brief({ status, paragraphs, coverage }) })
    const release = buildTelegramRelease(report)
    assertManifest(release, report)
    assert.match(release.messages[0].text, expected)
    assert.doesNotMatch(release.messages[0].text, absent)
  })
}

test("failed coin news and Twitter sources warn instead of masquerading as a healthy empty sample", () => {
  for (const source of ["news", "twitter"]) {
    for (const status of ["available", "empty", "failed"]) {
      const report = fixture([coin("TEST", { topRank: 1, information: { [source]: { status, error: "PRIVATE-SOURCE-ERROR" } } })])
      const text = buildTelegramRelease(report).messages[1].text
      assert.equal(text.includes("Не все источники новостей и обсуждений удалось загрузить."), status === "failed")
      assert.doesNotMatch(text, /PRIVATE-SOURCE-ERROR/u)
    }
  }
})

test("unsafe and huge saved source URLs are omitted without fetching or dropping the grounded paragraph", () => {
  const sources = [
    "javascript:alert(1)", "data:text/html,<img src=x>", "https://user:secret@news.example/a", "file:///etc/passwd",
    `https://news.example/${"x".repeat(1_000)}`, "https://news.example/safe",
  ].map((url, index) => ({ id: `s${index}`, url }))
  const report = fixture([], { marketBrief: brief({ sources, paragraphs: [{ text: "Сохранённое сообщение с ограничениями.", sourceIds: sources.map(source => source.id) }] }) })
  const release = buildTelegramRelease(report)
  assertManifest(release, report)
  assert.match(release.messages[0].text, /Сохранённое сообщение с ограничениями\./u)
  assert.deepEqual([...release.messages[0].text.matchAll(/<a href="([^"]+)">\[(\d+)\]<\/a>/gu)].map(([, url, number]) => [url, number]), [
    ["https://news.example/safe", "1"],
  ])
  assert.doesNotMatch(release.messages[0].text, /javascript:|data:|file:|secret/u)
})

test("news publication window, market candle close and report creation are separate clocks", () => {
  const report = fixture([coin("TEST", { topRank: 1 })], { marketBrief: brief() })
  const release = buildTelegramRelease(report)
  assertManifest(release, report)
  assert.equal(release.closedAt, "2026-10-01T00:00:00.000Z")
  assert.match(release.messages[0].text, /Крипто-сигналы · 01\.10\.2026, 03:00 МСК/u)
  assert.match(release.messages[0].text, /Публикации: 01\.10\.2026, 03:30 — 01\.10\.2026, 09:30 МСК/u)
  assert.match(release.candidates[0].caption, /Срез закрыт: 01\.10\.2026, 03:00 МСК/u)
  assert.doesNotMatch(release.messages[0].text, /10:45|30\.09\.2026, 23:00/u)
  assert.equal(reportTime("2026-12-31T23:00:00.000Z"), "01.01.2027, 02:00")
  assert.throws(() => reportTime("not a date"), RangeError)
  for (const window of [
    { from: "invalid" }, { asOf: "invalid" }, { from: "2026-10-01T07:00:00.000Z" }, { from: null },
  ]) {
    const result = buildTelegramRelease(fixture([], { marketBrief: brief(window) }))
    assert.match(result.messages[0].text, /Сохранённая сводка рынка/u)
    assert.doesNotMatch(result.messages[0].text, /Публикации:/u)
  }
})

test("only an explicit demo flag labels every message and caption synthetic and suppresses market links", () => {
  for (const demo of [true, false, "true"]) {
    const report = fixture([coin("TEST", { topRank: 1 })], { demo })
    const release = buildTelegramRelease(report)
    assertManifest(release, report)
    assert.equal(release.demo, demo === true)
    for (const text of [...release.messages.map(item => item.text), ...release.candidates.map(item => item.caption)]) {
      assert.equal(/ДЕМО · синтетические данные/iu.test(text), demo === true)
    }
    assert.equal(release.messages[1].text.includes("https://www.tradingview.com/chart/?symbol=BINANCE%3ATESTUSDT.P"), demo !== true)
  }
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
