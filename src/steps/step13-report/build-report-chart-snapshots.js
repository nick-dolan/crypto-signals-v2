import { parallel } from "radash"

import { requestBinanceFuturesJson } from "../../api/binance/request.js"
import { isArray, isError, isFinite, isSafeInteger, isString } from "../../helpers/utils.typed.js"
import { createChartUpdater } from "../../web/chart-update.js"

function message (error) {
  return isError(error) ? error.message : String(error)
}

function marketSymbol (coin) {
  return isString(coin.marketSymbol) && /^BINANCE:([A-Z0-9]+USDT)\.P$/.exec(coin.marketSymbol)?.[1]
}

function readQuote (coin, quotes) {
  const quote = quotes.get(marketSymbol(coin))
  const price = isString(quote?.price) ? Number(quote.price) : quote?.price

  if (!isFinite(price) || price <= 0 || !isSafeInteger(quote?.time) || quote.time <= 0
    || !isFinite(new Date(quote.time).getTime())) {
    throw new Error(`Нет корректной котировки Binance для ${coin.marketSymbol}`)
  }

  return { price, at: new Date(quote.time).toISOString() }
}

export async function buildReportChartSnapshots (coins, asOf, {
  updateChartHistory = createChartUpdater({ isArray, isFinite, isSafeInteger, isString }),
  fetchQuotes = () => requestBinanceFuturesJson("/fapi/v2/ticker/price"),
} = {}) {
  if (!coins.length) {
    return []
  }

  const asOfTime = Date.parse(asOf) / 1_000
  const snapshots = await parallel(5, coins, async (coin) => {
    try {
      const result = await updateChartHistory(coin, asOf)
      const data = {
        ...result,
        history: {
          ...result.history,
          ...Object.fromEntries(["candles", "volume", "openInterest"].map(key => [
            key, result.history[key].filter(point => point.time > asOfTime && point.time <= asOfTime + 168 * 3_600),
          ])),
        },
      }
      return { ...coin, chartSnapshot: { data, quote: null, warning: null } }
    } catch (error) {
      return {
        ...coin,
        chartSnapshot: { data: null, quote: null, warning: `График при выпуске не обновлён: ${message(error)}` },
      }
    }
  })

  let quotes = new Map()
  let warning = null
  try {
    // Capture the last-trade prices after all chart continuations, as close to publication as possible.
    const rows = await fetchQuotes()
    if (!isArray(rows)) {
      throw new Error("Binance вернул некорректный список котировок")
    }
    quotes = new Map(rows.map(row => [row?.symbol, row]))
  } catch (error) {
    warning = `Цена при выпуске не получена: ${message(error)}`
  }

  return snapshots.map((coin) => {
    let quote = null
    let quoteWarning = warning
    if (!quoteWarning) {
      try {
        quote = readQuote(coin, quotes)
      } catch (error) {
        quoteWarning = message(error)
      }
    }
    return {
      ...coin,
      chartSnapshot: {
        ...coin.chartSnapshot,
        quote,
        warning: [coin.chartSnapshot.warning, quoteWarning].filter(Boolean).join(". ") || null,
      },
    }
  })
}
