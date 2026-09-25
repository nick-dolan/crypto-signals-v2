import { omit } from "radash"
import { readTmpJson } from "../../helpers/fs-helper.js"
import { isArray, isError, isFinite, isSafeInteger, isString } from "../../helpers/utils.typed.js"
import { createBootstrapDataRelativePath } from "../step2-data-bootstrap/check-coin-data-coverage.js"
import { decodeAgentPayload } from "../step6-agent-payload/agent-payload-format.js"

function indexBySymbol (items, symbolOf, label) {
  if (!isArray(items)) {
    throw new Error(`${label} must be an array`)
  }

  const entries = items.map(item => [symbolOf(item), item])

  if (entries.some(([symbol]) => !isString(symbol) || !symbol.trim())) {
    throw new Error(`${label} contains an invalid symbol`)
  }

  const bySymbol = new Map(entries)

  if (bySymbol.size !== items.length) {
    throw new Error(`${label} contains duplicate symbols`)
  }

  return bySymbol
}

function validateReportInputs (analysis, payload, shortlist) {
  const asOfTimestamp = isString(analysis?.asOf) ? Date.parse(analysis.asOf) / 1_000 : NaN

  if (
    !isSafeInteger(asOfTimestamp)
    || asOfTimestamp % 3_600 !== 0
    || analysis.asOf !== payload?.asOf
    || analysis.asOf !== shortlist?.asOf
    || payload.timeframe !== "1h"
    || shortlist.timeframe !== "1h"
  ) {
    throw new Error("Steps 5, 6 and 7 must use the same closed hourly snapshot (asOf, 1h)")
  }

  const { candidates } = decodeAgentPayload(payload)
  const rowsBySymbol = indexBySymbol(candidates, candidate => candidate.symbol, "Step 6 candidates")
  const shortlistBySymbol = indexBySymbol(shortlist.candidates, item => item?.coin?.symbol, "Step 5 candidates")
  const assessmentsBySymbol = indexBySymbol(analysis.assessments, item => item?.symbol, "Step 7 assessments")
  const topBySymbol = indexBySymbol(analysis.topCandidates, item => item?.symbol, "Step 7 top candidates")

  for (const [step, input, bySymbol] of [
    [5, shortlist, shortlistBySymbol],
    [6, payload, rowsBySymbol],
    [7, analysis, assessmentsBySymbol],
  ]) {
    if (input.candidateCount !== bySymbol.size) {
      throw new Error(`Step ${step} candidate count does not match its candidates`)
    }
  }

  if (
    !isSafeInteger(shortlist.universeCoinCount)
    || shortlist.universeCoinCount < shortlist.candidateCount
  ) {
    throw new Error("Step 5 universe coin count must include all candidates")
  }

  if ([rowsBySymbol, shortlistBySymbol].some(bySymbol => (
    bySymbol.size !== assessmentsBySymbol.size
    || [...assessmentsBySymbol.keys()].some(symbol => !bySymbol.has(symbol))
  ))) {
    throw new Error("Steps 5, 6 and 7 candidate sets do not match")
  }

  if ([...topBySymbol.keys()].some(symbol => !assessmentsBySymbol.has(symbol))) {
    throw new Error("Step 7 top candidates must belong to assessments")
  }

  for (const { coin } of shortlistBySymbol.values()) {
    if ([coin.name, coin.baseCurrencyId, coin.marketSymbol].some(value => (
      !isString(value) || !value.trim()
    ))) {
      throw new Error(`Step 5 candidate ${coin.symbol} is missing coin metadata`)
    }
  }

  return { asOfTimestamp, rowsBySymbol, shortlistBySymbol, topBySymbol }
}

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

function buildHistory (data, coin, asOfTimestamp) {
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

  if (!isArray(data.chart?.periods) || data.chart.periods.length === 0) {
    throw new Error("свечи отсутствуют")
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
    throw new Error("нет корректной свечи на asOf: история устарела или неполна")
  }

  if (periods.length < 168) {
    warnings.add(`Неполная неделя: ${periods.length} из 168 часовых свечей, пропуски не заполнены`)
  }

  const oiPeriods = data.studies?.openInterest?.periods
  const oiByTime = indexHistoryPeriods(
    isArray(oiPeriods) ? oiPeriods : [],
    asOfTimestamp,
    warnings,
    "Open Interest",
  )
  const volume = buildValueSeries(periods, period => period.volume, warnings, "Объём")
  const openInterest = buildValueSeries(
    periods,
    period => oiByTime.get(period.time)?.close,
    warnings,
    "Open Interest",
  )

  return {
    candles: periods.map(({ time, open, max, min, close }) => ({ time, open, high: max, low: min, close })),
    volume,
    openInterest,
    warning: [...warnings].join(". ") || null,
  }
}

async function readHistory (coin, asOfTimestamp, readCoinData) {
  try {
    const data = await readCoinData(createBootstrapDataRelativePath(coin))

    return buildHistory(data, coin, asOfTimestamp)
  } catch (error) {
    return {
      candles: [],
      volume: [],
      openInterest: [],
      warning: `История недоступна: ${isError(error) ? error.message : "не удалось прочитать данные"}`,
    }
  }
}

export async function buildReportData (
  analysis,
  payload,
  shortlist,
  { readCoinData = readTmpJson } = {},
) {
  const { asOfTimestamp, rowsBySymbol, shortlistBySymbol, topBySymbol } = validateReportInputs(
    analysis, payload, shortlist,
  )
  const coins = []

  for (const assessment of analysis.assessments) {
    const { coin } = shortlistBySymbol.get(assessment.symbol)
    const row = rowsBySymbol.get(assessment.symbol)
    const top = topBySymbol.get(assessment.symbol)

    coins.push({
      ...omit(assessment, ["directionBias"]),
      explanation: isString(top?.explanation) ? top.explanation : "",
      topRank: top ? analysis.topCandidates.indexOf(top) + 1 : null,
      name: coin.name,
      baseCurrencyId: coin.baseCurrencyId,
      marketSymbol: coin.marketSymbol,
      features: row,
      history: await readHistory(coin, asOfTimestamp, readCoinData),
    })
  }

  return {
    asOf: analysis.asOf,
    timeframe: "1h",
    objective: payload.objective,
    candidateCount: analysis.candidateCount,
    universeCoinCount: shortlist.universeCoinCount,
    marketContext: payload.marketContext,
    altMarketBackground: payload.marketContext?.altMarketBackground ?? null,
    marketDefinitions: payload.marketDefinitions,
    definitions: payload.definitions,
    flagDefinitions: payload.flagDefinitions,
    coins,
  }
}
