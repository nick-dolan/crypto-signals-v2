import { token_sort_ratio as titleSimilarity } from "fuzzball"

import { isArray } from "../../helpers/utils.typed.js"
import { sourceString, sourceUrlKey } from "./source-normalization.js"

function comparisonText (source) {
  const text = sourceString(source.channel === "twitter" ? source.text : source.title)

  if (!text || (source.channel === "twitter" && (text.length > 500 || /^\[(?:Partial|Truncated)/.test(text)))) {
    return null
  }

  const normalized = text.normalize("NFKC").toLowerCase().replace(/[’‘]/g, "'")
  const tokens = normalized.match(/[\p{L}\p{N}]+(?:'[\p{L}]+)*/gu) ?? []
  const significant = tokens.filter(token => !["a", "an", "the"].includes(token))

  return {
    text: tokens.join(" "),
    significant: [...significant].sort().join(" "),
    ordered: significant.join(" "),
    articleSymbols: (text.normalize("NFKC").match(/\b(?:A|AN|THE)\b/g) ?? []).sort().join(" "),
    numbers: (normalized.match(/[+−-]?\d+(?:[.,:/-]\d+)*/gu) ?? []).join(" "),
    symbols: (normalized.match(/[\p{Sc}%+−<>=?]/gu) ?? []).join(""),
  }
}

function canFuzzyMerge (first, second) {
  if ((first.channel === "twitter") !== (second.channel === "twitter")) {
    return false
  }

  const left = comparisonText(first)
  const right = comparisonText(second)

  if (!left?.significant || !right?.significant) {
    return false
  }

  // All non-article words must survive unchanged: do not guess names, numbers, status or synonyms.
  if (
    left.significant !== right.significant
    || left.numbers !== right.numbers
    || left.symbols !== right.symbols
    || left.articleSymbols !== right.articleSymbols
  ) {
    return false
  }

  // Allow a leading phrase to move to the end, not arbitrary subject/predicate swaps.
  if (!` ${left.ordered} ${left.ordered} `.includes(` ${right.ordered} `)) {
    return false
  }

  // Reordering a negation can change which entity or assertion it applies to.
  if (/\b(?:no|not|never|neither|nor|without|only|\w+n't)\b/.test(left.text) && left.ordered !== right.ordered) {
    return false
  }

  return titleSimilarity(left.text, right.text, { full_process: false, force_ascii: false }) >= 95
}

function textQuality (source) {
  const text = sourceString(source.text)

  if (!text || text.startsWith("[Headline only]")) {
    return 0
  }

  if (text.startsWith("[Snippet only]")) {
    return 1
  }

  return /^\[(?:Partial|Truncated)/.test(text) ? 2 : 3
}

function bestRepresentative (sources) {
  return sources.reduce((best, source) => (
    textQuality(source) > textQuality(best)
    || (textQuality(source) === textQuality(best) && sourceString(source.text).length > sourceString(best.text).length)
      ? source
      : best
  ))
}

export function deduplicateMarketSources (sources) {
  if (!isArray(sources)) {
    throw new Error("Market brief sources must be an array")
  }

  const byUrl = new Map()
  const exactGroups = []

  for (const source of sources) {
    const key = sourceUrlKey(source.url)
    const existing = key ? byUrl.get(key) : null

    if (existing) {
      existing.push(source)
    } else {
      const group = [source]
      exactGroups.push(group)

      if (key) {
        byUrl.set(key, group)
      }
    }
  }

  const groups = []

  for (const sources of exactGroups) {
    // Complete-link matching avoids fuzzy chains and respects updates sharing one URL.
    const group = groups.find(group => group.every(first => sources.every(second => canFuzzyMerge(first, second))))

    if (group) {
      group.push(...sources)
    } else {
      groups.push([...sources])
    }
  }

  return groups.map((sources, index) => {
    const representative = bestRepresentative(sources)

    return {
      id: `group-${index + 1}`,
      title: representative.title,
      text: representative.text,
      sourceIds: [...new Set(sources.map(source => source.id))],
    }
  })
}
