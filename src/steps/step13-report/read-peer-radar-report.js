import { readTmpJson } from "../../helpers/fs-helper.js"
import { isArray, isError, isFinite, isObject, isSafeInteger, isString } from "../../helpers/utils.typed.js"

function isText (value) {
  return isString(value) && value.trim().length > 0
}

function isTimestamp (value) {
  return isText(value) && isFinite(Date.parse(value))
}

function isCount (value) {
  return isSafeInteger(value) && value >= 0
}

function hasFields (value, strings, numbers = []) {
  return isObject(value)
    && strings.every(field => isText(value[field]))
    && numbers.every(field => isFinite(value[field]))
}

function isLeader (leader) {
  return hasFields(leader, ["baseCurrencyId", "symbol", "basis", "caveat"], [
    "ageHours", "return4hPct", "move4hAtr", "marketExcess4hAtr", "relativeVolume4h",
    "retainedPct", "returnSinceStartPct", "moveSinceStartAtr", "coinReturnSinceStartPct",
    "coinMoveSinceStartAtr", "responseRatio", "gapAtr",
  ])
  && [leader.detectedAt, leader.windowStartedAt].every(isTimestamp)
  && ["competitor", "adjacent"].includes(leader.type)
  && ["fresh", "fading"].includes(leader.status)
  && ["flat", "rising", "falling"].includes(leader.coinReaction)
}

function isObservation (observation) {
  return hasFields(observation, ["baseCurrencyId", "explanation"])
    && hasFields(observation.coin, ["baseCurrencyId", "symbol", "name", "marketSymbol"])
    && observation.baseCurrencyId === observation.coin.baseCurrencyId
    && ["watch", "limited"].includes(observation.verdict)
    && ["available", "partial"].includes(observation.peerStatus)
    && [observation.peerCount, observation.availablePeerCount, observation.benchmarkCoinCount].every(isCount)
    && isArray(observation.caveats) && observation.caveats.every(isText)
    && isArray(observation.leaders) && observation.leaders.length > 0
    && observation.leaders.every(isLeader)
}

function isRadarReport (data) {
  if (
    !isObject(data) || data.schemaVersion !== 1 || data.timeframe !== "1h"
    || ![data.asOf, data.snapshotClosedAt, data.generatedAt, data.scanGeneratedAt].every(isTimestamp)
    || Date.parse(data.snapshotClosedAt) !== Date.parse(data.asOf) + 3_600_000
    || (data.registryGeneratedAt !== null && !isTimestamp(data.registryGeneratedAt))
    || !hasFields(data.analysis, ["source", "model", "reasoningEffort"])
    || !hasFields(data.criteria, ["impulse", "lag", "reaction"])
    || !isObject(data.coverage)
    || !["available", "partial", "no_peers", "insufficient_data", "not_covered", "unreviewed", "unavailable"]
      .every(key => isCount(data.coverage[key]))
      || ![data.universeCoinCount, data.loadedCoinCount, data.candidateCount, data.observationCount, data.watchCount].every(isCount)
      || !isArray(data.observations) || !data.observations.every(isObservation)
  ) {
    return false
  }

  return Object.values(data.coverage).reduce((sum, count) => sum + count, 0) === data.loadedCoinCount
    && data.loadedCoinCount <= data.universeCoinCount
    && data.observationCount <= data.loadedCoinCount
    && data.candidateCount === data.observationCount
    && data.observationCount === data.observations.length
    && new Set(data.observations.map(observation => observation.baseCurrencyId)).size === data.observationCount
    && data.watchCount === data.observations.filter(observation => observation.verdict === "watch").length
    && data.analysisStatus === (data.observationCount ? "complete" : "skipped_no_candidates")
    && data.analysis.callCount === (data.observationCount ? 1 : 0)
}

function unavailable (warning) {
  return { status: "unavailable", warning, data: null }
}

export async function readPeerRadarReport (asOf, { readJson = readTmpJson } = {}) {
  try {
    const data = await readJson("step12-peer-radar-analysis.json")
    if (!isRadarReport(data)) {
      return unavailable("Некорректный формат результата шага 12. Перезапустите анализ радара; основной отчёт сохранён.")
    }
    if (data.asOf !== asOf) {
      return unavailable("Результат шага 12 относится к другому срезу рынка. Для этого HTML нужны шаги 11–12 с тем же asOf.")
    }

    // A standalone step 12 report is self-contained; when a newer scan exists, don't show old analysis.
    const scan = await readJson("step11-peer-radar.json").catch((error) => {
      if (error.code === "ENOENT") {
        return undefined
      }
      throw error
    })
    if (scan !== undefined && (
      scan?.schemaVersion !== 1 || scan.asOf !== data.asOf
      || scan.snapshotClosedAt !== data.snapshotClosedAt || scan.generatedAt !== data.scanGeneratedAt
    )) {
      return unavailable("Результат шага 12 не соответствует текущему скану шага 11. Повторите шаг 12; старые наблюдения не показаны.")
    }

    return { status: "available", warning: null, data }
  } catch (error) {
    return unavailable(error.code === "ENOENT"
      ? "Результат шага 12 отсутствует. Запустите радар и повторите шаг 13; основной отчёт доступен без него."
      : `Не удалось загрузить радар соседей: ${isError(error) ? error.message : "неизвестная ошибка"}. Основной отчёт сохранён.`)
  }
}
