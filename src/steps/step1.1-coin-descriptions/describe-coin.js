import { callCopilotWithTools } from "../../api/copilot/chat.js"
import { getRequiredString } from "../../helpers/normalization-helper.js"
import { isArray, isObject, isString } from "../../helpers/utils.typed.js"
import { createCoinResearchTools } from "./create-coin-research-tools.js"

export async function describeCoin (
  coin,
  details,
  systemPrompt,
  { callAgent = callCopilotWithTools, requestTavily } = {},
) {
  const baseCurrencyId = getRequiredString(coin.baseCurrencyId, "Candidate baseCurrencyId")
  const coingecko = details
    ? {
        id: getRequiredString(details.id, "CoinGecko coin id"),
        symbol: isString(details.symbol) ? details.symbol : null,
        name: isString(details.name) ? details.name : null,
      }
    : null
  const research = createCoinResearchTools({
    request: requestTavily,
    seedUrls: coingecko
      ? [
          ...(isArray(details.links?.homepage) ? details.links.homepage : []),
          `https://www.coingecko.com/en/coins/${encodeURIComponent(coingecko.id)}`,
        ]
      : [],
  })
  const content = await callAgent(systemPrompt, JSON.stringify({
    baseCurrencyId,
    symbol: getRequiredString(coin.symbol, "Candidate symbol"),
    name: getRequiredString(coin.name, "Candidate name"),
    marketSymbol: isString(coin.market?.tradingViewSymbol) ? coin.market.tradingViewSymbol : null,
    coingecko,
    seedUrls: research.seedUrls,
  }), { model: "GPT-5.6 Sol", reasoningEffort: "medium", tools: research.tools })
  const json = getRequiredString(content, "Agent response").replace(
    /^```(?:json)?\s*([\s\S]*?)\s*```$/i,
    "$1",
  )
  let result

  try {
    result = JSON.parse(json)
  } catch {
    throw new Error("Agent description response is not valid JSON")
  }

  if (!isObject(result) || Object.keys(result).length !== 4 || result.baseCurrencyId !== baseCurrencyId) {
    throw new Error("Agent description response has an unexpected structure or candidate ID")
  }

  if (result.identityConfirmed !== true) {
    throw new Error("Agent could not confirm the project identity")
  }

  if (result.description === null) {
    throw new Error("Agent could not find enough facts for a description")
  }

  const description = getRequiredString(result.description, "Agent description").replace(/\s+/g, " ")

  if (description.length > 700 || !/[а-яё]/i.test(description) || /<[^>]*>|https?:\/\//i.test(description)) {
    throw new Error("Agent description must be short Russian text without HTML or links")
  }

  return { description, sources: research.selectSources(result.sourceIds) }
}
