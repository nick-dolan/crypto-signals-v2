import { readTmpJson } from "../../helpers/fs-helper.js"
import { isArray, isError, isFinite, isObject, isSafeInteger, isString } from "../../helpers/utils.typed.js"
import { createBootstrapDataRelativePath } from "../step2-data-bootstrap/check-coin-data-coverage.js"

function isText (value) {
  return isString(value) && value.trim().length > 0
}

function verifyBootstrapMarket (source, coin, timeframe) {
  if (
    !isObject(source) || !isObject(source.coin) || !isObject(source.chart)
    || !isArray(source.chart.periods)
    || (source.chart.info != null && !isObject(source.chart.info))
  ) {
    throw new Error("некорректный формат сохранённых данных шага 2")
  }
  if (timeframe !== "1h" || source.timeframe !== timeframe) {
    throw new Error("сохранённые данные не соответствуют часовому таймфрейму отчёта")
  }
  if (source.coin.baseCurrencyId !== coin.baseCurrencyId || source.coin.symbol !== coin.symbol) {
    throw new Error("ID или символ монеты в файле шага 2 не совпадает с отчётом")
  }

  const { marketSymbol } = source.coin
  const info = source.chart.info
  if (!isText(marketSymbol)) {
    throw new Error("в файле шага 2 не указан рынок монеты")
  }
  if (coin.marketSymbol !== null && marketSymbol !== coin.marketSymbol) {
    throw new Error("рынок монеты в файле шага 2 не совпадает с отчётом")
  }
  if (
    (info?.fullName != null && info.fullName !== marketSymbol)
    || (info?.baseCurrencyId != null && info.baseCurrencyId !== coin.baseCurrencyId)
  ) {
    throw new Error("метаданные графика не совпадают с монетой или рынком файла шага 2")
  }

  return marketSymbol
}

function buildClosePoints (periods, { asOf, snapshotClosedAt }) {
  const latestOpenTime = Date.parse(asOf) / 1_000
  const latestCloseTime = Date.parse(snapshotClosedAt) / 1_000
  if (
    !isSafeInteger(latestOpenTime) || latestOpenTime % 3_600 !== 0
    || latestCloseTime !== latestOpenTime + 3_600
  ) {
    throw new Error("время среза отчёта не соответствует часовой сетке")
  }

  const closes = new Map()
  for (const period of periods) {
    if (!isObject(period) || !isSafeInteger(period.time) || period.time % 3_600 !== 0) {
      throw new Error("некорректная временная метка свечи или смещение относительно часовой сетки")
    }
    if (closes.has(period.time)) {
      throw new Error("повторяющиеся временные метки свечей в файле шага 2")
    }
    closes.set(period.time, period.close)
  }

  return Array.from({ length: 169 }, (_, index) => {
    const time = latestCloseTime - (168 - index) * 3_600
    const value = closes.get(time - 3_600)
    return isFinite(value) && value > 0 ? { time, value } : { time }
  })
}

async function loadHistory (references, data, readCoinData) {
  const { baseCurrencyId, symbol } = references[0]
  const markets = [...new Set(references.map(coin => coin.marketSymbol).filter(isText))]
  const history = {
    baseCurrencyId,
    symbol,
    marketSymbol: markets.length === 1 ? markets[0] : null,
    points: [],
    warning: null,
  }

  try {
    if (new Set(references.map(coin => coin.symbol)).size !== 1 || markets.length > 1) {
      throw new Error("противоречивые символы или рынки для одного ID в отчёте")
    }
    const source = await readCoinData(createBootstrapDataRelativePath({ symbol, baseCurrencyId }))
    history.marketSymbol = verifyBootstrapMarket(source, history, data.timeframe)
    history.points = buildClosePoints(source.chart.periods, data)
    const missingCount = history.points.filter(point => !("value" in point)).length
    if (missingCount) {
      history.warning = `История ${symbol} неполная: отсутствуют положительные цены закрытия для ${missingCount} из 169 часов; пропуски не заполнены.`
    }
  } catch (error) {
    history.warning = `История ${symbol} недоступна: ${isError(error) ? error.message : "не удалось прочитать сохранённые данные шага 2"}.`
  }

  return [baseCurrencyId, history]
}

export async function buildPeerRadarHistories (data, { readCoinData = readTmpJson } = {}) {
  const coins = new Map()
  for (const { coin, leaders } of data.observations) {
    for (const reference of [coin, ...leaders]) {
      if (!coins.has(reference.baseCurrencyId)) {
        coins.set(reference.baseCurrencyId, [])
      }
      coins.get(reference.baseCurrencyId).push(reference)
    }
  }

  return Object.fromEntries(await Promise.all(
    [...coins.values()].map(references => loadHistory(references, data, readCoinData)),
  ))
}
