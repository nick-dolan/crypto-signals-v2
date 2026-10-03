import { isArray, isFinite, isObject, isSafeInteger, isString } from "../../helpers/utils.typed.js"
import { reportTitleTime, telegramLink, telegramRichMessage, telegramSection, telegramText } from "./telegram-format.js"

function probability (coin) {
  return isFinite(coin.movementProbability) && coin.movementProbability >= 0 && coin.movementProbability <= 1
    ? coin.movementProbability
    : null
}

function significantNews (coin) {
  return coin.socialSignificant === true && ["positive", "negative"].includes(coin.socialSentiment)
}

export function selectTelegramCandidates (report) {
  if (!isArray(report?.coins) || report.coins.some(coin => !isObject(coin) || !isString(coin.symbol) || !coin.symbol.trim())) {
    throw new Error("Telegram-выпуск требует coins с непустыми символами монет")
  }
  const byProbability = (first, second) => (probability(second) ?? -1) - (probability(first) ?? -1)
  const groups = [
    ["top", report.coins.filter(coin => isSafeInteger(coin.topRank) && coin.topRank > 0)
      .sort((first, second) => first.topRank - second.topRank)],
    ["news", report.coins.filter(significantNews).sort(byProbability)],
  ]
  const symbols = new Set()
  const coinIds = new Set()
  const eligible = []
  for (const [section, coins] of groups) {
    for (const coin of coins) {
      const symbol = coin.symbol.trim().toUpperCase()
      const id = isString(coin.baseCurrencyId) ? coin.baseCurrencyId.trim() : null
      if (symbols.has(symbol) || (id && coinIds.has(id))) {
        continue
      }
      symbols.add(symbol)
      if (id) {
        coinIds.add(id)
      }
      eligible.push({ coin, coinIndex: report.coins.indexOf(coin), section })
    }
  }
  return { candidates: eligible, eligibleCount: eligible.length, omittedCount: 0 }
}

function candidateHeading (coin, demo) {
  const name = telegramText(coin.name, 100)
  const url = !demo && isString(coin.marketSymbol) && coin.marketSymbol.trim()
    ? `https://www.tradingview.com/chart/?symbol=${encodeURIComponent(coin.marketSymbol)}`
    : null
  return `<b>${telegramText(coin.symbol, 100)}</b>${name ? ` · <b>${telegramLink(coin.name, url) ?? name}</b>` : ""}`
}

function candidateBlock (coin, demo) {
  const summary = coin.socialSignificant === true ? coin.summary : coin.technicalSummary
  const observation = telegramText(summary?.observation, 1_200)
  const caveat = observation ? telegramText(summary?.caveat, 720) : ""
  const explanation = observation
    || telegramText(coin.socialSignificant === true ? coin.explanation : coin.technicalExplanation, 1_200)
    || (coin.socialSignificant === true ? telegramText(coin.socialReason, 320) : "")
  return [candidateHeading(coin, demo), explanation, caveat ? `<b>Оговорка:</b> ${caveat}` : ""].filter(Boolean).join("\n")
}

function briefItemText (value) {
  const text = isString(value) ? value.replace(/\s+/gu, " ").replace(/\p{Cc}/gu, "").trim() : ""
  // Count text before HTML escaping, without splitting a surrogate pair at the limit.
  return telegramText(text.length <= 250 ? text : `${text.slice(0, 249).replace(/[\uD800-\uDBFF]$/u, "")}…`, Infinity)
}

function matchingBrief (report) {
  const brief = report.marketBrief
  return brief?.marketAsOf === report.asOf && [1, 2, 3, 4, 5].includes(brief.schemaVersion) ? brief : null
}

function briefTitle (brief) {
  const from = isString(brief?.from) ? Date.parse(brief.from) : NaN
  const asOf = isString(brief?.asOf) ? Date.parse(brief.asOf) : NaN
  const hours = (asOf - from) / 3_600_000
  return hours === 6 ? "Новости за последние 6 часов" : hours === 24 ? "Новости за последние 24 часа" : "Новости"
}

function briefBlocks (brief) {
  if (!brief) {
    return ["Сводка недоступна или относится к другому срезу. Отсутствие данных не означает отсутствие событий."]
  }

  const blocks = []

  if (!["available", "partial", "empty"].includes(brief.status)) {
    blocks.push("Сводка недоступна. Отсутствие данных не означает отсутствие событий.")
  } else {
    const paragraphs = brief.status === "empty"
      ? []
      : [3, 4, 5].includes(brief.schemaVersion)
          ? (isArray(brief.items) ? brief.items : []).slice(0, 5)
          : brief.schemaVersion === 2
            ? (isArray(brief.paragraphs) ? brief.paragraphs : []).slice(0, 2)
            : (isArray(brief.events) ? brief.events : []).slice(0, 5).map(event => ({
                title: event.title,
                text: `${event.verification === "unconfirmed" ? "Не подтверждено: " : ""}${[event.summary, event.whyItMatters].filter(isString).join(" ")}`,
                sourceIds: event.sourceIds,
              }))
    const sources = new Map((isArray(brief.sources) ? brief.sources : []).map(source => [source.id, source]))
    const numbers = new Map()
    const content = paragraphs.flatMap((paragraph) => {
      const text = [3, 4, 5].includes(brief.schemaVersion) ? briefItemText(paragraph.text) : telegramText(paragraph.text, 1_200)
      const title = [1, 5].includes(brief.schemaVersion) ? telegramText(paragraph.title, 400) : ""
      if (!text) {
        return []
      }
      const citations = [...new Set(isArray(paragraph.sourceIds) ? paragraph.sourceIds : [])]
        .filter(id => telegramLink("Источник", sources.get(id)?.url))
        .slice(0, 2)
        .map((id) => {
          const number = numbers.get(id) ?? numbers.size + 1
          numbers.set(id, number)
          return telegramLink(`[${number}]`, sources.get(id)?.url)
        })
      return [`• ${title ? `<b>${title}</b>\n` : ""}${text}${citations.length ? ` ${citations.join(" ")}` : ""}`]
    })
    blocks.push(...(content.length
      ? content.flatMap((item, index) => index ? ["<br>", item] : [item])
      : [brief.status === "empty"
          ? "В полученной выборке нет сообщений для сводки."
          : "Содержательная сводка не подготовлена; доступных данных недостаточно."]))
  }

  if (brief.warning) {
    blocks.push(`⚠ ${telegramText(brief.warning, 300)}`)
  }
  return blocks
}

export function buildTelegramRelease (report) {
  const asOf = isString(report?.asOf) ? Date.parse(report.asOf) : NaN
  if (report?.timeframe !== "1h" || !isSafeInteger(asOf) || asOf % 3_600_000 !== 0) {
    throw new Error("Telegram-выпуск требует сохранённый часовой отчёт (asOf, 1h)")
  }

  const selection = selectTelegramCandidates(report)

  const candidates = selection.candidates.map((item, index) => ({
    symbol: item.coin.symbol,
    section: item.section,
    coinIndex: item.coinIndex,
    number: index + 1,
    image: `cards/${String(index + 1).padStart(2, "0")}-${item.coin.symbol.replace(/[^a-z\d_-]+/gi, "_").slice(0, 40)}.png`,
    mediaId: `card_${index + 1}`,
  }))

  const photos = candidates.map(item => `<img src="tg://photo?id=${item.mediaId}"/>`).join("")
  const closedAt = new Date(asOf + 3_600_000).toISOString()
  const createdAt = isString(report.reportCreatedAt) && isFinite(Date.parse(report.reportCreatedAt))
    ? report.reportCreatedAt
    : closedAt
  const sections = [telegramSection(`<b>📊 Крипторадар | ${reportTitleTime(createdAt)} МСК</b>`, [])]

  if (photos) {
    sections.push(candidates.length > 1 ? `<tg-collage>${photos}</tg-collage>` : photos)
  }

  for (const [section, title] of [["top", "Монеты под наблюдением"], ["news", "📰 Значимые инфоповоды"]]) {
    const blocks = selection.candidates.flatMap(item => item.section === section
      ? [candidateBlock(item.coin, report.demo === true)]
      : [])

    if (section === "news" && !blocks.length) {
      continue
    }

    sections.push(section === "top" && photos ? null : "<p><br></p>", telegramSection(`<b>${title}</b>`, [
      "<br>",
      ...(blocks.length
        ? blocks.flatMap((block, index) => index ? ["<br>", block] : [block])
        : ["Агент не выделил убедительных ранних кандидатов."]),
    ]))
  }
  const brief = matchingBrief(report)
  sections.push("<p><br></p>", telegramSection(`<b>${briefTitle(brief)}</b>`, ["<br>", ...briefBlocks(brief)]))

  return {
    schemaVersion: 2,
    asOf: report.asOf,
    closedAt,
    demo: report.demo === true,
    eligibleCount: selection.eligibleCount,
    omittedCount: selection.omittedCount,
    candidates,
    richMessage: telegramRichMessage(sections.filter(Boolean).join("\n"), candidates.map(item => ({
      id: item.mediaId, media: { type: "photo", media: `attach://${item.mediaId}` },
    }))),
  }
}
