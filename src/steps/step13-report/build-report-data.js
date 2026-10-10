import { omit } from "radash"
import { readCoinHistory } from "../../helpers/coin-history-helper.js"
import { readTmpJson } from "../../helpers/fs-helper.js"
import { isArray, isSafeInteger, isString } from "../../helpers/utils.typed.js"
import { decodeAgentPayload } from "../step9-agent-payload/agent-payload-format.js"
import { formatCoinSummary, readCoinSummary } from "../step10-agent-analysis/coin-summary.js"

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
    throw new Error("Steps 5, 9 and 10 must use the same closed hourly snapshot (asOf, 1h)")
  }

  if (payload.schemaVersion >= 14 && (![3, 4].includes(analysis.schemaVersion) || analysis.objective !== payload.objective)) {
    throw new Error("Step 10 growth analysis must use schemaVersion 3 or 4 and match the step 9 objective")
  }

  const { candidates } = decodeAgentPayload(payload)
  const rowsBySymbol = indexBySymbol(candidates, candidate => candidate.symbol, "Step 9 candidates")
  const shortlistBySymbol = indexBySymbol(shortlist.candidates, item => item?.coin?.symbol, "Step 5 candidates")
  const assessmentsBySymbol = indexBySymbol(analysis.assessments, item => item?.symbol, "Step 10 assessments")
  const topBySymbol = indexBySymbol(analysis.topCandidates, item => item?.symbol, "Step 10 top candidates")

  for (const [step, input, bySymbol] of [
    [5, shortlist, shortlistBySymbol],
    [9, payload, rowsBySymbol],
    [10, analysis, assessmentsBySymbol],
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
    throw new Error("Steps 5, 9 and 10 candidate sets do not match")
  }

  if ([...topBySymbol.keys()].some(symbol => !assessmentsBySymbol.has(symbol))) {
    throw new Error("Step 10 top candidates must belong to assessments")
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
    const summary = analysis.schemaVersion === 4 || top?.technicalSummary === undefined
      ? assessment.technicalSummary
      : top.technicalSummary
    const technicalSummary = summary === undefined && analysis.schemaVersion !== 4
      ? undefined
      : readCoinSummary(summary, `${coin.symbol} technicalSummary`)
    const explanation = analysis.schemaVersion === 4
      ? formatCoinSummary(technicalSummary)
      : isString(top?.explanation) ? top.explanation : top && technicalSummary ? formatCoinSummary(technicalSummary) : ""

    coins.push({
      ...omit(assessment, ["directionBias"]),
      ...(technicalSummary === undefined ? {} : { technicalSummary }),
      ...(analysis.schemaVersion >= 3 && technicalSummary ? { summary: technicalSummary } : {}),
      explanation,
      technicalExplanation: explanation,
      topRank: top ? analysis.topCandidates.indexOf(top) + 1 : null,
      name: coin.name,
      baseCurrencyId: coin.baseCurrencyId,
      marketSymbol: coin.marketSymbol,
      features: row,
      history: await readCoinHistory(coin, asOfTimestamp, { readCoinData }),
    })
  }

  return {
    asOf: analysis.asOf,
    timeframe: "1h",
    objective: analysis.objective ?? payload.objective,
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
