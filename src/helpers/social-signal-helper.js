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
    && (!isString(socialReason) || !socialReason.trim() || socialReason.length > 300)
  ) {
    throw new Error("socialReason must be a short non-empty string, or null for an unknown signal")
  }

  if (socialSignificant === true
    ? !["positive", "negative", "mixed", "neutral"].includes(socialSentiment)
    : socialSentiment !== null) {
    throw new Error("socialSentiment must be positive, negative, mixed or neutral for a significant signal, and null otherwise")
  }

  return {
    socialSignificant,
    socialReason: socialReason === null ? null : socialReason.trim(),
    socialSentiment,
  }
}
