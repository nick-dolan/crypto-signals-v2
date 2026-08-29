import {
  DATA_COVERAGE_MAX_ATTEMPTS,
  DATA_COVERAGE_TARGET_COUNT,
} from "./config.js"
import { toIsoTimestamp } from "../../helpers/normalization-helper.js"
import {
  checkWithRetry,
  createCoverageRejection,
  normalizeSourceUniverse,
  summarizeRejections,
  toPublicMarket,
  validatePositiveInteger,
} from "./data-coverage-helpers.js"

export async function buildCompleteCryptoUniverse (
  sourceUniverse,
  checkCoverage,
  {
    generatedAt = new Date().toISOString(),
    maxAttempts = DATA_COVERAGE_MAX_ATTEMPTS,
    onProgress = () => {},
    targetCount = DATA_COVERAGE_TARGET_COUNT,
  } = {},
) {
  const { source, selection, candidates } = normalizeSourceUniverse(sourceUniverse)

  validatePositiveInteger(targetCount, "targetCount")
  validatePositiveInteger(maxAttempts, "maxAttempts")

  if (typeof checkCoverage !== "function") {
    throw new Error("checkCoverage must be a function")
  }

  if (typeof onProgress !== "function") {
    throw new Error("onProgress must be a function")
  }

  const orderedCandidates = [...candidates].sort(
    (first, second) => first.rank - second.rank,
  )
  const coins = []
  const rejected = []
  let liveCheckedCount = 0

  for (const coin of orderedCandidates) {
    if (coins.length === targetCount) {
      break
    }

    liveCheckedCount += 1

    const { attempts, result } = await checkWithRetry(
      checkCoverage,
      coin,
      maxAttempts,
      onProgress,
    )

    if (result?.complete) {
      const accepted = {
        ...coin,
        market: toPublicMarket(coin.market),
        attempts,
        coverage: result.coverage,
      }
      coins.push(accepted)
      onProgress({
        status: "accepted",
        coin,
        market: coin.market,
        accepted,
      })
      continue
    }

    const rejection = createCoverageRejection(coin, attempts, result)
    rejected.push(rejection)
    onProgress({
      status: "rejected",
      coin,
      market: coin.market,
      rejection,
    })
  }

  const checkedCandidateCount = coins.length + rejected.length

  return {
    generatedAt: toIsoTimestamp(generatedAt, "generatedAt"),
    source,
    selection,
    candidateCount: orderedCandidates.length,
    checkedCandidateCount,
    liveCheckedCount,
    uncheckedCandidateCount: orderedCandidates.length - checkedCandidateCount,
    targetCoinCount: targetCount,
    coinCount: coins.length,
    targetReached: coins.length === targetCount,
    rejectionSummary: summarizeRejections(rejected),
    coins,
    rejected,
  }
}
