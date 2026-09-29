import { isArray, isFinite, isInt } from "../helpers/utils.typed.js"
import { rollingMedian } from "../scripts/rolling-statistics.js"
import { lag } from "../scripts/series.js"

export function preparePriceCharacterPeriods (periods, endTime, days = 90) {
  if (!isInt(days) || days < 30 || days > 90) {
    throw new Error("Research requires between 30 and 90 whole days")
  }
  if (!isInt(endTime) || endTime % 900 !== 0) {
    throw new Error("Research endTime must be a 15-minute UTC boundary")
  }
  if (!isArray(periods) || !periods.every(period => isInt(period?.time))) {
    throw new Error("Research candles must have integer timestamps")
  }

  // One previous close and 96 baseline candles precede the analysis.
  const startTime = endTime - (days * 96 + 97) * 900
  const selected = periods.filter(period => period.time >= startTime && period.time < endTime)
    .sort((first, second) => first.time - second.time)

  if (selected.length !== days * 96 + 97) {
    throw new Error(`Incomplete 15m history: expected ${days * 96 + 97} closed candles, received ${selected.length}`)
  }

  for (const [index, period] of selected.entries()) {
    if (period.time !== startTime + index * 900) {
      throw new Error(`Invalid 15m grid at ${period.time}: gap, duplicate or off-grid timestamp`)
    }
    if (![period.open, period.max, period.min, period.close].every(value => isFinite(value) && value > 0)
      || period.min > Math.min(period.open, period.close)
      || period.max < Math.max(period.open, period.close)
      || !isFinite(period.volume) || period.volume < 0) {
      throw new Error(`Invalid OHLCV candle at ${period.time}`)
    }
  }

  return selected
}

function sum (values) {
  return values.reduce((total, value) => total + value, 0)
}

function quantile (values, fraction) {
  const sorted = values.filter(isFinite).sort((first, second) => first - second)
  if (!sorted.length) {
    return null
  }
  const position = (sorted.length - 1) * fraction
  const lower = Math.floor(position)
  return sorted[lower] + (sorted[Math.ceil(position)] - sorted[lower]) * (position - lower)
}

function ratio (numerator, denominator) {
  return denominator > 0 ? numerator / denominator : null
}

function describeCandles (periods) {
  const ranges = periods.map((period, index) => index === 0
    ? null
    : 100 * Math.max(
      period.max - period.min,
      Math.abs(period.max - periods[index - 1].close),
      Math.abs(period.min - periods[index - 1].close),
    ) / periods[index - 1].close)
  const baselines = lag(rollingMedian(ranges, 96), 1)

  return periods.slice(97).map((period, offset) => {
    const index = offset + 97
    const previousClose = periods[index - 1].close
    const range = period.max - period.min
    return {
      ...period,
      previousClose,
      returnPct: 100 * (period.close / previousClose - 1),
      logReturn: Math.log(period.close / previousClose),
      rangePct: ranges[index],
      candleRangePct: 100 * range / previousClose,
      baselineRangePct: baselines[index],
      rangeMultiple: ratio(ranges[index], baselines[index]),
      longestWickPct: ratio(100 * Math.max(
        period.max - Math.max(period.open, period.close),
        Math.min(period.open, period.close) - period.min,
      ), range),
      turnoverUsdt: period.volume * (period.max + period.min + period.close) / 3,
    }
  })
}

function medianEfficiency (rows, window) {
  return quantile(rows.slice(window - 1).map((_, index) => {
    const returns = rows.slice(index, index + window).map(row => row.logReturn)
    return ratio(Math.abs(sum(returns)), sum(returns.map(Math.abs)))
  }), 0.5)
}

function summarize (rows, label) {
  const ranges = rows.map(row => row.rangePct)
  const absoluteReturns = rows.map(row => Math.abs(row.returnPct))
  const absoluteLogReturns = rows.map(row => Math.abs(row.logReturn)).sort((first, second) => second - first)
  const evaluated = rows.filter(row => isFinite(row.rangeMultiple))
  const spikeCount = evaluated.filter(row => row.rangeMultiple >= 4).length
  const medianRange = quantile(ranges, 0.5)
  const p99Range = quantile(ranges, 0.99)
  const dailyTurnover = Array.from({ length: Math.floor(rows.length / 96) }, (_, index) => (
    sum(rows.slice(index * 96, (index + 1) * 96).map(row => row.turnoverUsdt))
  ))

  return {
    label,
    days: rows.length / 96,
    startTime: rows[0].time,
    endTime: rows.at(-1).time + 900,
    bars: rows.length,
    netReturnPct: 100 * (rows.at(-1).close / rows[0].previousClose - 1),
    medianRangePct: medianRange,
    p99RangePct: p99Range,
    maxRangePct: Math.max(...ranges),
    rangeTailRatio: ratio(p99Range, medianRange),
    rangeIqrOverMedian: ratio(quantile(ranges, 0.75) - quantile(ranges, 0.25), medianRange),
    medianAbsReturnPct: quantile(absoluteReturns, 0.5),
    p99AbsReturnPct: quantile(absoluteReturns, 0.99),
    spikeCount,
    spikeRatePct: ratio(100 * spikeCount, evaluated.length),
    spikeEvaluatedBars: evaluated.length,
    rangeOver3PctRatePct: 100 * ranges.filter(value => value > 3).length / rows.length,
    returnOver3PctRatePct: 100 * absoluteReturns.filter(value => value > 3).length / rows.length,
    longWickRatePct: ratio(100 * evaluated.filter(row => (
      row.longestWickPct >= 60 && row.candleRangePct >= row.baselineRangePct
    )).length, evaluated.length),
    efficiency4hMedian: medianEfficiency(rows, 16),
    efficiency12hMedian: medianEfficiency(rows, 48),
    top1PctMovementSharePct: ratio(
      100 * sum(absoluteLogReturns.slice(0, Math.ceil(rows.length * 0.01))),
      sum(absoluteLogReturns),
    ),
    medianDailyTurnoverUsdt: quantile(dailyTurnover, 0.5),
    zeroReturnRatePct: 100 * rows.filter(row => row.returnPct === 0).length / rows.length,
    flatBarRatePct: 100 * rows.filter(row => row.max === row.min).length / rows.length,
  }
}

export function buildPriceCharacterReport (snapshot) {
  if (snapshot?.timeframe !== "15m") {
    throw new Error("Price character research requires native 15m candles")
  }
  const analysisDays = snapshot.analysisDays ?? 90
  const periods = preparePriceCharacterPeriods(snapshot.periods, snapshot.endTime, analysisDays)
  const rows = describeCandles(periods)
  const weeks = []

  for (let end = rows.length; end > 0; end -= 7 * 96) {
    const week = rows.slice(Math.max(0, end - 7 * 96), end)
    weeks.unshift(summarize(week, week.length === 7 * 96 ? "7 дней" : `Неполная неделя · ${week.length / 96} дней`))
  }

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    collectedAt: snapshot.collectedAt,
    source: snapshot.source,
    symbol: snapshot.symbol,
    marketSymbol: snapshot.marketSymbol,
    timeframe: snapshot.timeframe,
    startTime: rows[0].time,
    endTime: snapshot.endTime,
    coverage: {
      requestedDays: 90,
      analysisDays,
      analysisBars: rows.length,
      warmupBars: 97,
      totalBars: periods.length,
      intervalSeconds: 900,
      missingBars: 0,
    },
    warnings: analysisDays < 90
      ? [`Запрошено 90 дней; полученной истории хватает на ${analysisDays} полных дней анализа и прогрев. Это не 90-дневная выборка; отсутствие более ранних свечей не доказывает дату начала торгов.`]
      : [],
    methodology: [
      "Используем только закрытые свечи с полной сеткой 15m, без заполнения пропусков. Прогрев: 96 свечей предыдущих суток и ещё одна свеча для previousClose.",
      "Все окна заканчиваются одновременно. Недели отсчитываем назад от конца выборки; неполная ранняя неделя отмечена отдельно. Дневной оборот считаем по неперекрывающимся 24-часовым блокам, не по календарным суткам UTC.",
      "Квантили — линейная интерполяция между соседними наблюдениями. Для топ-1% число свечей округляем вверх; на 7 днях это 7 свечей из 672.",
      "При нулевом фоновом диапазоне свеча не участвует в частоте вспышек и длинных теней. Нулевое движение даёт неопределённую efficiency и долю топ-1%, а не идеальную плавность.",
      "Efficiency считается только по полным окнам внутри рассматриваемого периода; соседние окна перекрываются и не являются независимыми наблюдениями.",
      "Плавность, амплитуда и торговый оборот — отдельные характеристики. Без сравнения с другими монетами нельзя утверждать, что PROVE особенно ровный; свечи 15m не показывают порядок движения внутри свечи и спред стакана.",
    ],
    windows: [...new Set([7, 30, analysisDays])].map(days => summarize(
      rows.slice(-days * 96),
      days === analysisDays && days < 90 ? `${days} дней (доступно из 90)` : `${days} дней`,
    )),
    weeks,
    spikes: rows.filter(row => isFinite(row.rangeMultiple) && row.rangeMultiple >= 4)
      .sort((first, second) => second.rangeMultiple - first.rangeMultiple)
      .slice(0, 15)
      .map(({ time, open, max, min, close, returnPct, rangePct, baselineRangePct, rangeMultiple, longestWickPct }) => ({
        time, open, max, min, close, returnPct, rangePct, baselineRangePct, rangeMultiple, longestWickPct,
      })),
  }
}
