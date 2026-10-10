import { fileURLToPath } from "node:url"
import { Resvg } from "@resvg/resvg-js"
import { scaleLinear, scaleUtc } from "d3-scale"
import { line } from "d3-shape"

import { isFinite } from "../../helpers/utils.typed.js"
import { buildCoinCardData, buildPatternChartData } from "./build-coin-card-data.js"

function escapeXml (value) {
  return String(value).replace(/[&<>"']/g, character => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&apos;",
  })[character]).replace(/\p{Cc}/gu, "")
}

function shorten (value, length) {
  const characters = [...String(value ?? "")]
  return characters.length > length ? `${characters.slice(0, length - 1).join("")}…` : characters.join("")
}

function text (x, y, value, { size = 22, color = "#edf2fb", weight = 400, anchor = "start" } = {}) {
  return `<text x="${x}" y="${y}" font-size="${size}" fill="${color}" font-weight="${weight}" text-anchor="${anchor}">${escapeXml(value)}</text>`
}

function number (value, options = {}) {
  return isFinite(value) ? new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 2, ...options }).format(value) : "Нет данных"
}

function price (value) {
  return number(value, {
    maximumSignificantDigits: 6,
    notation: value > 0 && value < 0.000001 ? "scientific" : "standard",
  })
}

function percent (value) {
  return isFinite(value) ? `${number(value, { signDisplay: "exceptZero" })}%` : "Нет данных"
}

function compact (value) {
  return number(value, { notation: "compact", maximumSignificantDigits: 3 })
}

function directionColor (value) {
  return !isFinite(value) || value === 0 ? "#edf2fb" : value > 0 ? "#49d6a3" : "#fa7685"
}

function timestamp (seconds, withYear = false, timeZone = "Europe/Moscow") {
  return new Intl.DateTimeFormat("ru-RU", {
    timeZone, day: "2-digit", month: "2-digit",
    ...(withYear ? { year: "numeric" } : {}), hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).format(new Date(seconds * 1_000))
}

function valueScale (values, top, bottom, zero = false) {
  const low = Math.min(...values)
  const high = Math.max(...values)
  const padding = (high - low || high * 0.02 || 1) * 0.1
  return scaleLinear()
    .domain([zero ? 0 : Math.max(0, low - padding), high + padding])
    .range([bottom, top])
}

function grid (x, y, format, count) {
  return [
    ...x.ticks(5).map(tick => `<line x1="${x(tick)}" x2="${x(tick)}" y1="${y.range()[1]}" y2="${y.range()[0]}" stroke="#223047"/>`),
    ...y.ticks(count).map(tick => `<line x1="76" x2="1012" y1="${y(tick)}" y2="${y(tick)}" stroke="#223047"/>
      ${text(1032, y(tick) + 6, format(tick), { size: 18, color: "#92a3bc" })}`),
  ].join("")
}

function panel (id, top, height, title, coverage, content) {
  return `<g id="${id}">
    <rect x="48" y="${top}" width="1104" height="${height}" rx="18" fill="#111c2e"/>
    ${text(72, top + 34, title, { size: 20, weight: 700 })}
    ${text(1128, top + 34, `${coverage}/168 ч`, { size: 18, color: coverage < 168 ? "#f0bd71" : "#92a3bc", anchor: "end" })}
    ${content}
  </g>`
}

function emptyPanel (y) {
  return text(600, y, "Нет данных на этом интервале", { size: 24, color: "#92a3bc", anchor: "middle" })
}

function renderPrice (data, x, { top = 402, height = 330, title = "ЦЕНА · USDT · 1ч" } = {}) {
  const candles = data.points.flatMap(point => point.candle ? [point.candle] : [])
  if (!candles.length) {
    return panel("price-panel", top, height, title, 0, emptyPanel(top + height / 2 + 21))
  }
  const y = valueScale(candles.flatMap(candle => [candle.low, candle.high]), top + 60, top + height - 24)
  const width = (x.range()[1] - x.range()[0]) / data.points.length * 0.6
  const bars = candles.map((candle) => {
    const center = x(candle.time * 1_000)
    const color = directionColor(candle.close - candle.open)
    return `<g class="candle" data-time="${candle.time}" fill="${color}" stroke="${color}">
      <line x1="${center}" x2="${center}" y1="${y(candle.high)}" y2="${y(candle.low)}" stroke-width="1.5"/>
      <rect x="${center - width / 2}" y="${Math.min(y(candle.open), y(candle.close))}" width="${width}" height="${Math.max(1.5, Math.abs(y(candle.open) - y(candle.close)))}" stroke="none" rx="1"/>
    </g>`
  }).join("")
  const lastPrice = data.price === null ? "" : `<line x1="76" x2="1012" y1="${y(data.price)}" y2="${y(data.price)}" stroke="#8bb7ff" stroke-dasharray="5 6" opacity="0.65"/>`
  return panel("price-panel", top, height, title, data.coverage.candles, `${grid(x, y, price, 4)}${lastPrice}${bars}`)
}

function renderVolume (data, x, { top = 748, height = 146, title = `ОБЪЁМ · ${shorten(data.coin.symbol, 16)}` } = {}) {
  const values = data.points.map(point => point.volume).filter(isFinite)
  if (!values.length) {
    return panel("volume-panel", top, height, title, 0, emptyPanel(top + height / 2 + 21))
  }
  const y = valueScale(values, top + 54, top + height - 18, true)
  const width = (x.range()[1] - x.range()[0]) / data.points.length * 0.6
  const bars = data.points.filter(point => point.volume !== null).map((point) => {
    const color = point.candle ? directionColor(point.candle.close - point.candle.open) : "#92a3bc"
    return `<rect class="volume-bar" x="${x(point.time * 1_000) - width / 2}" y="${y(point.volume)}" width="${width}" height="${y.range()[0] - y(point.volume)}" fill="${color}" opacity="0.7"/>`
  }).join("")
  return panel("volume-panel", top, height, title, data.coverage.volume, `${grid(x, y, compact, 2)}${bars}`)
}

function renderInterest (data, x) {
  const values = data.points.map(point => point.openInterest).filter(isFinite)
  if (!values.length) {
    return panel("oi-panel", 910, 150, `OPEN INTEREST · ${shorten(data.coin.symbol, 16)}`, 0, emptyPanel(1008))
  }
  const y = valueScale(values, 964, 1042)
  const path = line()
    .defined(point => point.openInterest !== null)
    .x(point => x(point.time * 1_000))
    .y(point => y(point.openInterest))(data.points)
  // Dots keep an isolated observation visible without connecting it across gaps.
  const dots = data.points.filter(point => point.openInterest !== null)
    .map(point => `<circle cx="${x(point.time * 1_000)}" cy="${y(point.openInterest)}" r="1.8" fill="#8bb7ff"/>`).join("")
  return panel("oi-panel", 910, 150, `OPEN INTEREST · ${shorten(data.coin.symbol, 16)}`, data.coverage.openInterest,
    `${grid(x, y, compact, 2)}<path id="oi-line" d="${path}" fill="none" stroke="#8bb7ff" stroke-width="3"/>${dots}`)
}

function renderHeader (data) {
  const { coin } = data
  const badges = [
    coin.topRank != null ? `ТОП ${coin.topRank}` : null,
    coin.features?.coingeckoTrending === true ? "COINGECKO TRENDING" : null,
    [true, false].includes(coin.socialSignificant) && coin.socialSentiment
      ? {
          positive: "ПОЗИТИВНЫЙ ФОН", negative: "НЕГАТИВНЫЙ ФОН", mixed: "СМЕШАННЫЙ ФОН",
          neutral: coin.socialSignificant ? "ЗНАЧИМЫЙ ИНФОПОВОД" : "НЕЙТРАЛЬНЫЙ ФОН",
          bullish: "БЫЧИЙ ФОН", bearish: "МЕДВЕЖИЙ ФОН",
        }[coin.socialSentiment]
      : null,
  ].filter(Boolean)
  const probability = isFinite(coin.movementProbability) && coin.movementProbability >= 0 && coin.movementProbability <= 1
    ? `${number(coin.movementProbability * 100, { maximumFractionDigits: 0 })}%`
    : "Нет данных"
  return `
    ${text(48, 48, data.demo ? "ДЕМО · СИНТЕТИЧЕСКИЕ ДАННЫЕ" : "CRYPTO SIGNALS / РАННИЕ ДВИЖЕНИЯ", { size: 19, weight: 700, color: data.demo ? "#f0bd71" : "#8bb7ff" })}
    ${text(48, 118, shorten(coin.symbol, 16), { size: 56, weight: 700 })}
    ${text(48, 154, shorten(coin.name, 43), { size: 24, color: "#aab9d0" })}
    ${text(1152, 48, "Срез закрыт · МСК (UTC+3)", { size: 18, color: "#92a3bc", anchor: "end" })}
    ${text(1152, 82, timestamp(data.closedAt, true), { size: 23, anchor: "end" })}
    ${text(1152, 119, shorten(coin.marketSymbol, 35), { size: 18, color: "#92a3bc", anchor: "end" })}
    ${text(48, 190, badges.join(" · ") || "КАНДИДАТ ИЗ ОТЧЁТА", { size: 18, weight: 700, color: "#8bb7ff" })}
    ${text(48, 227, "Цена закрытия · USDT", { size: 20, color: "#92a3bc" })}
    ${text(48, 274, price(data.price), { size: data.price === null ? 32 : 44, weight: 700 })}
    ${text(625, 227, "Изменение · 4ч", { size: 20, color: "#92a3bc" })}
    ${text(625, 274, percent(data.change4hPct), { size: 34, weight: 700, color: directionColor(data.change4hPct) })}
    ${text(914, 227, "Изменение · 24ч", { size: 20, color: "#92a3bc" })}
    ${text(914, 274, percent(data.change24hPct), { size: 34, weight: 700, color: directionColor(data.change24hPct) })}
    <rect x="48" y="302" width="1104" height="80" rx="16" fill="#182641"/>
    ${text(72, 352, probability, { size: 38, weight: 700, color: "#a9c9ff" })}
    ${text(294, 334, data.growthObjective ? "Сильный рост · 4–12ч" : "Сильное движение · 4–12ч", { size: 21, weight: 700 })}
    ${text(294, 363, data.growthObjective ? "Рост > 2.5 ATR · рынок и инфофон" : "Оценка агента, без прогноза направления", { size: 18, color: "#aab9d0" })}
    ${text(1128, 334, "Уверенность оценки", { size: 18, color: "#aab9d0", anchor: "end" })}
    ${text(1128, 363, { high: "Высокая", medium: "Средняя", low: "Низкая" }[coin.estimateConfidence] ?? "Нет данных", { size: 23, weight: 700, anchor: "end" })}`
}

export function buildCoinCardSvg (report, coin) {
  const data = buildCoinCardData(report, coin)
  const x = scaleUtc()
    .domain([new Date((data.points[0].time - 1_800) * 1_000), new Date((data.asOf + 1_800) * 1_000)])
    .range([76, 1012])
  const ticks = x.ticks(5).map(tick => text(x(tick), 1087, timestamp(tick.getTime() / 1_000), {
    size: 17, color: "#92a3bc", anchor: "middle",
  })).join("")
  const warning = data.warnings.length
    ? data.price === null ? "Цена на срезе недоступна. Пропуски не заполнены." : "Данные неполные или с оговорками. Пропуски не заполнены."
    : ""

  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="1280" viewBox="0 0 1200 1280" font-family="Noto Sans">
    <title>${escapeXml(`${data.demo ? "ДЕМО · " : ""}${coin.symbol} · срез ${timestamp(data.closedAt, true)} МСК`)}</title>
    <desc>${escapeXml(data.warnings.join(" ") || "Цена, объём и Open Interest за 7 дней из сохранённого отчёта.")}</desc>
    <rect width="1200" height="1280" fill="#0b1120"/>
    ${renderHeader(data)}
    ${renderPrice(data, x)}
    ${renderVolume(data, x)}
    ${renderInterest(data, x)}
    ${ticks}
    ${text(1152, 1087, "МСК", { size: 17, color: "#92a3bc", anchor: "end" })}
    ${text(48, 1140, "Объём 1ч / норма этого часа", { size: 21, color: "#92a3bc" })}
    ${text(48, 1180, data.relativeVolume === null ? "Нет данных" : `${number(data.relativeVolume)}×`, { size: 34, weight: 700 })}
    ${text(48, 1207, "Норма: медиана за предыдущие 30 дней", { size: 17, color: "#92a3bc" })}
    ${text(682, 1140, "Изменение Open Interest · 4ч", { size: 21, color: "#92a3bc" })}
    ${text(682, 1180, percent(data.oiChange4hPct), { size: 34, weight: 700 })}
    ${text(682, 1207, "Окно: 7 дней · начало свечей на оси", { size: 17, color: "#92a3bc" })}
    ${warning ? text(48, 1241, warning, { size: 18, color: "#f0bd71" }) : ""}

  </svg>`
}

export function buildPatternChartSvg (report, coin) {
  const data = buildPatternChartData(report, coin)
  const x = scaleUtc()
    .domain([new Date((data.points[0].time - 1_800) * 1_000), new Date((data.asOf + 1_800) * 1_000)])
    .range([76, 1012])
  const ticks = x.ticks(5).map(tick => text(x(tick), 1189, timestamp(tick.getTime() / 1_000, false, "UTC"), {
    size: 17, color: "#92a3bc", anchor: "middle",
  })).join("")

  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="1280" viewBox="0 0 1200 1280" font-family="Noto Sans">
    <title>${escapeXml(`Недельный график · ${coin.symbol} · ${coin.marketSymbol} · 1h · asOf ${report.asOf}`)}</title>
    <desc>${escapeXml(data.warnings.join(" ") || "Цена и объём за 7 дней; начало свечей на общей оси UTC.")}</desc>
    <rect width="1200" height="1280" fill="#0b1120"/>
    ${text(48, 48, "НЕДЕЛЬНЫЙ ГРАФИК · 1ч", { size: 19, weight: 700, color: "#8bb7ff" })}
    ${text(48, 118, shorten(coin.symbol, 16), { size: 56, weight: 700 })}
    ${text(48, 154, shorten(coin.name, 43), { size: 24, color: "#aab9d0" })}
    ${text(48, 189, coin.marketSymbol, { size: 20, color: "#92a3bc" })}
    ${text(1152, 48, "Последняя закрытая свеча · UTC", { size: 18, color: "#92a3bc", anchor: "end" })}
    ${text(1152, 82, `Открытие · ${timestamp(data.asOf, true, "UTC")}`, { size: 20, anchor: "end" })}
    ${text(1152, 116, `Закрытие · ${timestamp(data.closedAt, true, "UTC")}`, { size: 20, anchor: "end" })}
    ${text(48, 219, `Окно: ${timestamp(data.points[0].time, true, "UTC")} — ${timestamp(data.closedAt, true, "UTC")} UTC · 168 ч`, { size: 17, color: "#92a3bc" })}
    ${renderPrice(data, x, { top: 236, height: 740, title: "ЦЕНА · 1ч" })}
    ${renderVolume(data, x, { top: 992, height: 170, title: "ОБЪЁМ · 1ч" })}
    ${ticks}
    ${text(1152, 1189, "UTC", { size: 17, color: "#92a3bc", anchor: "end" })}
    ${text(48, 1224, "Окно: 7 дней · начало свечей на оси · UTC", { size: 17, color: "#92a3bc" })}
    ${data.warnings.length ? text(48, 1258, shorten(data.warnings.join(" "), 110), { size: 18, color: "#f0bd71" }) : ""}
  </svg>`
}

export function renderCoinCardPng (svg) {
  return new Resvg(svg, {
    font: {
      loadSystemFonts: false,
      defaultFontFamily: "Noto Sans",
      fontFiles: [
        fileURLToPath(new URL("./fonts/NotoSans-Regular.ttf", import.meta.url)),
        fileURLToPath(new URL("./fonts/NotoSans-Bold.ttf", import.meta.url)),
      ],
    },
  }).render().asPng()
}
