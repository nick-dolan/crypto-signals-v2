export function createDemoReport () {
  const asOf = Date.parse("2026-10-01T09:00:00.000Z") / 1_000
  const closes = Array.from({ length: 72 }, (_, index) => (
    1.24 + Math.sin(index * 0.63) * 0.006 + Math.cos(index * 0.23) * 0.01
    + Math.max(0, index - 54) * 0.0032
  ))
  const candles = closes.map((close, index) => {
    const open = closes[index - 1] ?? close - 0.003
    return {
      time: asOf - (71 - index) * 3_600,
      open, close, high: Math.max(open, close) + 0.004, low: Math.min(open, close) - 0.004,
    }
  })
  return {
    demo: true,
    asOf: new Date(asOf * 1_000).toISOString(),
    timeframe: "1h",
    coins: [{
      symbol: "DEMO",
      name: "Демонстрационная монета",
      marketSymbol: "ПРИМЕР · USDT PERPETUAL",
      topRank: 1,
      movementProbability: 0.65,
      estimateConfidence: "medium",
      features: { relVolume: 2.8 },
      history: {
        candles,
        volume: candles.map(({ time }, index) => ({
          time, value: 180_000 + Math.abs(Math.sin(index * 0.71)) * 220_000 + Math.max(0, index - 54) * 48_000,
        })),
        openInterest: candles.map(({ time }, index) => ({
          time, value: 12_000_000 + Math.sin(index * 0.25) * 90_000 + Math.max(0, index - 44) * 47_000,
        })),
        warning: null,
      },
    }],
  }
}
