import { isError, isObject, isString } from "./utils.typed.js"

export function withErrorContext (error, context) {
  const failure = isError(error) ? error : new Error(String(error))
  failure.context = { ...context, ...(isObject(failure.context) ? failure.context : {}) }
  return failure
}

export function redactSecrets (text, env = process.env) {
  const secrets = Object.entries(env)
    .filter(([key, value]) => /token|secret|password|api.?key|authorization|cookie/iu.test(key) && isString(value) && value)
    .flatMap(([, value]) => [value, encodeURIComponent(value)])
    .sort((first, second) => second.length - first.length)
  const redacted = secrets.reduce((result, secret) => result.replaceAll(secret, "[redacted]"), String(text))

  return redacted
    .replace(/\b(?:bot)?\d{5,}(?::|%3a)[a-z\d_-]{20,}/giu, "[redacted]")
    .replace(/\b(?:gh[pousr]_[a-z\d_]+|github_pat_[a-z\d_]+|sk-[a-z\d_-]{16,})/giu, "[redacted]")
    .replace(/\beyJ[a-z\d_-]+\.[a-z\d_-]+\.[a-z\d_-]+\b/giu, "[redacted]")
    .replace(/\b(Bearer|Basic)\s+[^\s"'<>]+/giu, "$1 [redacted]")
    .replace(/(["']?(?:set-)?cookie["']?\s*[:=]\s*)\[(?:[^\]"']|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')*\]/giu, "$1[redacted]")
    .replace(/(["']?(?:set-)?cookie["']?\s*[:=]\s*)[^\r\n]*/giu, "$1[redacted]")
    .replace(/(["']?(?:[a-z_]*(?:token|secret|password)|api[_-]?key|authorization|(?:set-)?cookie)["']?\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s&,;}\]]+)/giu, "$1[redacted]")
}
