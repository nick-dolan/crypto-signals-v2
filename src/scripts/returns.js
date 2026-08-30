import { lag, mapSeries, ratioSeries } from "./series.js"

function returnRatios (source, offset) {
  return ratioSeries(source, lag(source, offset))
}

export function simpleReturns (source, offset = 1) {
  return mapSeries(returnRatios(source, offset), ratio => ratio - 1)
}

export function logReturns (source, offset = 1) {
  return mapSeries(returnRatios(source, offset), ratio => (
    ratio > 0 ? Math.log(ratio) : null
  ))
}
