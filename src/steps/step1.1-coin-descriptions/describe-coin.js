import { callUnofficialCopilot } from "../../api/copilot-unofficial/chat.js"
import { getRequiredString } from "../../helpers/normalization-helper.js"
import { isObject, isString } from "../../helpers/utils.typed.js"

export async function describeCoin (
  coin,
  details,
  systemPrompt,
  { callAgent = callUnofficialCopilot } = {},
) {
  const sourceDescription = isString(details?.description?.en)
    ? details.description.en.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim()
    : ""

  if (!sourceDescription) {
    throw new Error(`CoinGecko ${details?.id} has no description`)
  }

  const baseCurrencyId = getRequiredString(coin.baseCurrencyId, "Candidate baseCurrencyId")
  const content = await callAgent(systemPrompt, JSON.stringify({
    baseCurrencyId,
    symbol: getRequiredString(coin.symbol, "Candidate symbol"),
    name: getRequiredString(coin.name, "Candidate name"),
    coingecko: {
      id: details.id,
      description: sourceDescription.slice(0, 16_000),
    },
  }), { model: "gemini-3.7-flash", reasoningEffort: "medium" })
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

  if (!isObject(result) || Object.keys(result).length !== 2 || result.baseCurrencyId !== baseCurrencyId) {
    throw new Error("Agent description response has an unexpected structure or candidate ID")
  }

  if (result.description === null) {
    throw new Error("Agent could not find enough facts for a description")
  }

  const description = getRequiredString(result.description, "Agent description").replace(/\s+/g, " ")

  if (description.length > 700 || !/[а-яё]/i.test(description) || /<[^>]*>|https?:\/\//i.test(description)) {
    throw new Error("Agent description must be short Russian text without HTML or links")
  }

  return description
}
