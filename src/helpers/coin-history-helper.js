import { readTmpJson } from "./fs-helper.js"
import { reportStepError } from "./step-error-helper.js"
import { isArray, isError, isFinite, isSafeInteger } from "./utils.typed.js"
import { createBootstrapDataRelativePath } from "../steps/step2-data-bootstrap/check-coin-data-coverage.js"

class CoinHistoryUnavailableError extends Error {}

function indexHistoryPeriods (periods, asOfTimestamp, warnings, label) {
  const byTime = new Map()

  for (const period of periods) {
    if (!isSafeInteger(period?.time)) {
      warnings.add(`${label}: пропущены некорректные отметки времени`)
      continue
    }

    if (period.time < asOfTimestamp - 167 * 3_600 || period.time > asOfTimestamp) {
      continue
    }

    if (period.time % 3_600 !== 0) {
      warnings.add(`${label}: пропущены отметки вне часовой сетки`)
      continue
    }

    if (byTime.has(period.time)) {
      warnings.add(`${label}: дубликаты часов объединены, взята последняя запись`)
    }

    byTime.set(period.time, period)
  }

  return byTime
}

function buildValueSeries (periods, valueOf, warnings, label) {
  const series = periods.map((period) => {
    const value = valueOf(period)

    return isFinite(value) && value >= 0 ? { time: period.time, value } : { time: period.time }
  })

  if (series.some(point => !isFinite(point.value))) {
    warnings.add(`${label}: отсутствующие или некорректные значения оставлены пропусками`)
  }

  return series
}

export function buildCoinHistory (data, coin, asOfTimestamp, { includeOpenInterest = true } = {}) {
  if (
    data?.coin?.symbol !== coin.symbol
    || (data.coin.baseCurrencyId != null && data.coin.baseCurrencyId !== coin.baseCurrencyId)
    || (data.coin.marketSymbol != null && data.coin.marketSymbol !== coin.marketSymbol)
    || (data.chart?.info?.fullName != null && data.chart.info.fullName !== coin.marketSymbol)
  ) {
    throw new Error("монета или рынок в истории не совпадают с кандидатом")
  }

  if (data.timeframe !== "1h") {
    throw new Error("история должна использовать интервал 1h")
  }

  if (!isArray(data.chart?.periods)) {
    throw new Error("некорректный формат свечей")
  }
  if (data.chart.periods.length === 0) {
    throw new CoinHistoryUnavailableError("свечи отсутствуют")
  }

  const warnings = new Set()
  const chartByTime = indexHistoryPeriods(data.chart.periods, asOfTimestamp, warnings, "Свечи")
  const periods = [...chartByTime.values()]
    .filter((period) => {
      const valid = [period.open, period.max, period.min, period.close]
        .every(value => isFinite(value) && value > 0)
        && period.min <= Math.min(period.open, period.close)
        && period.max >= Math.max(period.open, period.close)

      if (!valid) {
        warnings.add("Свечи с некорректными OHLC пропущены")
      }

      return valid
    })
    .sort((first, second) => first.time - second.time)

  if (periods.at(-1)?.time !== asOfTimestamp) {
    throw new CoinHistoryUnavailableError("нет корректной свечи на asOf: история устарела или неполна")
  }

  if (periods.length < 168) {
    warnings.add(`Неполная неделя: ${periods.length} из 168 часовых свечей, пропуски не заполнены`)
  }

  const oiPeriods = includeOpenInterest ? data.studies?.openInterest?.periods : undefined
  const oiByTime = includeOpenInterest
    ? indexHistoryPeriods(
        isArray(oiPeriods) ? oiPeriods : [],
        asOfTimestamp,
        warnings,
        "Open Interest",
      )
    : null
  const volume = buildValueSeries(periods, period => period.volume, warnings, "Объём")
  const openInterest = includeOpenInterest
    ? buildValueSeries(
        periods,
        period => oiByTime.get(period.time)?.close,
        warnings,
        "Open Interest",
      )
    : undefined

  return {
    candles: periods.map(({ time, open, max, min, close }) => ({ time, open, high: max, low: min, close })),
    volume,
    ...(includeOpenInterest ? { openInterest } : {}),
    warning: [...warnings].join(". ") || null,
  }
}

export async function readCoinHistory (
  coin,
  asOfTimestamp,
  { readCoinData = readTmpJson, includeOpenInterest = true, step, reportError = reportStepError } = {},
) {
  try {
    const data = await readCoinData(createBootstrapDataRelativePath(coin))

    return buildCoinHistory(data, coin, asOfTimestamp, { includeOpenInterest })
  } catch (error) {
    // Pipeline callers opt in; web requests keep unavailable history as optional data.
    if (step && error?.code !== "ENOENT" && !(error instanceof CoinHistoryUnavailableError)) {
      await reportError(error, {
        step, operation: "read_coin_history", symbol: coin.symbol,
        source: "step2-data-bootstrap", baseCurrencyId: coin.baseCurrencyId,
      })
    }
    return {
      candles: [],
      volume: [],
      ...(includeOpenInterest ? { openInterest: [] } : {}),
      warning: `История недоступна: ${isError(error) ? error.message : "не удалось прочитать данные"}`,
    }
  }
}
