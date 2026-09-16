export function createChartUpdater ({ isArray, isFinite, isSafeInteger, isString, fetch = globalThis.fetch }) {
  function invalidData (label) {
    return new Error(`Некорректные данные Binance: ${label}`)
  }

  function readNumber (value, label) {
    const number = isString(value) && value.trim() ? Number(value) : value

    if (!isFinite(number) || number < 0) {
      throw invalidData(label)
    }

    return number
  }

  function readTimestamp (value, label) {
    if (!isSafeInteger(value) || value <= 0 || !isFinite(new Date(value).getTime())) {
      throw invalidData(label)
    }

    return value
  }

  function readHour (value, label) {
    const timestamp = readTimestamp(value, label)

    if (timestamp % 3_600_000 !== 0) {
      throw invalidData(`${label}: время вне часовой сетки`)
    }

    return timestamp / 1_000
  }

  function responseError (endpoint, response, payload) {
    if (response.status === 429 || response.status === 418 || payload?.code === -1003) {
      return new Error(`Binance ${endpoint}: лимит запросов (HTTP ${response.status}). Повторите обновление позже`)
    }

    if (payload?.code === -1121) {
      return new Error(`Binance ${endpoint}: рынок не найден или недоступен`)
    }

    const status = response.ok ? `код ${payload.code}` : `HTTP ${response.status}`
    const details = isString(payload?.msg) ? `: ${payload.msg.slice(0, 200)}` : ""

    return new Error(`Binance ${endpoint}: ошибка ${status}${details}`)
  }

  async function request (endpoint, params = {}) {
    const url = new URL(endpoint, "https://fapi.binance.com")
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, String(value))
    }

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 15_000)

    try {
      let response
      try {
        response = await fetch(url, {
          method: "GET",
          credentials: "omit",
          signal: controller.signal,
        })
      } catch (error) {
        throw new Error(`Binance ${endpoint}: ошибка сети или CORS. Не удалось обновить график`, { cause: error })
      }

      let payload
      try {
        payload = await response.json()
      } catch {
        if (!response.ok) {
          throw responseError(endpoint, response, null)
        }
        throw invalidData(`${endpoint}: ответ не является JSON`)
      }

      if (!response.ok || (isFinite(payload?.code) && payload.code < 0)) {
        throw responseError(endpoint, response, payload)
      }

      return payload
    } catch (error) {
      if (controller.signal.aborted) {
        throw new Error(`Binance ${endpoint}: превышено время ожидания (15 секунд)`, { cause: error })
      }
      throw error
    } finally {
      clearTimeout(timeout)
    }
  }

  function readCandle (row) {
    if (!isArray(row) || row.length < 6) {
      throw invalidData("свечи: ожидался массив OHLCV")
    }

    const [open, high, low, close, volume] = row.slice(1, 6).map(value => readNumber(value, "OHLCV свечи"))

    if ([open, high, low, close].some(value => value <= 0)
      || low > Math.min(open, close) || high < Math.max(open, close)) {
      throw invalidData("свечи: нарушены границы OHLC")
    }

    return { time: readHour(row[0], "время свечи"), open, high, low, close, volume }
  }

  function readOi (row, symbol) {
    if (row?.symbol !== symbol) {
      throw invalidData("история OI: рынок не совпадает с запрошенным")
    }

    return {
      time: readHour(row.timestamp, "время истории OI"),
      value: readNumber(row.sumOpenInterest, "sumOpenInterest"),
    }
  }

  function readCurrentOi (payload, symbol, serverTime, warnings) {
    if (payload?.symbol !== symbol) {
      throw invalidData("текущий OI: рынок не совпадает с запрошенным")
    }

    const timestamp = readTimestamp(payload.time, "время текущего OI")

    if (payload.openInterest === null || (isString(payload.openInterest) && !payload.openInterest.trim())) {
      warnings.add("Текущий OI: Binance вернул пустое значение")
      return null
    }

    const value = readNumber(payload.openInterest, "текущий openInterest")
    const time = Math.floor(timestamp / 3_600_000) * 3_600

    if (time !== Math.floor(serverTime / 3_600_000) * 3_600) {
      warnings.add("Текущий OI: снимок относится к другому часу и не использован")
      return null
    }

    // The current request follows /time, so a small positive clock difference is normal.
    if (Math.abs(serverTime - timestamp) > 120_000) {
      warnings.add("Текущий OI: снимок устарел или его время ненадёжно; значение не использовано")
      return null
    }

    return { time, value, at: new Date(timestamp).toISOString() }
  }

  async function requestHours (endpoint, params, startTime, endTime, readPoint, warnings) {
    const byTime = new Map()

    // Page by requested hours, not response length: empty/partial pages must not hide later data.
    for (let cursor = startTime; cursor <= endTime; cursor += params.limit * 3_600_000) {
      const page = await request(endpoint, {
        ...params,
        startTime: cursor,
        endTime: Math.min(endTime, cursor + (params.limit - 1) * 3_600_000),
      })

      if (!isArray(page)) {
        throw invalidData(`${endpoint}: ожидался массив`)
      }

      for (const row of page) {
        const point = readPoint(row)
        if (point.time * 1_000 < startTime || point.time * 1_000 > endTime) {
          continue
        }
        if (byTime.has(point.time)) {
          warnings.add("Binance: дубликаты часов объединены, взята последняя запись")
        }
        byTime.set(point.time, point)
      }
    }

    return [...byTime.values()].sort((first, second) => first.time - second.time)
  }

  function mergeSeries (original, cached, asOf) {
    if (!isArray(original) || !isArray(cached)) {
      throw new Error("Некорректная исходная или сохранённая история графика")
    }

    return new Map([
      ...original.filter(point => point.time <= asOf),
      ...cached.filter(point => point.time > asOf),
    ].map(point => [point.time, { ...point }]))
  }

  function sortedPoints (byTime) {
    return [...byTime.values()].sort((first, second) => first.time - second.time)
  }

  return async function updateChartHistory (coin, asOf, previous = null) {
    const market = isString(coin?.marketSymbol) && /^BINANCE:([A-Z0-9]+USDT)\.P$/.exec(coin.marketSymbol)
    if (!market) {
      throw new Error("Некорректный рынок: требуется BINANCE:<symbol>USDT.P")
    }

    const asOfTime = isString(asOf) ? Date.parse(asOf) / 1_000 : NaN
    if (!isSafeInteger(asOfTime) || asOfTime <= 0 || asOfTime % 3_600 !== 0) {
      throw new Error("Некорректный asOf: требуется время открытия закрытой часовой свечи")
    }

    const candles = mergeSeries(coin.history?.candles, previous?.history?.candles ?? [], asOfTime)
    const volume = mergeSeries(coin.history?.volume, previous?.history?.volume ?? [], asOfTime)
    const openInterest = mergeSeries(coin.history?.openInterest, previous?.history?.openInterest ?? [], asOfTime)
    const warnings = new Set(isString(coin.history.warning) && coin.history.warning.trim() ? [coin.history.warning] : [])
    const serverTime = readTimestamp((await request("/fapi/v1/time"))?.serverTime, "время сервера")
    const serverHour = Math.floor(serverTime / 3_600_000) * 3_600

    if (asOfTime >= serverHour) {
      throw new Error("asOf ещё не является закрытым часом по времени Binance")
    }

    if (previous?.currentOiAt) {
      // A live OI observation must never survive as an unconfirmed hourly close.
      openInterest.delete(Math.floor(Date.parse(previous.currentOiAt) / 3_600_000) * 3_600)
    }

    let candleFrom = asOfTime + 3_600
    while (candleFrom < serverHour && candles.has(candleFrom) && candleFrom !== previous?.formingTime) {
      candleFrom += 3_600
    }

    const newCandles = await requestHours(
      "/fapi/v1/klines", { symbol: market[1], interval: "1h", limit: 1_000 },
      candleFrom * 1_000, serverTime, readCandle, warnings,
    )
    for (const { volume: value, ...candle } of newCandles) {
      candles.set(candle.time, candle)
      volume.set(candle.time, { time: candle.time, value })
    }

    const candlePoints = sortedPoints(candles)
    const sourceFrom = candlePoints.find(point => point.time > asOfTime)?.time
    if (sourceFrom == null) {
      throw new Error("Binance не вернул ни одной свечи после asOf. Исходный график не изменён")
    }

    if (previous?.formingTime != null && previous.formingTime < serverHour
      && !newCandles.some(point => point.time === previous.formingTime)) {
      throw new Error("Binance не подтвердил закрытие прежней формирующейся свечи. Повторите обновление позже")
    }

    const retentionHour = Math.ceil((serverTime - 30 * 24 * 3_600_000) / 3_600_000) * 3_600
    let oiFrom = Math.max(asOfTime + 3_600, retentionHour - 3_600)
    while (oiFrom < serverHour && isFinite(openInterest.get(oiFrom)?.value)) {
      oiFrom += 3_600
    }

    const newOi = await requestHours(
      "/futures/data/openInterestHist", { symbol: market[1], period: "1h", limit: 500 },
      (oiFrom + 3_600) * 1_000, serverHour * 1_000, row => readOi(row, market[1]), warnings,
    )
    for (const point of newOi) {
      openInterest.set(point.time - 3_600, { time: point.time - 3_600, value: point.value })
    }

    const current = readCurrentOi(
      await request("/fapi/v1/openInterest", { symbol: market[1] }), market[1], serverTime, warnings,
    )
    if (current) {
      openInterest.set(current.time, { time: current.time, value: current.value })
    }

    const liveTimes = Array.from(
      { length: (serverHour - asOfTime) / 3_600 }, (_, index) => asOfTime + (index + 1) * 3_600,
    )
    const missingClosedOi = liveTimes.filter(time => time < serverHour && !isFinite(openInterest.get(time)?.value))

    for (const time of liveTimes) {
      if (!volume.has(time)) {
        volume.set(time, { time })
      }
      if (!openInterest.has(time)) {
        openInterest.set(time, { time })
      }
    }

    if (!coin.history.candles.length) {
      warnings.add("Исходная история TradingView отсутствует; показано продолжение Binance")
    }
    if (liveTimes.some(time => time < serverHour && !candles.has(time))) {
      warnings.add("Свечи Binance: есть пропущенные закрытые часы; данные не выдумывались")
    }
    if (!newCandles.some(point => point.time === serverHour)) {
      warnings.add("Текущая свеча Binance не получена; ранее загруженные свечи сохранены")
    }

    if (missingClosedOi.some(time => time + 3_600 < retentionHour)) {
      warnings.add("OI: Binance хранит только последние 30 дней; более ранние пропуски не восстановлены")
    }
    if (missingClosedOi.length) {
      warnings.add("OI: пропущенные закрытые часы оставлены без значений")
    }
    if (missingClosedOi.includes(serverHour - 3_600)) {
      warnings.add("OI: нет снимка для последнего закрытого часа")
    }

    return {
      history: {
        candles: candlePoints,
        volume: sortedPoints(volume),
        openInterest: sortedPoints(openInterest),
        warning: [...warnings].join(". ") || null,
      },
      updatedAt: new Date(serverTime).toISOString(),
      formingTime: candles.has(serverHour) ? serverHour : null,
      currentOiAt: current?.at ?? null,
      sourceFrom,
      oiSourceFrom: [previous?.oiSourceFrom, newOi[0]?.time - 3_600, current?.time]
        .filter(isSafeInteger).sort((first, second) => first - second)[0] ?? null,
    }
  }
}
