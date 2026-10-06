import { isBoolean, isString } from "./utils.typed.js"

export function readSocialSignal ({ socialSignificant, socialReason, socialSentiment }) {
  if ([socialSignificant, socialReason, socialSentiment].every(value => value === undefined)) {
    return { socialSignificant: null, socialReason: null, socialSentiment: null }
  }

  if (socialSignificant !== null && !isBoolean(socialSignificant)) {
    throw new Error("socialSignificant must be true, false or null")
  }

  if (
    !(socialSignificant === null && socialReason === null)
    && (!isString(socialReason) || !socialReason.trim())
  ) {
    throw new Error("socialReason must be a non-empty string, or null for an unknown signal")
  }

  if (socialSentiment === null
    ? socialSignificant === true
    : socialSignificant === null || !["bullish", "bearish", "positive", "negative", "mixed", "neutral"].includes(socialSentiment)) {
    throw new Error("socialSentiment must be bullish, bearish, mixed or neutral; unknown significance requires null sentiment")
  }

  return {
    socialSignificant,
    socialReason: socialReason === null ? null : socialReason.trim(),
    socialSentiment,
  }
}
