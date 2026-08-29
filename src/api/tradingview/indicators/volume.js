import { defineIndicator } from "./definition.js"

export const VOLUME_INDICATOR_DEFINITIONS = Object.freeze([
  defineIndicator("volume", {
    key: "volumeDelta",
    id: "STD;Volume%1Delta",
    version: "8.0",
    name: "Volume Delta",
    fields: {
      high: "plotcandle_0_ohlc_high",
      low: "plotcandle_0_ohlc_low",
      close: "plotcandle_0_ohlc_close",
    },
  }),
])
