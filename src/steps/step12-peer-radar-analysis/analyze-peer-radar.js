import { callCopilot } from "../../api/copilot/chat.js"
import { isArray, isFinite, isFunction, isObject, isSafeInteger, isString } from "../../helpers/utils.typed.js"
import { InvalidPeerRadarAnalysisError, parsePeerRadarAnalysis } from "./parse-peer-radar-analysis.js"

function selectFacts (source, stringFields, numberFields, label) {
  if (!isObject(source)) {
    throw new Error(`${label} must be an object`)
  }

  for (const field of stringFields) {
    if (!isString(source[field]) || !source[field].trim()) {
      throw new Error(`${label}.${field} must be a non-empty string`)
    }
  }

  for (const field of numberFields) {
    if (!isFinite(source[field])) {
      throw new Error(`${label}.${field} must be finite`)
    }
  }

  return Object.fromEntries(
    [...stringFields, ...numberFields].map(field => [field, source[field]]),
  )
}

function selectLeader (leader, label) {
  const facts = selectFacts(
    leader,
    ["baseCurrencyId", "symbol", "type", "basis", "caveat", "detectedAt", "windowStartedAt", "status", "coinReaction"],
    [
      "ageHours", "return4hPct", "move4hAtr", "marketExcess4hAtr", "relativeVolume4h",
      "retainedPct", "returnSinceStartPct", "moveSinceStartAtr", "coinReturnSinceStartPct",
      "coinMoveSinceStartAtr", "responseRatio", "gapAtr",
    ],
    label,
  )

  if (
    !["competitor", "adjacent"].includes(facts.type)
    || !["fresh", "fading"].includes(facts.status)
    || !["flat", "rising", "falling"].includes(facts.coinReaction)
  ) {
    throw new Error(`${label} has an invalid relation, status or reaction`)
  }

  return facts
}

function selectCandidate (candidate, index) {
  const facts = selectFacts(
    candidate,
    ["peerStatus"],
    ["peerCount", "availablePeerCount", "benchmarkCoinCount"],
    `Step 11 candidate ${index}`,
  )

  if (
    !["available", "partial"].includes(facts.peerStatus)
    || !isArray(candidate.leaders)
    || !candidate.leaders.length
  ) {
    throw new Error(`Step 11 candidate ${index} needs available/partial peers and non-empty leaders`)
  }

  return {
    coin: selectFacts(
      candidate.coin,
      ["baseCurrencyId", "symbol", "name", "tradingViewSymbol", "marketSymbol"],
      [],
      `Step 11 candidate ${index}.coin`,
    ),
    ...facts,
    leaders: candidate.leaders.map((leader, leaderIndex) => (
      selectLeader(leader, `Step 11 candidate ${index}.leaders[${leaderIndex}]`)
    )),
  }
}

function buildPeerRadarPayload (scan) {
  if (
    !isObject(scan) || scan.schemaVersion !== 1
    || scan.timeframe !== "1h" || !isArray(scan.candidates)
  ) {
    throw new Error("Step 11 peer scan requires schemaVersion 1, timeframe 1h and candidates")
  }

  const payload = {
    ...selectFacts(
      scan,
      ["generatedAt", "asOf", "snapshotClosedAt", "timeframe"],
      ["schemaVersion", "universeCoinCount", "loadedCoinCount", "candidateCount"],
      "Step 11 peer scan",
    ),
    registryGeneratedAt: scan.registryGeneratedAt,
    coverage: selectFacts(
      scan.coverage,
      [],
      ["available", "partial", "no_peers", "insufficient_data", "not_covered", "unreviewed", "unavailable"],
      "Step 11 coverage",
    ),
    criteria: selectFacts(scan.criteria, ["impulse", "lag", "reaction"], [], "Step 11 criteria"),
    candidates: scan.candidates.map(selectCandidate),
  }

  if (
    ![payload.generatedAt, payload.asOf, payload.snapshotClosedAt].every(value => isFinite(Date.parse(value)))
    || (payload.registryGeneratedAt !== null && (
      !isString(payload.registryGeneratedAt) || !isFinite(Date.parse(payload.registryGeneratedAt))
    ))
  ) {
    throw new Error("Step 11 peer scan has invalid timestamps")
  }

  if (
    ![payload.universeCoinCount, payload.loadedCoinCount, ...Object.values(payload.coverage)]
      .every(value => isSafeInteger(value) && value >= 0)
      || Object.values(payload.coverage).reduce((sum, count) => sum + count, 0) !== payload.loadedCoinCount
  ) {
    throw new Error("Step 11 coverage must count all loaded coins")
  }

  if (
    payload.candidateCount !== payload.candidates.length
    || new Set(payload.candidates.map(candidate => candidate.coin.baseCurrencyId)).size !== payload.candidateCount
  ) {
    throw new Error("Step 11 candidateCount must match unique candidate IDs")
  }

  return payload
}

export async function analyzePeerRadar (
  scan,
  systemPrompt,
  { callAgent = callCopilot } = {},
) {
  const payload = buildPeerRadarPayload(scan)

  if (!isString(systemPrompt) || !systemPrompt.trim()) {
    throw new Error("Peer radar system prompt is required")
  }

  if (!isFunction(callAgent)) {
    throw new Error("Peer radar agent must be a function")
  }

  let analysis = { observations: [] }

  if (payload.candidates.length) {
    const content = await callAgent(systemPrompt, JSON.stringify(payload), {
      model: "GPT-6-Astra",
      reasoningEffort: "high",
    })

    try {
      analysis = parsePeerRadarAnalysis(content, payload)
    } catch (error) {
      if (error instanceof InvalidPeerRadarAnalysisError) {
        error.response = content
      }
      throw error
    }
  }

  const byId = new Map(analysis.observations.map(observation => [observation.baseCurrencyId, observation]))
  const { candidates, generatedAt: scanGeneratedAt, ...metadata } = payload
  const observations = candidates.map(candidate => ({
    ...candidate,
    ...byId.get(candidate.coin.baseCurrencyId),
  })).sort((left, right) => Number(right.verdict === "watch") - Number(left.verdict === "watch"))

  return {
    ...metadata,
    scanGeneratedAt,
    generatedAt: new Date().toISOString(),
    analysisStatus: candidates.length ? "complete" : "skipped_no_candidates",
    analysis: {
      source: "github-copilot-sdk",
      model: "GPT-6-Astra",
      reasoningEffort: "high",
      callCount: candidates.length ? 1 : 0,
    },
    observationCount: observations.length,
    watchCount: observations.filter(observation => observation.verdict === "watch").length,
    observations,
  }
}
