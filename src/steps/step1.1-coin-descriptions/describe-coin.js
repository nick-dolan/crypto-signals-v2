import { withErrorContext } from "../../helpers/error-helper.js"
import { callModel, getModelSettings } from "../../helpers/model-helper.js"
import { getRequiredString } from "../../helpers/normalization-helper.js"
import { isArray, isObject, isString } from "../../helpers/utils.typed.js"
import { createCoinResearchTools } from "./create-coin-research-tools.js"

export class CoinDescriptionUnavailableError extends Error {}

export async function describeCoin (
  coin,
  details,
  systemPrompt,
  { callAgent = callModel, requestTavily, reportError } = {},
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
    symbol: coin.symbol,
    reportError,
    seedUrls: coingecko
      ? [
          ...(isArray(details.links?.homepage) ? details.links.homepage : []),
          `https://www.coingecko.com/en/coins/${encodeURIComponent(coingecko.id)}`,
        ]
      : [],
  })
  const modelSettings = getModelSettings("coinDescription")
  let content
  try {
    content = await callAgent(systemPrompt, JSON.stringify({
      baseCurrencyId,
      symbol: getRequiredString(coin.symbol, "Candidate symbol"),
      name: getRequiredString(coin.name, "Candidate name"),
      marketSymbol: isString(coin.market?.tradingViewSymbol) ? coin.market.tradingViewSymbol : null,
      coingecko,
      seedUrls: research.seedUrls,
    }), { ...modelSettings, tools: research.tools })
  } catch (error) {
    throw withErrorContext(error, {
      step: "step1.1-coin-descriptions.js", operation: "describe_coin", symbol: coin.symbol,
      source: modelSettings.provider, provider: modelSettings.provider, model: modelSettings.model,
    })
  }
  const json = getRequiredString(content, "Agent response").replace(
    /^```(?:json)?\s*([\s\S]*?)\s*```$/i,
    "$1",
  )
  let result

  try {
    result = JSON.parse(json)
  } catch (error) {
    throw new Error("Agent description response is not valid JSON", { cause: error })
  }

  if (!isObject(result) || Object.keys(result).length !== 4 || result.baseCurrencyId !== baseCurrencyId) {
    throw new Error("Agent description response has an unexpected structure or candidate ID")
  }

  if (result.identityConfirmed !== true) {
    throw result.identityConfirmed === false
      ? new CoinDescriptionUnavailableError("Agent could not confirm the project identity")
      : new Error("Agent could not confirm the project identity")
  }

  if (result.description === null) {
    throw new CoinDescriptionUnavailableError("Agent could not find enough facts for a description")
  }

  const description = getRequiredString(result.description, "Agent description").replace(/\s+/g, " ")

  if (description.length > 700 || !/[а-яё]/i.test(description) || /<[^>]*>|https?:\/\//i.test(description)) {
    throw new Error("Agent description must be short Russian text without HTML or links")
  }

  return { description, sources: research.selectSources(result.sourceIds) }
}
