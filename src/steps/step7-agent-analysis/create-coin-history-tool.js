import { defineTool } from "@github/copilot-sdk"

import { readTmpJson } from "../../helpers/fs-helper.js"
import { createBootstrapDataRelativePath } from "../step2-data-bootstrap/check-coin-data-coverage.js"

function normalizeNumber (value) {
  if (!Number.isFinite(value)) {
    return null
  }

  return Object.is(value, -0) ? 0 : value
}

function getCandidateSymbols (payload) {
  if (!Array.isArray(payload?.schema) || !Array.isArray(payload?.candidates)) {
    throw new Error("Step 6 agent payload is incomplete")
  }

  const symbolIndex = payload.schema.indexOf("symbol")

  if (symbolIndex < 0) {
    throw new Error("Step 6 agent payload does not define symbol")
  }

  const symbols = payload.candidates.map(row => row?.[symbolIndex])

  if (symbols.some(symbol => typeof symbol !== "string" || !symbol)) {
    throw new Error("Step 6 agent payload contains an invalid symbol")
  }

  if (payload.candidateCount !== symbols.length) {
    throw new Error("Step 6 candidate count does not match its rows")
  }

  return symbols
}

export function validateAgentInputs (payload, shortlist) {
  const symbols = getCandidateSymbols(payload)
  const shortlistedCoins = shortlist?.candidates?.map(candidate => candidate?.coin)

  if (
    !Array.isArray(shortlistedCoins)
    || shortlist.candidateCount !== shortlistedCoins.length
    || shortlistedCoins.length !== symbols.length
    || shortlistedCoins.some((coin, index) => coin?.symbol !== symbols[index])
  ) {
    throw new Error("Step 5 candidates do not match the step 6 agent payload")
  }

  if (shortlist.asOf !== payload.asOf || shortlist.timeframe !== payload.timeframe) {
    throw new Error("Step 5 and step 6 use different market snapshots")
  }

  if (new Set(symbols).size !== symbols.length) {
    throw new Error("Step 6 agent payload contains duplicate symbols")
  }

  return { symbols, shortlistedCoins }
}

function getHistoryValue (field, chartPeriod, studyValue) {
  switch (field) {
    case "open":
      return normalizeNumber(chartPeriod.open)
    case "high":
      return normalizeNumber(chartPeriod.max)
    case "low":
      return normalizeNumber(chartPeriod.min)
    case "close":
      return normalizeNumber(chartPeriod.close)
    case "volume":
      return normalizeNumber(chartPeriod.volume)
    case "volumeDelta":
      return studyValue("volumeDelta", "close", chartPeriod.time)
    case "openInterest":
      return studyValue("openInterest", "close", chartPeriod.time)
    case "fundingRate":
      return studyValue("fundingRate", "rate", chartPeriod.time)
    case "longLiquidations":
      return studyValue("liquidations", "long", chartPeriod.time)
    case "shortLiquidations":
      return studyValue("liquidations", "short", chartPeriod.time)
    case "longShortRatioAccounts":
      return studyValue("longShortRatioAccounts", "ratio", chartPeriod.time)
    case "topTradersLong":
      return studyValue("topTradersLongShortPositions", "long", chartPeriod.time)
    case "topTradersShort":
      return studyValue("topTradersLongShortPositions", "short", chartPeriod.time)
    case "premium":
      return studyValue("premium", "close", chartPeriod.time)
    case "socialDominance":
      return studyValue("socialDominance", "percent", chartPeriod.time)
    case "interactions":
      return studyValue("interactions", "value", chartPeriod.time)
    case "activeContributors":
      return studyValue("activeContributors", "value", chartPeriod.time)
    case "createdPosts":
      return studyValue("createdPosts", "value", chartPeriod.time)
    default:
      throw new Error(`Unsupported coin history field: ${field}`)
  }
}

export function buildCoinHistory (
  hourlyData,
  { symbol, fields, hours, asOf },
) {
  if (hourlyData?.coin?.symbol !== symbol) {
    throw new Error(`Raw history does not belong to ${symbol}`)
  }

  if (hourlyData.timeframe !== "1h") {
    throw new Error(`${symbol} raw history does not use the 1h timeframe`)
  }

  const asOfTimestamp = Date.parse(asOf) / 1_000
  const chartPeriods = hourlyData?.chart?.periods

  if (!Number.isInteger(asOfTimestamp) || !Array.isArray(chartPeriods)) {
    throw new Error(`${symbol} raw history is incomplete`)
  }

  const selectedPeriods = chartPeriods
    .filter(period => Number.isFinite(period?.time) && period.time <= asOfTimestamp)
    .slice(-hours)

  if (
    selectedPeriods.length !== hours
    || selectedPeriods.at(-1)?.time !== asOfTimestamp
    || selectedPeriods.some((period, index) => (
      index > 0 && period.time !== selectedPeriods[index - 1].time + 3_600
    ))
  ) {
    throw new Error(`${symbol} raw history is not aligned with the agent payload`)
  }

  const studyPeriodsByKey = new Map()
  const studyValue = (key, field, time) => {
    if (!studyPeriodsByKey.has(key)) {
      const periods = hourlyData?.studies?.[key]?.periods

      studyPeriodsByKey.set(
        key,
        new Map(Array.isArray(periods)
          ? periods
              .filter(period => Number.isFinite(period?.time))
              .map(period => [period.time, period])
          : []),
      )
    }

    return normalizeNumber(studyPeriodsByKey.get(key).get(time)?.[field])
  }

  return {
    schemaVersion: 1,
    symbol,
    asOf,
    timeframe: "1h",
    schema: ["time", ...fields],
    rows: selectedPeriods.map(period => [
      period.time,
      ...fields.map(field => getHistoryValue(field, period, studyValue)),
    ]),
  }
}

function createToolFailure (message) {
  return {
    textResultForLlm: JSON.stringify({ error: message }),
    resultType: "failure",
    error: message,
  }
}

export function createCoinHistoryTool (
  payload,
  shortlist,
  { readCoinData = readTmpJson } = {},
) {
  const { symbols, shortlistedCoins } = validateAgentInputs(payload, shortlist)
  const coinBySymbol = new Map(shortlistedCoins.map(coin => [coin.symbol, coin]))
  const parameters = {
    type: "object",
    additionalProperties: false,
    required: ["symbol", "fields", "hours"],
    properties: {
      symbol: {
        type: "string",
        enum: symbols,
        description: "Тикер одной монеты из текущего списка кандидатов",
      },
      fields: {
        type: "array",
        minItems: 1,
        maxItems: 6,
        uniqueItems: true,
        items: {
          type: "string",
          enum: [
            "open",
            "high",
            "low",
            "close",
            "volume",
            "volumeDelta",
            "openInterest",
            "fundingRate",
            "longLiquidations",
            "shortLiquidations",
            "longShortRatioAccounts",
            "topTradersLong",
            "topTradersShort",
            "premium",
            "socialDominance",
            "interactions",
            "activeContributors",
            "createdPosts",
          ],
        },
        description: "От одного до шести сырых часовых рядов",
      },
      hours: {
        type: "integer",
        minimum: 12,
        maximum: 168,
        description: "Глубина истории от 12 до 168 завершённых часов",
      },
    },
  }
  const dataBySymbol = new Map()
  let callCount = 0

  return defineTool("get_coin_history", {
    description: "Возвращает выборочные сырые часовые ряды кандидата до текущего asOf. Используй только для уточнения неоднозначных или противоречивых компактных признаков.",
    parameters,
    skipPermission: true,
    defer: "never",
    handler: async (args) => {
      callCount += 1

      if (callCount > 5) {
        return createToolFailure("За один анализ разрешено не более пяти запросов истории")
      }

      try {
        if (!args || typeof args !== "object" || Array.isArray(args)) {
          throw new Error("Аргументы инструмента должны быть объектом")
        }

        const unknownKeys = Object.keys(args).filter(key => (
          !["symbol", "fields", "hours"].includes(key)
        ))

        if (unknownKeys.length > 0) {
          throw new Error(`Неизвестные аргументы: ${unknownKeys.join(", ")}`)
        }

        const { symbol, fields, hours } = args
        const allowedFields = parameters.properties.fields.items.enum

        if (!coinBySymbol.has(symbol)) {
          throw new Error(`Монета отсутствует в текущем списке кандидатов: ${symbol}`)
        }

        if (
          !Array.isArray(fields)
          || fields.length < 1
          || fields.length > 6
          || fields.some(field => !allowedFields.includes(field))
          || new Set(fields).size !== fields.length
        ) {
          throw new Error("Запрошен недопустимый набор рядов")
        }

        if (!Number.isInteger(hours) || hours < 12 || hours > 168) {
          throw new Error("Глубина истории должна быть целым числом от 12 до 168")
        }

        if (!dataBySymbol.has(symbol)) {
          dataBySymbol.set(
            symbol,
            await readCoinData(createBootstrapDataRelativePath(coinBySymbol.get(symbol))),
          )
        }

        const result = buildCoinHistory(dataBySymbol.get(symbol), {
          symbol,
          fields,
          hours,
          asOf: payload.asOf,
        })
        const serialized = JSON.stringify(result)

        if (Buffer.byteLength(serialized, "utf8") > 45_000) {
          throw new Error("Запрос истории слишком большой; сократи число часов или рядов")
        }

        return {
          textResultForLlm: serialized,
          resultType: "success",
        }
      } catch (error) {
        return createToolFailure(
          error instanceof Error ? error.message : "Не удалось прочитать историю",
        )
      }
    },
  })
}
