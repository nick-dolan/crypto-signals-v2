import { isFinite } from "./utils.typed.js"

export function getClosedHourlyBoundary (referenceTime) {
  if (!isFinite(referenceTime)) {
    return null
  }

  const currentHourTime = Math.floor(referenceTime / 3_600) * 3_600

  return Object.freeze({
    requestTo: currentHourTime - 1,
    latestClosedTime: currentHourTime - 3_600,
  })
}
