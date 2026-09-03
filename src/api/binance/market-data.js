import { requestBinanceFuturesJson } from "./request.js"

export function fetchBinanceServerTime () {
  return requestBinanceFuturesJson("/fapi/v1/time")
}

export function fetchBinanceExchangeInfo () {
  return requestBinanceFuturesJson("/fapi/v1/exchangeInfo")
}

export function fetchBinanceMarkPriceKlines ({
  symbol,
  interval,
  startTime,
  endTime,
  limit,
}) {
  return requestBinanceFuturesJson("/fapi/v1/markPriceKlines", {
    searchParams: { symbol, interval, startTime, endTime, limit },
  })
}

export function fetchBinanceKlines ({
  symbol,
  interval,
  startTime,
  endTime,
  limit,
}) {
  return requestBinanceFuturesJson("/fapi/v1/klines", {
    searchParams: { symbol, interval, startTime, endTime, limit },
  })
}

export function fetchBinanceOpenInterestHistory ({
  symbol,
  period,
  startTime,
  endTime,
  limit,
}) {
  return requestBinanceFuturesJson("/futures/data/openInterestHist", {
    searchParams: { symbol, period, startTime, endTime, limit },
  })
}
