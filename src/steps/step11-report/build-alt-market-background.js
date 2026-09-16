import { readTmpJson } from "../../helpers/fs-helper.js"
import { getClosedHourlyBoundary } from "../../helpers/hourly-time-helper.js"
import { isArray, isError, isFinite, isSafeInteger, isString } from "../../helpers/utils.typed.js"

function calculateChange4hPct (marketData, asOf) {
  const asOfTimestamp = isString(asOf) ? Date.parse(asOf) / 1_000 : NaN

  if (!isSafeInteger(asOfTimestamp) || asOfTimestamp % 3_600 !== 0) {
    throw new Error("asOf отчёта должен указывать точное начало часовой свечи")
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
    throw new Error("в сохранённом контексте некорректное время сбора collectedAt")
  }

  if (asOfTimestamp > boundary.latestClosedTime) {
    throw new Error("контекст устарел или свеча asOf ещё не закрылась на момент collectedAt")
  }

  const periods = marketData.series.total3es.periods

  if (!isArray(periods)) {
    throw new Error("в сохранённом контексте отсутствуют часовые свечи TOTAL3ES")
  }

  const earliestTime = asOfTimestamp - 4 * 3_600
  const windowPeriods = periods.filter(period => (
    !isFinite(period?.time)
    || (period.time >= earliestTime && period.time <= asOfTimestamp)
  ))
  const byTime = new Map(windowPeriods.map(period => [period?.time, period]))
  const times = Array.from({ length: 5 }, (_, index) => earliestTime + index * 3_600)

  if (windowPeriods.length !== 5 || byTime.size !== 5 || times.some(time => !byTime.has(time))) {
    throw new Error("нужны 5 часовых свечей от asOf − 4ч до asOf без пропусков, дубликатов и сдвигов времени")
  }

  const closes = times.map(time => byTime.get(time).close)

  if (closes.some(close => !isFinite(close) || close <= 0)) {
    throw new Error("цены закрытия TOTAL3ES в окне 4ч должны быть конечными положительными числами")
  }

  const change4hPct = (closes[4] - closes[0]) / closes[0] * 100

  if (!isFinite(change4hPct)) {
    throw new Error("не удалось вычислить конечное изменение TOTAL3ES за 4ч")
  }

  return change4hPct
}

export async function buildAltMarketBackground (
  { asOf, breadth4h },
  { readMarketData = readTmpJson } = {},
) {
  const breadth = isFinite(breadth4h) && breadth4h >= 0 && breadth4h <= 1 ? breadth4h : null
  const warnings = breadth === null
    ? ["Ширина рынка за 4ч недоступна: требуется число от 0 до 1 по всей вселенной монет"]
    : []
  let change4hPct = null

  try {
    const marketData = await readMarketData("step3-market-context.json")
    change4hPct = calculateChange4hPct(marketData, asOf)
  } catch (error) {
    warnings.push(`TOTAL3ES недоступен: ${isError(error) ? error.message : "не удалось прочитать step3-market-context.json"}`)
  }

  let status = "unavailable"

  if (change4hPct !== null && breadth !== null) {
    status = "mixed"

    // 55/45 — простая эвристика согласованности метрик, не оценка вероятности.
    if (change4hPct > 0 && breadth > 0.55) {
      status = "up"
    } else if (change4hPct < 0 && breadth < 0.45) {
      status = "down"
    }
  }

  return { status, change4hPct, breadth4h: breadth, warning: warnings.join(". ") || null }
}
