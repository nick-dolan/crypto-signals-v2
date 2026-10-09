import { isArray, isString } from "../../helpers/utils.typed.js"
import { reportTitleTime, telegramLink, telegramText } from "./telegram-format.js"

export function renderTelegramHtml (report, { candidates, createdAt }) {
  const photos = candidates.map(item => `<img src="tg://photo?id=${item.mediaId}"/>`).join("")
  const topCandidates = candidates.filter(item => item.section === "top")
  const newsCandidates = candidates.filter(item => item.section === "news")
  const brief = matchingBrief(report)
  const html = []

  html.push(`<p><b>📊 Крипторадар | ${reportTitleTime(createdAt)} МСК</b></p>`)

  if (photos) {
    html.push(candidates.length > 1 ? `<tg-collage>${photos}</tg-collage>` : photos)
  } else {
    html.push("<p><br></p>")
  }

  html.push("<p><b>👀 Монеты под наблюдением</b></p>")
  html.push("<p><br></p>")

  for (const [index, item] of topCandidates.entries()) {
    if (index) {
      html.push("<p><br></p>")
    }
    html.push(`<p>${candidateBlock(report.coins[item.coinIndex], report.demo === true)}</p>`)
  }
  if (!topCandidates.length) {
    html.push("<p>Агент не выделил убедительных ранних кандидатов.</p>")
  }

  if (newsCandidates.length) {
    html.push("<p><br></p>")
    html.push("<p><b>📰 Значимые инфоповоды</b></p>")
    html.push("<p><br></p>")

    for (const [index, item] of newsCandidates.entries()) {
      if (index) {
        html.push("<p><br></p>")
      }
      html.push(`<p>${candidateBlock(report.coins[item.coinIndex], report.demo === true)}</p>`)
    }
  }

  html.push("<p><br></p>")
  html.push(`<p><b>🕒 ${briefTitle(brief)}</b></p>`)
  html.push("<p><br></p>")

  for (const [index, item] of briefItems(brief).entries()) {
    if (index) {
      html.push("<p><br></p>")
    }
    html.push(`<p>${item}</p>`)
  }
  if (brief?.warning) {
    html.push(`<p>⚠ ${telegramText(brief.warning, 300)}</p>`)
  }

  return html.join("\n")
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
  const explanation = observation
    || telegramText(coin.socialSignificant === true ? coin.explanation : coin.technicalExplanation, 1_200)
    || (coin.socialSignificant === true ? telegramText(coin.socialReason, 320) : "")
  return [candidateHeading(coin, demo), explanation].filter(Boolean).join("<br>")
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

function briefItems (brief) {
  if (!brief) {
    return ["Сводка недоступна или относится к другому срезу. Отсутствие данных не означает отсутствие событий."]
  }
  if (!["available", "partial", "empty"].includes(brief.status)) {
    return ["Сводка недоступна. Отсутствие данных не означает отсутствие событий."]
  }

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
    const emoji = [4, 5].includes(brief.schemaVersion)
      ? paragraph.sentiment === "bullish" ? "🚀" : paragraph.sentiment === "bearish" ? "📉" : ""
      : ""
    return [`• ${title ? `<b>${title}</b><br>` : ""}${text}${emoji ? ` ${emoji}` : ""}${citations.length ? ` ${citations.join(" ")}` : ""}`]
  })
  return content.length
    ? content
    : [brief.status === "empty"
        ? "В полученной выборке нет сообщений для сводки."
        : "Содержательная сводка не подготовлена; доступных данных недостаточно."]
}
