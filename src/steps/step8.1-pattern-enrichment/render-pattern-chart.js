import { scaleLinear, scaleUtc } from "d3-scale"

import { buildHourlyChartData } from "../../helpers/hourly-chart-data-helper.js"
import { escapeXml } from "../../helpers/svg-helper.js"

function text (x, y, value, { size = 14, anchor = "start" } = {}) {
  return `<text x="${x}" y="${y}" font-size="${size}" fill="#000" text-anchor="${anchor}">${escapeXml(value)}</text>`
}

function price (value) {
  return new Intl.NumberFormat("en-US", {
    maximumSignificantDigits: 6, useGrouping: false,
    notation: value > 0 && value < 0.000001 ? "scientific" : "standard",
  }).format(value)
}

function volume (value) {
  return new Intl.NumberFormat("en-US", { notation: "compact", maximumSignificantDigits: 3 }).format(value)
}

function valueScale (values, top, bottom, zero = false) {
  if (!values.length) {
    return null
  }
  const low = Math.min(...values)
  const high = Math.max(...values)
  const padding = (high - low || high * 0.02 || 1) * 0.1
  return scaleLinear()
    .domain([zero ? 0 : Math.max(0, low - padding), high + padding])
    .range([bottom, top])
}

function renderValueAxis (y, format, count) {
  if (!y) {
    return ""
  }
  return `<line class="axis" x1="1304" x2="1304" y1="${y.range()[1]}" y2="${y.range()[0]}" stroke="#000"/>
    ${y.ticks(count).map(tick => `<line class="tick" x1="1304" x2="1310" y1="${y(tick)}" y2="${y(tick)}" stroke="#000"/>
      ${text(1316, y(tick) + 4, format(tick))}`).join("")}`
}

function renderTimeAxis (x) {
  return `<line class="axis" x1="64" x2="1304" y1="736" y2="736" stroke="#000"/>
    ${x.ticks(7).map(tick => `<line class="tick" x1="${x(tick)}" x2="${x(tick)}" y1="736" y2="742" stroke="#000"/>
      ${text(x(tick), 765, tick.toISOString().slice(0, 16).replace("T", " "), { size: 12, anchor: "middle" })}`).join("")}`
}

function renderCandles (data, x, y) {
  if (!y) {
    return ""
  }
  const width = (x.range()[1] - x.range()[0]) / data.points.length * 0.65
  return data.points.filter(point => point.candle).map(({ time, candle }) => {
    const center = x(time * 1_000)
    const body = candle.open === candle.close
      ? `<line class="doji" x1="${center - width / 2}" x2="${center + width / 2}" y1="${y(candle.close)}" y2="${y(candle.close)}" stroke="#000" stroke-width="1.5"/>`
      : `<rect class="body" x="${center - width / 2}" y="${Math.min(y(candle.open), y(candle.close))}" width="${width}" height="${Math.max(1, Math.abs(y(candle.open) - y(candle.close)))}" fill="${candle.close > candle.open ? "#fff" : "#000"}" stroke="#000"/>`
    return `<g class="candle" data-time="${time}">
      <line class="wick" x1="${center}" x2="${center}" y1="${y(candle.high)}" y2="${y(candle.low)}" stroke="#000"/>
      ${body}
    </g>`
  }).join("")
}

function renderVolume (data, x, y) {
  if (!y) {
    return ""
  }
  const width = (x.range()[1] - x.range()[0]) / data.points.length * 0.65
  return data.points.filter(point => point.volume !== null).map(point =>
    `<rect class="volume-bar" data-time="${point.time}" x="${x(point.time * 1_000) - width / 2}" y="${y(point.volume)}" width="${width}" height="${y.range()[0] - y(point.volume)}" fill="#999"/>`,
  ).join("")
}

export function buildPatternChartData (report, coin, { hours = 168 } = {}) {
  if (![168, 48].includes(hours)) {
    throw new Error("Pattern charts require 168 or 48 hours")
  }
  return buildHourlyChartData(report, coin, { hours })
}

export function buildPatternChartSvg (report, coin, { hours = 168 } = {}) {
  const data = buildPatternChartData(report, coin, { hours })
  const x = scaleUtc()
    .domain([new Date((data.points[0].time - 1_800) * 1_000), new Date((data.asOf + 1_800) * 1_000)])
    .range([64, 1304])
  const yPrice = valueScale(data.points.flatMap(point => point.candle ? [point.candle.low, point.candle.high] : []), 34, 590)
  const yVolume = valueScale(data.points.flatMap(point => point.volume !== null ? [point.volume] : []), 618, 736, true)
  const incomplete = Object.values(data.coverage).some(count => count < hours)
  const warning = [
    ...(incomplete ? [`price ${data.coverage.candles}/${hours} · volume ${data.coverage.volume}/${hours} · gaps preserved`] : []),
    ...(data.warnings.length ? [`warnings ${data.warnings.length}`] : []),
  ].join(" · ")

  return `<svg xmlns="http://www.w3.org/2000/svg" width="1400" height="800" viewBox="0 0 1400 800" font-family="Noto Sans">
    <title>${escapeXml(`${coin.marketSymbol} · ${hours}h · asOf ${report.asOf}`)}</title>
    <desc>${escapeXml(JSON.stringify({
      symbol: coin.symbol, name: coin.name, marketSymbol: coin.marketSymbol,
      timeframe: report.timeframe, hours, asOf: report.asOf,
      closedAt: new Date(data.closedAt * 1_000).toISOString(),
      from: new Date(data.points[0].time * 1_000).toISOString(),
      timeZone: "UTC", timeAxis: "candle open", coverage: data.coverage, warnings: data.warnings,
    }))}</desc>
    <rect width="1400" height="800" fill="#fff"/>
    <g id="legend">
      <rect x="64" y="12" width="12" height="10" fill="#fff" stroke="#000"/>
      ${text(84, 22, "hollow up", { size: 12 })}
      <rect x="190" y="12" width="12" height="10" fill="#000" stroke="#000"/>
      ${text(210, 22, "filled down", { size: 12 })}
      <line x1="325" x2="337" y1="17" y2="17" stroke="#000" stroke-width="1.5"/>
      ${text(345, 22, "doji", { size: 12 })}
    </g>
    ${text(1304, 22, "Price", { size: 12, anchor: "end" })}
    <g id="price-axis">${renderValueAxis(yPrice, price, 6)}</g>
    <g id="candles">${renderCandles(data, x, yPrice)}</g>
    ${text(64, 612, "Volume", { size: 12 })}
    <g id="volume-axis">${renderValueAxis(yVolume, volume, 2)}</g>
    <g id="volume">${renderVolume(data, x, yVolume)}</g>
    <g id="time-axis">${renderTimeAxis(x)}</g>
    ${warning ? text(64, 790, warning, { size: 12 }) : ""}
    ${text(1384, 790, "UTC", { size: 12, anchor: "end" })}
  </svg>`
}
