import { isArray, isFinite, isString } from "../../helpers/utils.typed.js"

function softPositive (value, scale) {
  const positive = Math.max(value, 0)

  return positive / (positive + scale)
}

function geometricMean (...values) {
  return values.length === 0
    ? 0
    : Math.pow(
        values.reduce((product, value) => product * value, 1),
        1 / values.length,
      )
}

function average (values) {
  return values.length === 0
    ? 0
    : values.reduce((sum, value) => sum + value, 0) / values.length
}

function calculateCompressionAxis (profile) {
  const { range_compression_streak: rangeStreak, squeeze_age_hours: squeezeAge } = (
    profile.features.volatilityCompression
  )

  return {
    active: squeezeAge >= 4,
    score: softPositive(squeezeAge, 12),
    secondaryScore: rangeStreak,
  }
}

function calculateVolumeOrderFlowAxis (profile) {
  const {
    volume_acceleration_3h: acceleration,
    rel_volume_at_time: relativeVolume,
    vd_net_4h_over_volume: volumeDeltaShare,
    cvd_minus_price_z_12h: cvdMinusPriceZ,
  } = profile.features.volumeOrderFlow
  const levelScore = softPositive(relativeVolume - 1, 1)
  const flowScore = Math.max(
    softPositive(Math.abs(volumeDeltaShare), 0.15),
    softPositive(Math.abs(cvdMinusPriceZ), 1),
  )

  return {
    active: acceleration >= 0.25 && (
      relativeVolume >= 1.5
      || Math.abs(volumeDeltaShare) >= 0.1
      || Math.abs(cvdMinusPriceZ) >= 0.75
    ),
    score: geometricMean(
      softPositive(acceleration, 0.5),
      Math.max(levelScore, flowScore),
    ),
    secondaryScore: 0,
  }
}

function calculateDerivativesAxis (profile) {
  const {
    oi_acceleration_4h: oiAcceleration,
    oi_change_4h_z_30d: oiChangeZ,
    oi_up_while_rv_down: oiBuildsQuietly,
    funding_percentile_90d: fundingPercentile,
    liquidations_4h_over_oi: liquidationsOverOi,
    liq_imbalance_4h: liquidationImbalance,
    crowd_vs_top_traders: crowdPositioning,
  } = profile.features.derivatives
  const alignedCrowd = Math.sign(fundingPercentile - 0.5) * crowdPositioning
  const oiSetup = oiChangeZ >= 0.75 && oiBuildsQuietly
  const oiTrigger = oiChangeZ >= 0.75 && oiAcceleration >= 0.005
  const liquidationTrigger = liquidationsOverOi >= 0.0005
    && Math.abs(liquidationImbalance) >= 0.5
  const crowdSetup = Math.abs(fundingPercentile - 0.5) >= 0.4
    && alignedCrowd >= 0.15
  const oiScore = geometricMean(
    softPositive(oiChangeZ, 1),
    Math.max(Number(oiBuildsQuietly), softPositive(oiAcceleration, 0.015)),
  )
  const liquidationScore = geometricMean(
    softPositive(liquidationsOverOi, 0.0015),
    softPositive(Math.abs(liquidationImbalance), 0.5),
  )
  const crowdScore = geometricMean(
    softPositive(Math.abs(fundingPercentile - 0.5) - 0.3, 0.1),
    softPositive(alignedCrowd, 0.2),
  )

  return {
    active: oiSetup || oiTrigger || liquidationTrigger || crowdSetup,
    score: Math.max(oiScore, liquidationScore, crowdScore),
    secondaryScore: 0,
    oiSetup,
    oiTrigger,
    liquidationTrigger,
    crowdSetup,
  }
}

function calculateSocialAxis (profile) {
  if (profile.features.social === null) {
    return {
      active: false,
      score: 0,
      secondaryScore: 0,
    }
  }

  const {
    interactions_acceleration_3h: acceleration,
    social_minus_price_z_3h: socialMinusPriceZ,
  } = profile.features.social

  return {
    active: acceleration >= 0.25 || socialMinusPriceZ >= 1,
    score: Math.max(
      softPositive(acceleration, 0.5),
      softPositive(socialMinusPriceZ, 1),
    ),
    secondaryScore: 0,
  }
}

function calculateRelativeStrengthAxis (profile) {
  const {
    corr_btc_change_24h_vs_7d: correlationChange,
    residual_z_30d: residualZ,
  } = profile.features.relativeStrength

  return {
    active: correlationChange <= -0.3 && Math.abs(residualZ) >= 1,
    score: geometricMean(
      softPositive(-correlationChange, 0.3),
      softPositive(Math.abs(residualZ), 1),
    ),
    secondaryScore: 0,
  }
}

function calculateNarrativeAxis (profile) {
  const {
    category_momentum_4h: categoryMomentum,
    category_breadth: categoryBreadth,
    coin_leads_category: coinLead,
  } = profile.features.breadthNarrative
  const { atr24hPct } = profile.context

  if (
    ![categoryMomentum, categoryBreadth, coinLead].every(isFinite)
    || !isFinite(atr24hPct)
    || atr24hPct <= 0
  ) {
    return {
      active: false,
      contextActive: false,
      score: 0,
      secondaryScore: 0,
    }
  }

  const categoryMove = Math.abs(categoryMomentum) / atr24hPct
  const coinDislocation = Math.abs(coinLead) / atr24hPct
  const contextActive = categoryMove >= 0.5 && categoryBreadth >= 0.6

  return {
    active: contextActive && coinDislocation >= 0.5,
    contextActive,
    score: geometricMean(
      softPositive(categoryMove, 1),
      softPositive(categoryBreadth - 0.5, 0.15),
      softPositive(coinDislocation, 1),
    ),
    secondaryScore: 0,
  }
}

function evaluateProfile (profile) {
  const axes = {
    compression: calculateCompressionAxis(profile),
    volumeOrderFlow: calculateVolumeOrderFlowAxis(profile),
    derivatives: calculateDerivativesAxis(profile),
    social: calculateSocialAxis(profile),
    relativeStrength: calculateRelativeStrengthAxis(profile),
    narrative: calculateNarrativeAxis(profile),
  }
  const {
    fresh_quiet_breakout: freshQuietBreakout,
    late_pump: latePump,
  } = profile.features.movementLifecycle
  const divergences = profile.features.divergences
  const divergenceFlags = Object.entries(divergences)
    .filter(([, active]) => active === true)
    .map(([name]) => name)
  const setupSignals = [
    axes.compression.active && "volatilityCompression",
    freshQuietBreakout && "preBreakoutCompression",
    axes.derivatives.oiSetup && "quietOiBuild",
    axes.derivatives.crowdSetup && "crowdedPositioning",
    divergences.squeeze_fuel && "squeezeFuel",
  ].filter(Boolean)
  const triggerSignals = [
    freshQuietBreakout && "freshBreakout",
    axes.volumeOrderFlow.active && "volumeOrderFlow",
    (axes.derivatives.oiTrigger || axes.derivatives.liquidationTrigger) && "derivatives",
    axes.social.active && "socialAttention",
    divergences.unconfirmed_move && "unconfirmedPriceMove",
  ].filter(Boolean)
  const contextSignals = [
    (axes.relativeStrength.active || divergences.resilient) && "relativeStrength",
    (axes.narrative.contextActive || divergences.laggard) && "narrative",
  ].filter(Boolean)
  const activeAxes = Object.entries(axes)
    .filter(([, axis]) => axis.active)
    .map(([name]) => name)
  const signalAxisCount = [
    "compression",
    "volumeOrderFlow",
    "derivatives",
    "social",
  ].filter(name => axes[name].active).length
  const averageAxisScore = average(
    activeAxes.map(name => axes[name].score),
  )

  return {
    profile,
    axes,
    freshQuietBreakout,
    latePump,
    divergenceFlags,
    setupSignals,
    triggerSignals,
    contextSignals,
    activeAxes,
    priority: {
      setupAndTrigger: Number(
        setupSignals.length > 0 && triggerSignals.length > 0,
      ),
      multipleTriggers: Number(triggerSignals.length >= 2),
      signalAxisCount,
      contextCount: contextSignals.length,
      freshnessAdjustedScore: averageAxisScore
        + 0.15 * Number(freshQuietBreakout),
      averageAxisScore,
    },
  }
}

function compareByAxis (axisName) {
  return (first, second) => (
    second.axes[axisName].score - first.axes[axisName].score
    || second.axes[axisName].secondaryScore - first.axes[axisName].secondaryScore
    || first.profile.coin.baseCurrencyId.localeCompare(
      second.profile.coin.baseCurrencyId,
    )
  )
}

function comparePriority (first, second) {
  return (
    second.priority.setupAndTrigger - first.priority.setupAndTrigger
    || second.priority.multipleTriggers - first.priority.multipleTriggers
    || second.priority.signalAxisCount - first.priority.signalAxisCount
    || second.priority.contextCount - first.priority.contextCount
    || second.priority.freshnessAdjustedScore - first.priority.freshnessAdjustedScore
    || second.priority.averageAxisScore - first.priority.averageAxisScore
    || first.profile.coin.baseCurrencyId.localeCompare(
      second.profile.coin.baseCurrencyId,
    )
  )
}

function addSelectionReason (selectionReasonsById, evaluation, reason) {
  const baseCurrencyId = evaluation.profile.coin.baseCurrencyId
  const reasons = selectionReasonsById.get(baseCurrencyId) ?? []

  if (!reasons.includes(reason)) {
    reasons.push(reason)
    selectionReasonsById.set(baseCurrencyId, reasons)
  }
}

function validateProfiles (profiles) {
  if (!isArray(profiles)) {
    throw new Error("Feature profiles must be an array")
  }

  const baseCurrencyIds = new Set()

  for (const [index, profile] of profiles.entries()) {
    const baseCurrencyId = profile?.coin?.baseCurrencyId

    if (!isString(baseCurrencyId) || !baseCurrencyId) {
      throw new Error(`Feature profile at index ${index} has no baseCurrencyId`)
    }

    if (baseCurrencyIds.has(baseCurrencyId)) {
      throw new Error(`Feature profiles contain duplicate ${baseCurrencyId}`)
    }

    baseCurrencyIds.add(baseCurrencyId)
  }
}

export function buildPreliminaryShortlist (profiles) {
  validateProfiles(profiles)

  const evaluations = profiles.map(evaluateProfile)
  const eligibleEvaluations = evaluations.filter(evaluation => !evaluation.latePump)
  const selectionReasonsById = new Map()
  const divergenceCandidates = eligibleEvaluations.filter(
    evaluation => evaluation.divergenceFlags.length > 0,
  )
  const freshQuietBreakoutCandidates = eligibleEvaluations.filter(
    evaluation => evaluation.freshQuietBreakout,
  )

  for (const evaluation of divergenceCandidates) {
    addSelectionReason(selectionReasonsById, evaluation, "divergences")
  }

  for (const evaluation of freshQuietBreakoutCandidates) {
    addSelectionReason(selectionReasonsById, evaluation, "movementLifecycle")
  }

  const eligibleCoinCountByAxis = {}
  const nominatedCoinCountByAxis = {}

  for (const axisName of [
    "compression",
    "volumeOrderFlow",
    "derivatives",
    "social",
    "relativeStrength",
    "narrative",
  ]) {
    const eligible = eligibleEvaluations.filter(evaluation => (
      evaluation.axes[axisName].active
    ))
    const selected = [...eligible].sort(compareByAxis(axisName)).slice(0, 5)

    eligibleCoinCountByAxis[axisName] = eligible.length
    nominatedCoinCountByAxis[axisName] = selected.length

    for (const evaluation of selected) {
      addSelectionReason(selectionReasonsById, evaluation, axisName)
    }
  }

  const nominated = eligibleEvaluations
    .filter(evaluation => selectionReasonsById.has(
      evaluation.profile.coin.baseCurrencyId,
    ))
    .sort(comparePriority)
  const selected = nominated.slice(0, 60)
  const candidates = selected.map((evaluation, index) => ({
    ...evaluation.profile,
    selection: {
      priority: index + 1,
      selectedBy: selectionReasonsById.get(
        evaluation.profile.coin.baseCurrencyId,
      ),
      divergenceFlags: evaluation.divergenceFlags,
      activeAxes: evaluation.activeAxes,
      setupSignals: evaluation.setupSignals,
      triggerSignals: evaluation.triggerSignals,
      contextSignals: evaluation.contextSignals,
    },
  }))

  return {
    universeCoinCount: profiles.length,
    candidateCount: candidates.length,
    excludedCoinCount: profiles.length - candidates.length,
    filter: {
      topPerAxis: 5,
      candidateLimit: 60,
      latePumpExcludedCoinCount: evaluations.length - eligibleEvaluations.length,
      divergenceNominatedCoinCount: divergenceCandidates.length,
      freshQuietBreakoutNominatedCoinCount:
        freshQuietBreakoutCandidates.length,
      eligibleCoinCountByAxis,
      nominatedCoinCountByAxis,
      nominatedBeforeLimit: nominated.length,
      limitApplied: nominated.length > 60,
    },
    candidates,
  }
}
