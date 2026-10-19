import { withErrorContext } from "../../helpers/error-helper.js"
import { InvalidContextEnrichmentError, parseContextEnrichment } from "../step8-context-enrichment/parse-context-enrichment.js"

// Validate before releasing the shared slot: radash reports worker errors only after draining all candidates.
export function validateContextResponse (content, userMessage) {
  const candidate = JSON.parse(userMessage)
  try {
    const enrichment = parseContextEnrichment(content, candidate.symbol)
    for (const [field, publications] of [
      ["newsSummary", candidate.news.items],
      ["twitterSummary", candidate.twitter.tweets],
    ]) {
      if (publications.length === 0 && enrichment[field] !== null) {
        throw new InvalidContextEnrichmentError(`${field} must be null without source publications`)
      }
    }
  } catch (error) {
    if (error instanceof InvalidContextEnrichmentError) {
      error.symbol = candidate.symbol
      error.response = content
    }
    throw withErrorContext(error, {
      step: "step8-context-enrichment.js", operation: "summarize_publications", symbol: candidate.symbol,
    })
  }
}
