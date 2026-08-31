export function getClosedHourlyBoundary (referenceTime) {
  if (!Number.isFinite(referenceTime)) {
    return null
  }

  const currentHourTime = Math.floor(referenceTime / 3_600) * 3_600

  return Object.freeze({
    requestTo: currentHourTime - 1,
    latestClosedTime: currentHourTime - 3_600,
  })
}
