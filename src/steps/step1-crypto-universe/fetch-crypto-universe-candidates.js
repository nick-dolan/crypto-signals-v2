import { requestTradingViewJson } from "../../api/tradingview/request.js"
import { CRYPTO_UNIVERSE_CANDIDATE_RANK_MAX } from "./config.js"
import {
  createScreenerRequest,
  normalizeScreenerRow,
  validatePositiveInteger,
  validateScreenerCandidates,
  validateScreenerPayload,
} from "./crypto-universe-helpers.js"

export async function fetchCryptoUniverseCandidates ({
  rankMax = CRYPTO_UNIVERSE_CANDIDATE_RANK_MAX,
  timeoutMs = 15_000,
} = {}) {
  validatePositiveInteger(rankMax, "rankMax")

  const payload = await requestTradingViewJson(
    "https://scanner.tradingview.com/coin/scan",
    {
      label: "TradingView crypto screener",
      timeoutMs,
      method: "POST",
      headers: {
        "content-type": "application/json",
        "origin": "https://www.tradingview.com",
      },
      body: JSON.stringify(createScreenerRequest(rankMax)),
    },
  )

  validateScreenerPayload(payload)

  const candidates = payload.data
    .map((row, index) => normalizeScreenerRow(row, index, rankMax))
    .sort((first, second) => first.rank - second.rank)

  validateScreenerCandidates(candidates, payload.totalCount)

  return candidates
}
