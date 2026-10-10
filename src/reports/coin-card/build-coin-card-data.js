import { buildHourlyChartData } from "../../helpers/hourly-chart-data-helper.js"
import { isFinite, isString } from "../../helpers/utils.typed.js"

function change (current, previous) {
  return isFinite(current) && isFinite(previous) && previous > 0 ? (current / previous - 1) * 100 : null
}

export function buildCoinCardData (report, coin) {
  const data = buildHourlyChartData(report, coin, { includeInterest: true })
  const { price, points } = data
  return {
    ...data,
    growthObjective: isString(report.objective) && report.objective.startsWith("P(рост >"),
    demo: report.demo === true,
    change4hPct: change(price, points.at(-5).candle?.close),
    change24hPct: change(price, points.at(-25).candle?.close),
    oiChange4hPct: change(points.at(-1).openInterest, points.at(-5).openInterest),
    relativeVolume: isFinite(coin.features?.relVolume) && coin.features.relVolume >= 0 ? coin.features.relVolume : null,
  }
}
