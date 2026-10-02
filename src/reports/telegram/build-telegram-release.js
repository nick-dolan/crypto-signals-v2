import { isArray, isFinite, isObject, isSafeInteger, isString } from "../../helpers/utils.typed.js"
import { reportTime, signalText, telegramLink, telegramRichMessage, telegramSection, telegramText } from "./telegram-format.js"

function probability (coin) {
  return isFinite(coin.movementProbability) && coin.movementProbability >= 0 && coin.movementProbability <= 1
    ? coin.movementProbability
    : null
}

function positiveNews (coin) {
  return coin.socialSignificant === true && coin.socialSentiment === "positive"
}

export function selectTelegramCandidates (report) {
  if (!isArray(report?.coins) || report.coins.some(coin => !isObject(coin) || !isString(coin.symbol) || !coin.symbol.trim())) {
    throw new Error("Telegram-выпуск требует coins с непустыми символами монет")
  }
  const byProbability = (first, second) => (probability(second) ?? -1) - (probability(first) ?? -1)
  const groups = [
    ["top", report.coins.filter(coin => isSafeInteger(coin.topRank) && coin.topRank > 0)
      .sort((first, second) => first.topRank - second.topRank)],
    ["positive", report.coins.filter(positiveNews).sort(byProbability)],
    ["coingecko", report.coins.filter(coin => coin.features?.coingeckoTrending === true).sort(byProbability)],
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
  return { candidates: eligible.slice(0, 10), eligibleCount: eligible.length, omittedCount: Math.max(0, eligible.length - 10) }
}

function estimate (coin) {
  const value = probability(coin)
  return `P движения: ${value === null ? "нет оценки" : `${Math.round(value * 100)}%`} · уверенность: ${{
    high: "высокая", medium: "средняя", low: "низкая",
  }[coin.estimateConfidence] ?? "не указана"}`
}

function socialLabel (coin) {
  return coin.socialSignificant === true
    ? {
        positive: "Позитивный инфоповод", negative: "Негативный инфоповод", mixed: "Смешанный фон", neutral: "Значимый инфоповод",
      }[coin.socialSentiment]
    : null
}

function candidateHeading (coin, number, demo) {
  const label = `${String(number).padStart(2, "0")} · ${coin.symbol}`
  const url = !demo && isString(coin.marketSymbol) && coin.marketSymbol.trim()
    ? `https://www.tradingview.com/chart/?symbol=${encodeURIComponent(coin.marketSymbol)}`
    : null
  return `<b>${telegramLink(label, url) ?? telegramText(label, 100)}</b>${coin.name ? ` — ${telegramText(coin.name, 100)}` : ""}`
}

function candidateBlock (item, number, demo) {
  const { coin, section } = item
  const badges = [
    coin.features?.coingeckoTrending === true ? "CoinGecko Trending" : null,
    socialLabel(coin),
  ].filter(Boolean)
  const risks = (isArray(coin.counterSignals) ? coin.counterSignals : []).slice(0, 2).map(signalText).filter(Boolean)
  const explanation = telegramText(coin.explanation, 520)
    || telegramText((isArray(coin.drivers) ? coin.drivers : []).slice(0, 2).map(signalText).filter(Boolean).join(" "), 520)
  const background = telegramText(coin.socialReason, 320)
  const categories = coin.features?.coingeckoTrending === true && isArray(coin.features.coingeckoTrendingCategories)
    ? telegramText(coin.features.coingeckoTrendingCategories.filter(isString).join(", "), 140)
    : ""
  return [
    candidateHeading(coin, number, demo),
    estimate(coin),
    badges.length ? `<i>${badges.join(" · ")}</i>` : null,
    section === "positive"
      ? `Инфоповод: ${background || "Позитивный фон отмечен, но пояснение в отчёте отсутствует."}`
      : explanation || "Краткое объяснение в отчёте отсутствует.",
    section !== "positive" && coin.socialSignificant === true
      ? `Инфоповод: ${background || "Пояснение в отчёте отсутствует."}`
      : null,
    section === "positive" && (coin.drivers ?? []).length
      ? `Техника: ${telegramText(signalText(coin.drivers[0]), 220) || "Нет краткого пояснения."}`
      : null,
    categories ? `Категории: ${categories}` : null,
    risks.length ? `⚠ ${telegramText(risks.join(" "), 360)}` : null,
    coin.information?.news?.status === "failed" || coin.information?.twitter?.status === "failed"
      ? "⚠ Не все источники новостей и обсуждений удалось загрузить."
      : null,
    coin.history?.warning ? "⚠ График с оговорками по данным; см. карточку." : null,
  ].filter(Boolean).join("\n")
}

function briefItemText (value) {
  const text = isString(value) ? value.replace(/\s+/gu, " ").replace(/\p{Cc}/gu, "").trim() : ""
  // Count text before HTML escaping, without splitting a surrogate pair at the limit.
  return telegramText(text.length <= 250 ? text : `${text.slice(0, 249).replace(/[\uD800-\uDBFF]$/u, "")}…`, Infinity)
}

function briefBlocks (report) {
  const brief = report.marketBrief
  if (!brief || brief.marketAsOf !== report.asOf || ![1, 2, 3, 4].includes(brief.schemaVersion)) {
    return ["Сводка недоступна или относится к другому срезу. Отсутствие данных не означает отсутствие событий."]
  }
  const blocks = []
  if ([brief.from, brief.asOf].every(value => isString(value) && isFinite(Date.parse(value)))
    && Date.parse(brief.from) <= Date.parse(brief.asOf)) {
    blocks.push(`<i>Публикации: ${reportTime(brief.from)} — ${reportTime(brief.asOf)} МСК.</i>`)
  }
  if (!["available", "partial", "empty"].includes(brief.status)) {
    blocks.push("Сводка недоступна. Отсутствие данных не означает отсутствие событий.")
  } else {
    const paragraphs = brief.status === "empty"
      ? []
      : [3, 4].includes(brief.schemaVersion)
          ? (isArray(brief.items) ? brief.items : []).slice(0, 5)
          : brief.schemaVersion === 2
            ? (isArray(brief.paragraphs) ? brief.paragraphs : []).slice(0, 2)
            : (isArray(brief.events) ? brief.events : []).slice(0, 5).map(event => ({
                text: `${event.verification === "unconfirmed" ? "Не подтверждено: " : ""}${[event.summary, event.whyItMatters].filter(isString).join(" ")}`,
                sourceIds: event.sourceIds,
              }))
    const sources = new Map((isArray(brief.sources) ? brief.sources : []).map(source => [source.id, source]))
    const numbers = new Map()
    const content = paragraphs.flatMap((paragraph) => {
      const text = [3, 4].includes(brief.schemaVersion) ? briefItemText(paragraph.text) : telegramText(paragraph.text, 1_200)
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
      const emoji = brief.schemaVersion !== 4
        ? ""
        : paragraph.sentiment === "bullish"
          ? "🟢 "
          : paragraph.sentiment === "neutral"
            ? "⚪ "
            : paragraph.sentiment === "bearish" ? "🔴 " : ""
      return [`${[3, 4].includes(brief.schemaVersion) ? "• " : ""}${emoji}${text}${citations.length ? ` ${citations.join(" ")}` : ""}`]
    })
    blocks.push(...(content.length
      ? content
      : [brief.status === "empty"
          ? "В полученной выборке нет сообщений для сводки."
          : "Содержательная сводка не подготовлена; доступных данных недостаточно."]))
  }
  if (brief.status === "partial" || (brief.coverage ?? []).some(source => ["partial", "failed"].includes(source.status))) {
    blocks.push("⚠ Покрытие новостных источников неполное.")
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
  const introductory = [
    report.demo === true ? "<b>ДЕМО · СИНТЕТИЧЕСКИЕ ДАННЫЕ</b>" : null,
    `<b>Крипто-сигналы · ${reportTime(closedAt)} МСК</b>`,
    `Кандидатов: ${selection.candidates.length}/10. Срез по закрытым свечам.`,
    selection.omittedCount ? `Ещё ${selection.omittedCount} кандидатов не вошли в общий лимит 10.` : null,
    "P — оценка сильного движения в любую сторону за 4–12ч, без статистической калибровки.",
  ].filter(Boolean).join("\n")
  const sections = [
    candidates.length > 1 ? `<tg-collage>${photos}</tg-collage>` : photos,
    telegramSection(introductory, []),
    telegramSection("<b>📰 Новостная сводка</b>", briefBlocks(report)),
  ]
  for (const [section, title, description, empty] of [
    ["top", "⭐ Топ агента", "Ранние кандидаты в исходном порядке агента.", "Агент не выделил убедительных ранних кандидатов."],
    ["positive", "🟢 Позитивные инфоповоды", "Дополнительные монеты вне топа. Позитивная новость — не технический сигнал. Фон проверен у топа и CoinGecko-монет, не у всего рынка.", "В выпуске нет дополнительных монет с позитивным значимым инфоповодом."],
    ["coingecko", "🦎 CoinGecko Trending", "Дополнительный список наблюдения. Поисковое внимание — не сигнал роста.", "В выпуске нет дополнительных CoinGecko-кандидатов."],
  ]) {
    const blocks = selection.candidates.flatMap((item, index) => item.section === section
      ? [candidateBlock(item, index + 1, report.demo === true)]
      : [])
    sections.push(telegramSection(`<b>${title}</b>\n${description}`, blocks.length ? blocks : [empty]))
  }
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
