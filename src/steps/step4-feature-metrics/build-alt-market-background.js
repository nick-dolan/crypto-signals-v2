import { getClosedHourlyBoundary } from "../../helpers/hourly-time-helper.js"
import { isArray, isError, isFinite, isSafeInteger, isString } from "../../helpers/utils.typed.js"

function calculateChange6hPct (marketData, asOf) {
  const asOfTimestamp = isString(asOf) ? Date.parse(asOf) / 1_000 : NaN

  if (!isSafeInteger(asOfTimestamp) || asOfTimestamp % 3_600 !== 0) {
    throw new Error("asOf должен указывать точное начало часовой свечи")
  }

  if (
    marketData?.source !== "tradingview"
    || marketData.timeframe !== "1h"
    || marketData.series?.total3es?.symbol !== "CRYPTOCAP:TOTAL3ES"
  ) {
    throw new Error("ожидались данные tradingview, интервал 1h и символ CRYPTOCAP:TOTAL3ES")
  }

  const collectedAt = isString(marketData.collectedAt) ? Date.parse(marketData.collectedAt) / 1_000 : NaN
  const boundary = getClosedHourlyBoundary(collectedAt)

  if (!boundary) {
    throw new Error("в рыночном контексте некорректное время сбора collectedAt")
  }

  if (asOfTimestamp > boundary.latestClosedTime) {
    throw new Error("контекст устарел или свеча asOf ещё не закрылась на момент collectedAt")
  }

  const periods = marketData.series.total3es.periods

  if (!isArray(periods)) {
    throw new Error("в рыночном контексте отсутствуют часовые свечи TOTAL3ES")
  }

  const earliestTime = asOfTimestamp - 6 * 3_600
  const windowPeriods = periods.filter(period => (
    !isFinite(period?.time)
    || (period.time >= earliestTime && period.time <= asOfTimestamp)
  ))
  const byTime = new Map(windowPeriods.map(period => [period?.time, period]))
  const times = Array.from({ length: 7 }, (_, index) => earliestTime + index * 3_600)

  if (windowPeriods.length !== 7 || byTime.size !== 7 || times.some(time => !byTime.has(time))) {
    throw new Error("нужны 7 часовых свечей от asOf − 6ч до asOf без пропусков, дубликатов и сдвигов времени")
  }

  const closes = times.map(time => byTime.get(time).close)

  if (closes.some(close => !isFinite(close) || close <= 0)) {
    throw new Error("цены закрытия TOTAL3ES в окне 6ч должны быть конечными положительными числами")
  }

  const change6hPct = (closes[6] - closes[0]) / closes[0] * 100

  if (!isFinite(change6hPct)) {
    throw new Error("не удалось вычислить конечное изменение TOTAL3ES за 6ч")
  }

  return change6hPct
}

export function buildAltMarketBackground ({ asOf, breadth6h, marketData }) {
  const breadth = isFinite(breadth6h) && breadth6h >= 0 && breadth6h <= 1 ? breadth6h : null
  const warnings = breadth === null
    ? ["Ширина рынка за 6ч недоступна: требуется число от 0 до 1 по полному списку монет"]
    : []
  let change6hPct = null

  try {
    change6hPct = calculateChange6hPct(marketData, asOf)
  } catch (error) {
    warnings.push(`TOTAL3ES недоступен: ${isError(error) ? error.message : "не удалось рассчитать изменение за 6ч"}`)
  }

  let status = "unavailable"

  if (change6hPct !== null && breadth !== null) {
    status = "mixed"

    // 55/45 — простая эвристика согласованности метрик, не оценка вероятности.
    if (change6hPct > 0 && breadth > 0.55) {
      status = "up"
    } else if (change6hPct < 0 && breadth < 0.45) {
      status = "down"
    }
  }

  return { status, change6hPct, breadth6h: breadth, warning: warnings.join(". ") || null }
}
