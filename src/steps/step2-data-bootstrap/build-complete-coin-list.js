import { parallel } from "radash"

import { withErrorContext } from "../../helpers/error-helper.js"
import { toIsoTimestamp } from "../../helpers/normalization-helper.js"
import { isFunction, isString } from "../../helpers/utils.typed.js"
import {
  checkWithRetry,
  createCoverageRejection,
  normalizeSourceCoinList,
  summarizeRejections,
  toPublicMarket,
  validatePositiveInteger,
} from "./data-coverage-helpers.js"

export async function buildCompleteCoinList (
  sourceCoinList,
  checkCoverage,
  {
    concurrency = 6,
    generatedAt = new Date().toISOString(),
    maxAttempts = 2,
    onProgress = () => {},
    reportError,
  } = {},
) {
  const { source, selection, candidates } = normalizeSourceCoinList(sourceCoinList)

  validatePositiveInteger(concurrency, "concurrency")
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
  // radash consumes its queue from the end; keep higher-ranked coins first.
  const queue = orderedCandidates.map((coin, index) => ({ coin, index })).reverse()
  let stopped = false
  const checked = await parallel(
    Math.min(concurrency, queue.length || 1),
    queue,
    async ({ coin, index }) => {
      if (stopped) {
        return null
      }

      try {
        const progress = {
          index: index + 1,
          total: orderedCandidates.length,
        }
        const { attempts, result } = await checkWithRetry(
          checkCoverage,
          coin,
          maxAttempts,
          event => onProgress({ ...event, ...progress }),
          { reportError },
        )

        if (result?.complete) {
          const accepted = {
            ...coin,
            market: toPublicMarket(coin.market),
            attempts,
            coverage: result.coverage,
            dataFile: isString(result.dataFile) ? result.dataFile : null,
          }
          onProgress({
            status: "accepted",
            ...progress,
            coin,
            market: coin.market,
            accepted,
          })
          return { accepted }
        }

        const rejection = createCoverageRejection(coin, attempts, result)
        onProgress({
          status: "rejected",
          ...progress,
          coin,
          market: coin.market,
          rejection,
        })
        return { rejection }
      } catch (error) {
        stopped = true
        throw withErrorContext(error, {
          step: "step2-data-bootstrap.js", operation: "check_coin_coverage", symbol: coin.symbol,
          marketSymbol: coin.market?.tradingViewSymbol,
        })
      }
    },
  ).catch((error) => {
    throw error.errors?.[0] ?? error
  })
  const results = checked.reverse()
  const coins = results.flatMap(result => result.accepted ? [result.accepted] : [])
  const rejected = results.flatMap(result => result.rejection ? [result.rejection] : [])

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
