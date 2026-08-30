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
    maxAttempts = 2,
    onProgress = () => {},
  } = {},
) {
  const { source, selection, candidates } = normalizeSourceUniverse(sourceUniverse)

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

  for (const coin of orderedCandidates) {
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
        dataFile: typeof result.dataFile === "string" ? result.dataFile : null,
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
