import fs from "node:fs/promises"
import path from "node:path"
import { performance } from "node:perf_hooks"
import { pathToFileURL } from "node:url"
import { parseArgs } from "node:util"

import { callModel, getModelSettings } from "../helpers/model-helper.js"
import { isArray, isBoolean, isError, isSafeInteger, isString } from "../helpers/utils.typed.js"
import { enrichCandidatesWithContext } from "../steps/step8-context-enrichment/enrich-candidates-with-context.js"
import { InvalidContextEnrichmentError } from "../steps/step8-context-enrichment/parse-context-enrichment.js"
import { enrichCandidatesWithPatterns } from "../steps/step8.1-pattern-enrichment/enrich-candidates-with-patterns.js"

function errorDetails (error) {
  return {
    name: isError(error) ? error.name : "Error",
    message: (isString(error?.message) ? error.message : String(error))
      .replace(/(bearer\s+)[^\s"']+/gi, "$1[redacted]")
      .replace(/\b(?:gh[pousr]_\w+|github_pat_\w+|sk-[\w-]+|eyJ[\w-]+\.[\w-]+\.[\w-]+)\b/g, "[redacted]")
      .replace(/((?:authorization|token|api[_-]?key|secret|password)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}]+)/gi, "$1[redacted]"),
    ...(error?.symbol ? { symbol: error.symbol } : {}),
    ...(isString(error?.code) ? { code: error.code } : {}),
    ...(isSafeInteger(error?.status) ? { status: error.status } : {}),
  }
}

async function writeJson (file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8")
  return file
}

function hasPublications (candidate) {
  return candidate.news.items.length > 0 || candidate.twitter.tweets.length > 0
}

async function prepareInput (root, resultDirectory, phase, count) {
  const [context, pattern, systemPrompt] = await Promise.all([
    fs.readFile(path.join(root, "inputs", "step7-twitter-enrichment.json"), "utf8").then(JSON.parse),
    fs.readFile(path.join(root, "inputs", "pattern-data", "manifest.json"), "utf8").then(JSON.parse),
    fs.readFile(path.join(root, "inputs", `candidate-${phase}-enrichment.md`), "utf8"),
  ])
  if (!isArray(context?.candidates) || !isArray(pattern?.candidates)) {
    throw new Error("Frozen context and pattern candidates are required")
  }
  if (!isString(context.asOf) || !context.asOf.trim() || context.asOf !== pattern.asOf) {
    throw new Error("Frozen context and pattern asOf must match")
  }

  const patternsBySymbol = new Map(pattern.candidates.map(candidate => [candidate.symbol, candidate]))
  const contextCandidates = count === undefined
    ? context.candidates
    : context.candidates.filter(candidate => (
        hasPublications(candidate) && patternsBySymbol.get(candidate.symbol)?.ready === true
      )).slice(0, count)
  if (count !== undefined && contextCandidates.length !== count) {
    throw new Error(`Requested ${count} common candidates; only ${contextCandidates.length} have publications and ready patterns`)
  }
  if (phase === "context") {
    return { input: { ...context, candidates: contextCandidates }, systemPrompt }
  }

  const candidates = (count === undefined
    ? pattern.candidates
    : contextCandidates.map(candidate => patternsBySymbol.get(candidate.symbol))).map((candidate) => {
    if (!isString(candidate.directory) || !candidate.directory
      || candidate.directory !== path.basename(candidate.directory) || [".", ".."].includes(candidate.directory)) {
      throw new Error(`Unsafe pattern directory for ${candidate.symbol}`)
    }
    if (!isBoolean(candidate.ready) || !isArray(candidate.views) || (candidate.ready && !candidate.views.length)) {
      throw new Error(`Pattern readiness and views are required for ${candidate.symbol}`)
    }
    return {
      ...candidate,
      views: candidate.views.map(view => ({
        ...view,
        file: path.join(root, "inputs", "pattern-data", candidate.directory, path.basename(view.file)),
      })),
    }
  })
  await Promise.all(candidates.filter(candidate => candidate.ready).flatMap(candidate => (
    candidate.views.map(view => fs.access(view.file))
  )))
  return {
    input: { ...pattern, directory: resultDirectory, candidateCount: candidates.length, candidates },
    systemPrompt,
  }
}

export async function runMiniAgentBenchmark ({ directory, phase, concurrency, count } = {}) {
  if (!isString(directory) || !directory.trim()) {
    throw new Error("--directory is required")
  }
  if (!["context", "pattern"].includes(phase)) {
    throw new Error("--phase must be context or pattern")
  }
  if (![2, 4, 6, 8, 10].includes(concurrency)) {
    throw new Error("--concurrency must be 2, 4, 6, 8 or 10")
  }
  if (count !== undefined && (!isSafeInteger(count) || count < 1)) {
    throw new Error("--count must be a positive safe integer")
  }

  const root = path.resolve(directory)
  const resultDirectory = await fs.mkdtemp(path.join(root, `${phase}-c${concurrency}-`))
  const metrics = {
    phase, concurrency, requestedCount: count ?? null, count: 0, callCount: 0, expectedCallCount: 0,
    asOf: null, models: {}, symbols: [], startedAt: null, wallTimeMs: 0, maxActive: 0,
    apiErrors: [], unavailablePatterns: [], invalidResponses: [], error: null, perCallTimings: [],
    success: false,
  }
  const patternResults = new Map()
  let input, output, phaseStarted
  let active = 0

  const callAgent = async (systemPrompt, userMessage, settings) => {
    const started = performance.now()
    const timing = {
      symbol: JSON.parse(userMessage).symbol,
      model: settings.model,
      startOffsetMs: started - phaseStarted,
      durationMs: null,
      status: "pending",
      apiError: null,
    }
    metrics.perCallTimings.push(timing)
    metrics.maxActive = Math.max(metrics.maxActive, ++active)
    try {
      const response = await callModel(systemPrompt, userMessage, settings)
      timing.status = "returned"
      return response
    } catch (error) {
      const details = { ...errorDetails(error), symbol: timing.symbol }
      timing.status = "api-error"
      timing.apiError = details
      metrics.apiErrors.push(details)
      throw Object.assign(new Error(details.message), details)
    } finally {
      timing.durationMs = performance.now() - started
      active--
    }
  }

  try {
    const prepared = await prepareInput(root, resultDirectory, phase, count)
    input = prepared.input
    metrics.asOf = input.asOf
    metrics.count = input.candidates.length
    metrics.symbols = input.candidates.map(candidate => candidate.symbol)
    metrics.expectedCallCount = input.candidates.filter(phase === "context"
      ? hasPublications
      : candidate => candidate.ready).length
    const task = phase === "context" ? "candidateContext" : "candidatePattern"
    metrics.models[task] = getModelSettings(task)
    metrics.startedAt = new Date().toISOString()
    phaseStarted = performance.now()
    try {
      output = phase === "context"
        ? await enrichCandidatesWithContext(input, prepared.systemPrompt, { callAgent, concurrency })
        : await enrichCandidatesWithPatterns(input, prepared.systemPrompt, {
            callAgent,
            concurrency,
            writeJson: async (file, value) => {
              if (path.basename(file) === "analysis.invalid.json") {
                metrics.invalidResponses.push({
                  symbol: input.candidates.find(candidate => candidate.directory === path.basename(path.dirname(file)))?.symbol ?? null,
                  message: errorDetails(new Error(value.error)).message,
                  file: path.relative(resultDirectory, file),
                })
              } else if (path.basename(file) === "analysis.json") {
                patternResults.set(value.symbol, value)
              }
              return writeJson(file, value)
            },
          })
    } finally {
      metrics.wallTimeMs = performance.now() - phaseStarted
    }
    await writeJson(path.join(resultDirectory, "result.json"), output)
  } catch (error) {
    metrics.error = errorDetails(error)
    if (error instanceof InvalidContextEnrichmentError) {
      metrics.invalidResponses.push({
        symbol: error.symbol ?? null,
        message: metrics.error.message,
        file: "context.invalid.json",
      })
      try {
        await writeJson(path.join(resultDirectory, "context.invalid.json"), {
          message: metrics.error.message, symbol: error.symbol ?? null, response: error.response ?? null,
        })
      } catch (diagnosticError) {
        metrics.diagnosticError = errorDetails(diagnosticError)
      }
    }
  }

  metrics.unavailablePatterns = [...patternResults.values()].filter(candidate => candidate.status === "unavailable").map(candidate => ({
    symbol: candidate.symbol,
    caveat: candidate.caveat,
    expected: input.candidates.find(original => original.symbol === candidate.symbol)?.ready === false,
  }))
  const invalidSymbols = new Set(metrics.invalidResponses.map(response => response.symbol))
  for (const timing of metrics.perCallTimings) {
    if (!timing.apiError) {
      if (invalidSymbols.has(timing.symbol)) {
        timing.status = "invalid-response"
      } else if (patternResults.get(timing.symbol)?.status === "unavailable") {
        timing.status = "unavailable"
      } else if ((phase === "context" && output) || patternResults.get(timing.symbol)?.status === "available") {
        timing.status = "ok"
      }
    }
  }
  metrics.callCount = metrics.perCallTimings.length
  metrics.validCallCount = metrics.perCallTimings.filter(timing => timing.status === "ok").length
  metrics.apiErrorCount = metrics.apiErrors.length
  metrics.invalidResponseCount = metrics.invalidResponses.length
  metrics.unavailablePatternCount = metrics.unavailablePatterns.length
  metrics.unexpectedUnavailablePatternCount = metrics.unavailablePatterns.filter(candidate => !candidate.expected).length
  metrics.throughput = {
    callsPerSecond: metrics.wallTimeMs ? metrics.callCount * 1_000 / metrics.wallTimeMs : 0,
    validResultsPerSecond: metrics.wallTimeMs ? metrics.validCallCount * 1_000 / metrics.wallTimeMs : 0,
  }
  metrics.success = Boolean(output) && !metrics.error && !metrics.apiErrorCount && !metrics.invalidResponseCount
    && !metrics.unexpectedUnavailablePatternCount && metrics.callCount === metrics.expectedCallCount
    && metrics.validCallCount === metrics.expectedCallCount && metrics.maxActive <= concurrency
  await writeJson(path.join(resultDirectory, "metrics.json"), metrics)
  return { resultDirectory, metrics }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { values } = parseArgs({ options: {
      directory: { type: "string" },
      phase: { type: "string" },
      concurrency: { type: "string" },
      count: { type: "string" },
    } })
    const { resultDirectory, metrics } = await runMiniAgentBenchmark({
      directory: values.directory,
      phase: values.phase,
      concurrency: Number(values.concurrency),
      count: values.count === undefined ? undefined : Number(values.count),
    })
    console.log(
      `${metrics.success ? "OK" : "FAIL"} ${metrics.phase} c=${metrics.concurrency}`
      + ` | count=${metrics.count} calls=${metrics.callCount}/${metrics.expectedCallCount}`
      + ` | ${(metrics.wallTimeMs / 1_000).toFixed(2)}s ${metrics.throughput.validResultsPerSecond.toFixed(2)} valid/s`
      + ` | maxActive=${metrics.maxActive} APIerrors=${metrics.apiErrorCount}`
      + ` invalid=${metrics.invalidResponseCount} unexpectedUnavailable=${metrics.unexpectedUnavailablePatternCount}`
      + ` phaseError=${Boolean(metrics.error)}`,
    )
    console.log(`Results: ${resultDirectory}`)
    if (!metrics.success) {
      process.exitCode = 1
    }
  } catch (error) {
    console.error("Mini-agent benchmark failed:", errorDetails(error).message)
    process.exitCode = 1
  }
}
