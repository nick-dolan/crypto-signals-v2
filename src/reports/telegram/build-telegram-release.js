import { isArray, isFinite, isObject, isSafeInteger, isString } from "../../helpers/utils.typed.js"
import { renderTelegramHtml } from "./render-telegram-html.js"
import { telegramRichMessage } from "./telegram-format.js"

function probability (coin) {
  return isFinite(coin.movementProbability) && coin.movementProbability >= 0 && coin.movementProbability <= 1
    ? coin.movementProbability
    : null
}

function significantNews (coin) {
  return coin.socialSignificant === true && ["bullish", "bearish", "positive", "negative"].includes(coin.socialSentiment)
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

  const closedAt = new Date(asOf + 3_600_000).toISOString()
  const createdAt = isString(report.reportCreatedAt) && isFinite(Date.parse(report.reportCreatedAt))
    ? report.reportCreatedAt
    : closedAt
  const html = renderTelegramHtml(report, { candidates, createdAt })

  return {
    schemaVersion: 2,
    asOf: report.asOf,
    closedAt,
    demo: report.demo === true,
    eligibleCount: selection.eligibleCount,
    omittedCount: selection.omittedCount,
    candidates,
    richMessage: telegramRichMessage(html, candidates.map(item => ({
      id: item.mediaId, media: { type: "photo", media: `attach://${item.mediaId}` },
    }))),
  }
}
