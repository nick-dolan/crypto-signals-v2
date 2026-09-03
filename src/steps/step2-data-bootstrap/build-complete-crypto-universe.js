import { toIsoTimestamp } from "../../helpers/normalization-helper.js"
import { isFunction, isString } from "../../helpers/utils.typed.js"
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
    maxAttempts = 2,
    onProgress = () => {},
  } = {},
) {
  const { source, selection, candidates } = normalizeSourceUniverse(sourceUniverse)

  validatePositiveInteger(maxAttempts, "maxAttempts")

  if (!isFunction(checkCoverage)) {
    throw new Error("checkCoverage must be a function")
  }

  if (!isFunction(onProgress)) {
    throw new Error("onProgress must be a function")
  }

  const orderedCandidates = [...candidates].sort(
    (first, second) => first.rank - second.rank,
  )
  const coins = []
  const rejected = []

  for (const [index, coin] of orderedCandidates.entries()) {
    const progress = {
      index: index + 1,
      total: orderedCandidates.length,
    }
    const { attempts, result } = await checkWithRetry(
      checkCoverage,
      coin,
      maxAttempts,
      event => onProgress({ ...event, ...progress }),
    )

    if (result?.complete) {
      const accepted = {
        ...coin,
        market: toPublicMarket(coin.market),
        attempts,
        coverage: result.coverage,
        dataFile: isString(result.dataFile) ? result.dataFile : null,
      }
      coins.push(accepted)
      onProgress({
        status: "accepted",
        ...progress,
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
      ...progress,
      coin,
      market: coin.market,
      rejection,
    })
  }

  return {
    generatedAt: toIsoTimestamp(generatedAt, "generatedAt"),
    source,
    selection,
    candidateCount: orderedCandidates.length,
    coinCount: coins.length,
    rejectionSummary: summarizeRejections(rejected),
    coins,
    rejected,
  }
}
