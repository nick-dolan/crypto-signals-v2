import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test, { beforeEach } from "node:test"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"

import { parseCandidateEnrichmentArgs } from "../src/candidate-enrichment.js"
import { runNewsEnrichmentStep } from "../src/step6-news-enrichment.js"
import { runTwitterEnrichmentStep } from "../src/step7-twitter-enrichment.js"
import { runContextEnrichmentStep } from "../src/step8-context-enrichment.js"
import { runPatternEnrichmentStep } from "../src/step8.1-pattern-enrichment.js"
import { createTwitterInput, mergePublicationEnrichment } from "../src/steps/candidate-enrichment/merge-publications.js"
import { runCandidateEnrichment } from "../src/steps/candidate-enrichment/run-candidate-enrichment.js"
import { enrichCandidatesWithNews } from "../src/steps/step6-news-enrichment/enrich-candidates-with-news.js"
import { enrichCandidatesWithTwitter } from "../src/steps/step7-twitter-enrichment/enrich-candidates-with-twitter.js"
import { enrichCandidatesWithContext } from "../src/steps/step8-context-enrichment/enrich-candidates-with-context.js"
import { InvalidContextEnrichmentError } from "../src/steps/step8-context-enrichment/parse-context-enrichment.js"
import { enrichCandidatesWithPatterns } from "../src/steps/step8.1-pattern-enrichment/enrich-candidates-with-patterns.js"
import { buildAgentPayload } from "../src/steps/step9-agent-payload/build-agent-payload.js"

beforeEach((context) => {
  for (const method of ["log", "warn", "error"]) {
    context.mock.method(console, method, () => {})
  }
})

function createShortlist (symbols = ["SOL", "BTC"]) {
  return {
    asOf: "2026-10-09T13:00:00.000Z",
    timeframe: "1h",
    candidateCount: symbols.length,
    marketContext: { segmentRotation: { btc: 0, eth: 0, alts: 0 }, stablecapChange: 0 },
    candidates: symbols.map((symbol, index) => ({ coin: {
      symbol, name: `Coin ${symbol}`, rank: index + 1, baseCurrencyId: `XTVC${symbol}`,
      tradingViewSymbol: `CRYPTO:${symbol}USD`, marketSymbol: `BINANCE:${symbol}USDT.P`,
    } })),
  }
}

function createPrepared (input) {
  return {
    schemaVersion: 1,
    asOf: input.asOf,
    timeframe: "1h",
    from: new Date(Date.parse(input.asOf) - 167 * 3_600_000).toISOString(),
    to: new Date(Date.parse(input.asOf) + 3_600_000).toISOString(),
    directory: "candidate-enrichment-test",
    candidateCount: input.candidates.length,
    candidates: input.candidates.map(({ coin }) => ({
      ...coin,
      directory: coin.symbol,
      files: { data: `memory/${coin.symbol}/data.json` },
      views: [168, 48].map(hours => ({
        name: `view-${hours}.png`, file: `memory/${coin.symbol}/${hours}.png`, hours,
        from: new Date(Date.parse(input.asOf) - (hours - 1) * 3_600_000).toISOString(),
        to: new Date(Date.parse(input.asOf) + 3_600_000).toISOString(),
        coverage: { candles: hours, volume: hours },
      })),
      coverage: { candles: 168, volume: 168 },
      ready: true,
      caveat: null,
    })),
  }
}

function agentResponse (message, settings) {
  const candidate = JSON.parse(message)
  return JSON.stringify(settings.attachments
    ? { symbol: candidate.symbol, summary: `Pattern ${candidate.symbol}`, caveat: null }
    : {
        schemaVersion: 4, symbol: candidate.symbol,
        newsSummary: candidate.news.items.length ? `News ${candidate.symbol}` : null,
        twitterSummary: candidate.twitter.tweets.length ? `Twitter ${candidate.symbol}` : null,
        contextCaveat: null, socialSignificant: false,
        socialReason: "В выборке нет существенного события.", socialSentiment: "neutral",
      })
}

function createReplay (shortlist = createShortlist()) {
  const artifacts = new Map()
  const removed = []
  const events = []
  return {
    shortlist, artifacts, removed, events,
    options: {
      referenceTimestamp: 1_800_000_000,
      readJson: async (filename) => {
        assert.equal(filename, "step5-preliminary-filter.json")
        events.push("shortlist")
        return shortlist
      },
      writeJson: async (filename, value) => {
        events.push(filename)
        artifacts.set(filename, structuredClone(value))
        return `memory/${filename}`
      },
      removeJson: async filename => removed.push(filename),
      readPrompt: async filename => filename,
      preparePatterns: async input => createPrepared(input),
      fetchNews: async ({ symbol }) => ({ items: [{
        id: `news-${symbol}`, title: `Update ${symbol}`, published: 1_800_000_000,
        publishedAt: new Date(1_800_000_000_000).toISOString(),
        tradingViewUrl: `https://example.test/${symbol}`, externalUrl: null,
        matchedSymbols: [symbol], relatedSymbols: [],
      }] }),
      fetchStory: async ({ id }) => ({
        content: `Content ${id}`, contentStatus: "full", contentParserVersion: 1,
        contentFetchedAt: "2027-01-15T08:01:00.000Z", contentError: null,
      }),
      fetchPage: async query => ({ tweets: [{
        id: query.split(" ")[0], text: query.split(" ")[0],
        createdAt: new Date(1_800_000_000_000).toISOString(),
      }] }),
      wait: async () => {},
      callAgent: async (_, message, settings) => agentResponse(message, settings),
    },
  }
}

function withoutGeneratedAt (value) {
  return JSON.parse(JSON.stringify(value, (key, item) => key === "generatedAt" ? undefined : item))
}

function addPayloadFeatures (shortlist) {
  for (const candidate of shortlist.candidates) {
    candidate.context = {
      atr24hPct: 0.01, marketCap: 1_000_000_000, volume24hUsd: 1_000_000,
      socialStatus: "unavailable", narrativeCategory: null, categoryStatus: "not_applicable",
    }
    candidate.features = {
      volatilityCompression: {
        rv_24h_over_rv_7d: 1, bb_bandwidth_pct_30d: 0.5, atr_pct_90d: 0.5,
        range_compression_streak: 0, squeeze_age_hours: 0,
      },
      movementLifecycle: {
        prior_runup_atr_72h: 0, prior_drawdown_atr_72h: 0,
        max_24h_runup_last_7d_atr: 0, max_24h_drawdown_last_7d_atr: 0,
        range_position_7d: 0.5, distance_to_previous_high_atr: 1, distance_to_previous_low_atr: 1,
        pre_breakout_squeeze_age: null, squeeze_ended_hours_ago: null, breakout_age_hours: null,
        post_breakout_extension_atr: null, extension_from_base_atr: null,
      },
      volumeOrderFlow: {
        volume_z_30d: 0, volume_acceleration_3h: 0, rel_volume_at_time: 1,
        vd_net_4h_over_volume: 0, cvd_minus_price_z_12h: 0,
      },
      derivatives: {
        oi_change_1h: 0, oi_change_4h: 0, oi_change_12h: 0, oi_acceleration_4h: 0,
        oi_change_4h_z_30d: 0, oi_level_percentile_90d: 0.5, funding_rate: 0,
        funding_percentile_90d: 0.5, funding_minus_oi_z_4h: 0, premium_z_30d: 0,
        liq_imbalance_4h: 0, crowd_vs_top_traders: 0,
      },
      social: null,
      relativeStrength: {
        beta_btc_7d: 1, corr_btc_24h: 0.5, corr_btc_change_24h_vs_7d: 0,
        residual_log_return_4h: 0, residual_z_30d: 0, rs_vs_total3es_12h: 0,
      },
      breadthNarrative: { category_momentum_4h: null, category_breadth: null },
      divergences: {},
    }
  }
}

for (const concurrency of [undefined, 9]) {
  test(`news, Twitter and patterns start independently; both internal-10 workers share a ${concurrency ?? 10} ceiling`, { timeout: 10_000 }, async (t) => {
    const replay = createReplay(createShortlist(Array.from({ length: 24 }, (_, index) => `COIN${index}`)))
    const publications = Promise.withResolvers()
    const newsStarted = Promise.withResolvers()
    const twitterStarted = Promise.withResolvers()
    const firstPatternBatch = Promise.withResolvers()
    const contextPrepared = Promise.withResolvers()
    const mixedBatch = Promise.withResolvers()
    const contextGate = Promise.withResolvers()
    const patternGates = []
    const ceiling = concurrency ?? 10
    let released = false
    let active = 0
    let maximum = 0
    let patternCalls = 0
    let contextCalls = 0
    const sources = { news: 0, twitter: 0 }
    const maximumSources = { news: 0, twitter: 0 }
    const waits = []
    t.after(() => {
      released = true
      publications.resolve()
      patternGates.forEach(gate => gate.resolve())
      contextGate.resolve()
    })
    const pending = runCandidateEnrichment({
      ...replay.options,
      ...(concurrency === undefined ? {} : { concurrency }),
      fetchNews: async (...args) => {
        sources.news += 1
        maximumSources.news = Math.max(maximumSources.news, sources.news)
        newsStarted.resolve()
        await publications.promise
        sources.news -= 1
        return replay.options.fetchNews(...args)
      },
      fetchPage: async (...args) => {
        sources.twitter += 1
        maximumSources.twitter = Math.max(maximumSources.twitter, sources.twitter)
        twitterStarted.resolve()
        await publications.promise
        sources.twitter -= 1
        return replay.options.fetchPage(...args)
      },
      wait: async milliseconds => waits.push(milliseconds),
      readPrompt: async (filename) => {
        if (filename.includes("context")) {
          contextPrepared.resolve()
        }
        return filename
      },
      callAgent: async (_, message, settings) => {
        active += 1
        maximum = Math.max(maximum, active)
        try {
          if (settings.attachments) {
            patternCalls += 1
            const gate = Promise.withResolvers()
            patternGates.push(gate)
            if (patternCalls === ceiling) {
              firstPatternBatch.resolve()
            }
            if (!released) {
              await gate.promise
            }
          } else {
            contextCalls += 1
            if (contextCalls === 2) {
              mixedBatch.resolve()
            }
            await contextGate.promise
          }
          return agentResponse(message, settings)
        } finally {
          active -= 1
        }
      },
    })
    const completion = Promise.allSettled([pending])
    try {
      await Promise.all([newsStarted.promise, twitterStarted.promise, firstPatternBatch.promise])
      assert.equal(contextCalls, 0)
      assert.equal(patternCalls, ceiling)
      assert.equal(replay.artifacts.has("step7-twitter-enrichment.json"), false)
      assert.deepEqual(maximumSources, { news: 5, twitter: 1 })
      publications.resolve()
      await contextPrepared.promise
      // One extra pattern is already queued at ceiling 9; FIFO admits it before context.
      patternGates.slice(0, ceiling === 9 ? 3 : 2).forEach(gate => gate.resolve())
      await mixedBatch.promise
      assert.equal(active, ceiling)
      assert.equal(maximum, ceiling)
      assert.ok(patternCalls > 0 && contextCalls > 0)
    } finally {
      released = true
      publications.resolve()
      patternGates.forEach(gate => gate.resolve())
      contextGate.resolve()
    }
    const [result] = await completion
    assert.equal(result.status, "fulfilled")
    assert.equal(patternCalls, 24)
    assert.equal(contextCalls, 24)
    assert.equal(maximum, ceiling)
    assert.equal(active, 0)
    assert.deepEqual(waits, Array(23).fill(300))
    assert.equal(result.value.context.candidates.length, 24)
  })
}

test("combined artifacts, key order, context and downstream payload equal serial steps except generatedAt", async () => {
  const shortlist = createShortlist()
  addPayloadFeatures(shortlist)
  const before = structuredClone(shortlist)
  const replay = createReplay(shortlist)
  const serial = createReplay(shortlist)
  const options = serial.options
  const news = await runNewsEnrichmentStep({
    readJson: options.readJson, writeJson: options.writeJson,
    enrich: input => enrichCandidatesWithNews(input, options),
  })
  const twitter = await runTwitterEnrichmentStep({
    readJson: async () => news, writeJson: options.writeJson, enrichmentOptions: options,
  })
  const context = await runContextEnrichmentStep({
    readJson: async () => twitter, readPrompt: () => options.readPrompt("candidate-context-enrichment.md"),
    writeJson: options.writeJson,
    enrich: (input, prompt) => enrichCandidatesWithContext(input, prompt, options),
  })
  const patterns = await runPatternEnrichmentStep({
    readJson: options.readJson, removeJson: options.removeJson,
    readPrompt: () => options.readPrompt("candidate-pattern-enrichment.md"),
    prepare: options.preparePatterns, writeJson: options.writeJson,
    enrich: (input, prompt) => enrichCandidatesWithPatterns(input, prompt, options),
  })
  const combined = await runCandidateEnrichment(replay.options)
  assert.deepEqual(withoutGeneratedAt(combined), withoutGeneratedAt({ news, twitter, context, patterns }))
  for (const [filename, value] of serial.artifacts) {
    assert.equal(JSON.stringify(withoutGeneratedAt(replay.artifacts.get(filename))), JSON.stringify(withoutGeneratedAt(value)), filename)
  }
  assert.deepEqual(buildAgentPayload(shortlist, combined.context, combined.patterns), buildAgentPayload(shortlist, context, patterns))
  assert.deepEqual(shortlist, before)
  assert.deepEqual(replay.removed, ["step8.1-pattern-enrichment.json"])
  assert.equal(replay.events.filter(event => event === "shortlist").length, 1)
  assert.ok(replay.events.indexOf("step6-news-enrichment.json") < replay.events.indexOf("step7-twitter-enrichment.json"))
})

test("joins by symbol, not by array position, and rejects stale, missing, extra and duplicate identities", async (t) => {
  const replay = createReplay()
  const news = await enrichCandidatesWithNews(replay.shortlist, replay.options)
  const twitter = await enrichCandidatesWithTwitter(createTwitterInput(replay.shortlist), replay.options)
  const shuffled = structuredClone(twitter)
  shuffled.candidates.reverse()
  const merged = mergePublicationEnrichment(replay.shortlist, news, shuffled, replay.options.referenceTimestamp)
  assert.deepEqual(merged.candidates.map(candidate => candidate.twitter.tweets[0].id), ["$SOL", "$BTC"])
  for (const source of ["news", "twitter"]) {
    for (const [name, mutate, error] of [
      ["missing", output => output.candidates.pop(), /candidate sets must match/],
      ["extra", output => output.candidates.push({ ...output.candidates[0], symbol: "EXTRA" }), /candidate sets must match/],
      ["replacement", output => output.candidates[0].symbol = "EXTRA", /candidate sets must match/],
      ["duplicate", output => output.candidates[1].symbol = output.candidates[0].symbol.toLowerCase(), /duplicate symbol/],
      ["stale snapshot", output => output.asOf = "2026-10-09T12:00:00.000Z", /market snapshots must match/],
      ["stale end", output => output[`${source}Enrichment`].asOf = replay.shortlist.asOf, /publication window/],
      ["stale start", output => output[`${source}Enrichment`].from = replay.shortlist.asOf, /publication window/],
      ["wrong lookback", output => output[`${source}Enrichment`].lookbackHours = 48, /publication window/],
    ]) {
      await t.test(`${source}: ${name}`, async () => {
        const corrupted = structuredClone(source === "news" ? news : twitter)
        mutate(corrupted)
        assert.throws(() => mergePublicationEnrichment(replay.shortlist,
          source === "news" ? corrupted : news, source === "twitter" ? corrupted : twitter,
          replay.options.referenceTimestamp), error)
        const run = createReplay()
        await assert.rejects(runCandidateEnrichment({
          ...run.options,
          ...(source === "news" ? { enrichNews: async () => corrupted } : { enrichTwitter: async () => corrupted }),
        }), error)
        assert.equal(run.artifacts.has("step7-twitter-enrichment.json"), false)
        assert.equal(run.artifacts.has("step8-context-enrichment.json"), false)
      })
    }
  }
  const duplicate = createShortlist(["SOL", "sol"])
  assert.throws(() => createTwitterInput(duplicate), /duplicate symbol SOL/)
})

for (const startedAt of ["1800000000", "", "invalid", "0", "-1", "1.5", "9007199254740991"]) {
  test(`captures one publication snapshot at entry with PIPELINE_STARTED_AT=${JSON.stringify(startedAt)}`, async (t) => {
    const previous = process.env.PIPELINE_STARTED_AT
    process.env.PIPELINE_STARTED_AT = startedAt
    t.after(() => {
      if (previous === undefined) {
        delete process.env.PIPELINE_STARTED_AT
      } else {
        process.env.PIPELINE_STARTED_AT = previous
      }
    })
    let now = 1_800_001_020_000
    const clock = t.mock.method(Date, "now", () => now)
    const replay = createReplay()
    delete replay.options.referenceTimestamp
    const observed = []
    const output = await runCandidateEnrichment({
      ...replay.options,
      readJson: async (filename) => {
        now += 3_600_000
        return replay.options.readJson(filename)
      },
      enrichNews: (input, options) => {
        observed.push(options.referenceTimestamp)
        return enrichCandidatesWithNews(input, options)
      },
      enrichTwitter: (input, options) => {
        observed.push(options.referenceTimestamp)
        return enrichCandidatesWithTwitter(input, options)
      },
    })
    const expected = startedAt === "1800000000" ? 1_800_000_000 : 1_800_001_020
    assert.deepEqual(observed, [expected, expected])
    assert.equal(clock.mock.callCount(), startedAt === "1800000000" ? 0 : 1)
    assert.equal(output.news.newsEnrichment.asOf, new Date(expected * 1_000).toISOString())
    assert.equal(output.twitter.twitterEnrichment.asOf, output.news.newsEnrichment.asOf)
    assert.notEqual(output.twitter.twitterEnrichment.asOf, replay.shortlist.asOf)
  })
}

test("empty, failed and not-ready candidates consume no LLM slots and retain zero versus unknown semantics", async () => {
  const replay = createReplay(createShortlist(["EMPTY", "FAILED"]))
  let calls = 0
  const output = await runCandidateEnrichment({
    ...replay.options,
    fetchNews: async ({ symbol }) => {
      if (symbol.includes("FAILED")) {
        throw new Error("News offline")
      }
      return { items: [] }
    },
    fetchPage: async (query) => {
      if (query.startsWith("$FAILED ")) {
        throw new Error("Twitter offline")
      }
      return { tweets: [] }
    },
    preparePatterns: async (input) => {
      const prepared = createPrepared(input)
      prepared.candidates.forEach(candidate => candidate.ready = false)
      return prepared
    },
    callAgent: async () => {
      calls += 1
      assert.fail("Skipped candidates must not call LLM")
    },
  })
  assert.equal(calls, 0)
  assert.equal(output.news.candidates[0].news.recentItemCount, 0)
  assert.equal(output.news.candidates[1].news.recentItemCount, null)
  assert.equal(output.twitter.candidates[0].twitter.recentTweetCount, 0)
  assert.equal(output.twitter.candidates[1].twitter.recentTweetCount, null)
  assert.ok(output.context.candidates.every(candidate => candidate.socialSignificant === null && candidate.socialSentiment === null))
  assert.ok(output.patterns.candidates.every(candidate => candidate.status === "unavailable"))
  assert.equal(output.context.contextEnrichment.candidateCallCount, 0)
  assert.equal(output.patterns.patternEnrichment.candidateCallCount, 0)
})

for (const kind of ["agent error", "invalid response"]) {
  test(`fatal context ${kind} cancels queued LLM calls immediately and drains both workers`, { timeout: 10_000 }, async (t) => {
    const replay = createReplay(createShortlist(Array.from({ length: 24 }, (_, index) => `COIN${index}`)))
    const initialPatterns = Promise.withResolvers()
    const contextReady = Promise.withResolvers()
    const contextsStarted = Promise.withResolvers()
    const triggerFailure = Promise.withResolvers()
    const otherContext = Promise.withResolvers()
    const cancelled = Promise.withResolvers()
    const patternGates = []
    const expected = new Error("Original context error")
    let patternCalls = 0
    let contextCalls = 0
    let active = 0
    let completed = false
    t.after(() => {
      triggerFailure.resolve()
      otherContext.resolve()
      patternGates.forEach(gate => gate.resolve())
    })
    const pending = runCandidateEnrichment({
      ...replay.options,
      readPrompt: async (filename) => {
        if (filename.includes("context")) {
          contextReady.resolve()
        }
        return filename
      },
      writeJson: async (filename, value) => {
        if (filename.endsWith("/analysis.json") && value.status === "unavailable") {
          cancelled.resolve()
        }
        return replay.options.writeJson(filename, value)
      },
      callAgent: async (_, message, settings) => {
        active += 1
        try {
          if (settings.attachments) {
            patternCalls += 1
            const gate = Promise.withResolvers()
            patternGates.push(gate)
            if (patternCalls === 10) {
              initialPatterns.resolve()
            }
            await gate.promise
          } else {
            contextCalls += 1
            const first = contextCalls === 1
            if (contextCalls === 2) {
              contextsStarted.resolve()
            }
            if (first) {
              await triggerFailure.promise
              if (kind === "agent error") {
                throw expected
              }
              return "not JSON"
            }
            await otherContext.promise
          }
          return agentResponse(message, settings)
        } finally {
          active -= 1
        }
      },
    })
    const completion = assert.rejects(pending, error => kind === "agent error"
      ? error === expected
      : error instanceof InvalidContextEnrichmentError && error.response === "not JSON").then(() => {
      completed = true
    })
    try {
      await Promise.all([initialPatterns.promise, contextReady.promise])
      patternGates.slice(0, 2).forEach(gate => gate.resolve())
      await contextsStarted.promise
      triggerFailure.resolve()
      await cancelled.promise
      assert.equal(patternCalls, 10)
      assert.equal(contextCalls, 2)
      assert.equal(completed, false)
      assert.equal(active, 9)
    } finally {
      triggerFailure.resolve()
      patternGates.forEach(gate => gate.resolve())
      otherContext.resolve()
    }
    await completion
    assert.equal(active, 0)
    assert.equal(patternCalls, 10)
    assert.equal(contextCalls, 2)
    assert.equal(replay.artifacts.has("step8-context-enrichment.json"), false)
    if (kind === "invalid response") {
      const diagnostic = replay.artifacts.get("step8-context-enrichment.invalid.json")
      assert.equal(diagnostic.response, "not JSON")
      assert.match(diagnostic.error, /not valid JSON/)
    }
  })
}

for (const stage of ["news", "twitter", "prepare", "pattern write"]) {
  test(`mandatory ${stage} failure preserves the original error and drains active APIs, including a detached call`, { timeout: 10_000 }, async (t) => {
    const replay = createReplay(createShortlist(["SOL", "BTC", "ETH"]))
    const newsStarted = Promise.withResolvers()
    const twitterStarted = Promise.withResolvers()
    const patternStarted = Promise.withResolvers()
    const failNow = Promise.withResolvers()
    const apiGate = Promise.withResolvers()
    const patternGate = Promise.withResolvers()
    const expected = new Error(`${stage} failed`)
    let active = 0
    let finished = false
    let detached
    t.after(() => {
      failNow.resolve()
      apiGate.resolve()
      patternGate.resolve()
    })
    const options = {
      ...replay.options,
      fetchNews: async (...args) => {
        active += 1
        newsStarted.resolve()
        try {
          await apiGate.promise
          return await replay.options.fetchNews(...args)
        } finally {
          active -= 1
        }
      },
      fetchPage: async (...args) => {
        active += 1
        twitterStarted.resolve()
        try {
          await apiGate.promise
          return await replay.options.fetchPage(...args)
        } finally {
          active -= 1
        }
      },
      callAgent: async (_, message, settings) => {
        if (settings.attachments) {
          active += 1
          patternStarted.resolve()
          await (stage === "pattern write" ? failNow.promise : patternGate.promise)
          active -= 1
        }
        return agentResponse(message, settings)
      },
    }
    if (stage === "news" || stage === "twitter") {
      options[stage === "news" ? "enrichNews" : "enrichTwitter"] = async (_, dependencies) => {
        detached = stage === "news"
          ? dependencies.fetchNews({ symbol: "CRYPTO:SOLUSD" })
          : dependencies.fetchPage("$SOL")
        await failNow.promise
        throw expected
      }
    }
    if (stage === "prepare") {
      options.preparePatterns = async () => {
        patternStarted.resolve()
        await failNow.promise
        throw expected
      }
    }
    if (stage === "pattern write") {
      options.writeJson = async (filename, value) => {
        if (filename.endsWith("/analysis.json")) {
          throw expected
        }
        return replay.options.writeJson(filename, value)
      }
    }
    const completion = assert.rejects(runCandidateEnrichment(options), error => error === expected).then(() => {
      finished = true
    })
    try {
      await Promise.all([newsStarted.promise, twitterStarted.promise, patternStarted.promise])
      failNow.resolve()
      // The detached API and the other fetch branch remain active after the fatal branch exits.
      await new Promise(resolve => setImmediate(resolve))
      assert.equal(finished, false)
      assert.ok(active > 0)
    } finally {
      failNow.resolve()
      apiGate.resolve()
      patternGate.resolve()
    }
    await completion
    await detached
    assert.equal(active, 0)
    assert.equal(finished, true)
    assert.equal(replay.artifacts.has("step7-twitter-enrichment.json"), false)
  })
}

test("ordinary pattern failures retain diagnostics, analysis files and final manifest without failing context", async () => {
  const replay = createReplay()
  const output = await runCandidateEnrichment({
    ...replay.options,
    callAgent: async (_, message, settings) => {
      if (settings.attachments) {
        if (JSON.parse(message).symbol === "SOL") {
          return "invalid pattern"
        }
        throw new Error("Pattern API offline")
      }
      return agentResponse(message, settings)
    },
  })
  assert.equal(output.context.candidates.length, 2)
  assert.ok(output.patterns.candidates.every(candidate => candidate.status === "unavailable"))
  assert.equal(replay.artifacts.get("candidate-enrichment-test/SOL/analysis.invalid.json").response, "invalid pattern")
  assert.equal(replay.artifacts.has("candidate-enrichment-test/BTC/analysis.invalid.json"), false)
  const manifest = replay.artifacts.get("candidate-enrichment-test/manifest.json")
  assert.deepEqual(manifest.patternEnrichment, output.patterns.patternEnrichment)
  for (const candidate of manifest.candidates) {
    assert.equal(candidate.ready, true)
    assert.equal(candidate.views.length, 2)
    assert.deepEqual(replay.artifacts.get(`candidate-enrichment-test/${candidate.symbol}/analysis.json`),
      output.patterns.candidates.find(result => result.symbol === candidate.symbol))
  }
})

for (const filename of ["step6-news-enrichment.json", "step7-twitter-enrichment.json", "step8-context-enrichment.json", "candidate-enrichment-test/manifest.json", "step8.1-pattern-enrichment.json"]) {
  test(`fatal artifact write ${filename} does not replace its original error`, async () => {
    const replay = createReplay()
    const expected = new Error(`Cannot write ${filename}`)
    await assert.rejects(runCandidateEnrichment({
      ...replay.options,
      writeJson: async (name, value) => {
        if (name === filename) {
          throw expected
        }
        return replay.options.writeJson(name, value)
      },
    }), error => error === expected)
    assert.equal(replay.artifacts.has(filename), false)
    if (filename.endsWith("manifest.json")) {
      assert.equal(replay.artifacts.has("step8.1-pattern-enrichment.json"), false)
    }
  })
}

test("a failed diagnostic write still propagates the original invalid context response", async () => {
  const replay = createReplay()
  await assert.rejects(runCandidateEnrichment({
    ...replay.options,
    callAgent: async (_, message, settings) => settings.attachments ? agentResponse(message, settings) : "invalid context",
    writeJson: async (filename, value) => {
      if (filename === "step8-context-enrichment.invalid.json") {
        throw new Error("Diagnostic disk error")
      }
      return replay.options.writeJson(filename, value)
    },
  }), error => error instanceof InvalidContextEnrichmentError && error.response === "invalid context")
})

test("empty combined shortlists preserve both normal root reports and the manifest without LLM calls", async () => {
  const replay = createReplay(createShortlist([]))
  const output = await runCandidateEnrichment({
    ...replay.options,
    callAgent: async () => assert.fail("Empty candidates must not call LLM"),
  })
  assert.deepEqual(output.twitter.candidates, [])
  assert.deepEqual(output.context.candidates, [])
  assert.deepEqual(output.patterns.candidates, [])
  assert.equal(replay.artifacts.get("candidate-enrichment-test/manifest.json").candidateCount, 0)
})

test("validates concurrency and timestamp before reading or starting any branch", async () => {
  const replay = createReplay()
  for (const concurrency of [0, -1, 1.5, "9", null]) {
    await assert.rejects(runCandidateEnrichment({ ...replay.options, concurrency }), /positive integer/)
  }
  for (const concurrency of [11, 20, Number.MAX_SAFE_INTEGER]) {
    await assert.rejects(runCandidateEnrichment({ ...replay.options, concurrency }), /must not exceed 10/)
  }
  for (const referenceTimestamp of [0, -1, 1.5, "1800000000", Infinity, Number.MAX_SAFE_INTEGER]) {
    await assert.rejects(runCandidateEnrichment({ ...replay.options, referenceTimestamp }), /positive Unix timestamp/)
  }
  assert.deepEqual(replay.events, [])
  assert.deepEqual(parseCandidateEnrichmentArgs([]), { concurrency: 10 })
  assert.deepEqual(parseCandidateEnrichmentArgs(["--concurrency", "9"]), { concurrency: 9 })
  for (const args of [["--concurrency", "0"], ["--concurrency", "11"], ["--concurrency", "1.5"], ["--concurrency"], ["--unknown"]]) {
    assert.throws(() => parseCandidateEnrichmentArgs(args))
  }
})

async function runOfflineChild (t, code) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "candidate-enrichment-import-"))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  return promisify(execFile)(process.execPath, ["--input-type=module", "--eval", `
    import assert from "node:assert/strict"
    import fs from "node:fs/promises"
    import { mock } from "node:test"
    import dotenv from ${JSON.stringify(import.meta.resolve("dotenv"))}
    import { CopilotClient } from ${JSON.stringify(import.meta.resolve("@github/copilot-sdk"))}
    dotenv.config = () => ({ parsed: {} })
    const fetch = mock.method(globalThis, "fetch", async () => assert.fail("Network forbidden"))
    const start = mock.method(CopilotClient.prototype, "start", async () => assert.fail("SDK forbidden"))
    const read = mock.method(fs, "readFile", async () => assert.fail("No step or prompt reads expected"))
    const remove = mock.method(fs, "rm", async () => assert.fail("No artifact removal expected"))
    ${code}
    assert.equal(fetch.mock.callCount(), 0)
    assert.equal(start.mock.callCount(), 0)
    assert.equal(read.mock.callCount(), 0)
    assert.equal(remove.mock.callCount(), 0)
  `], { cwd: directory, timeout: 10_000, env: { DOTENV_CONFIG_PATH: "/dev/null", TWITTERAPI_IO_KEY: "" } })
}

test("importing all standalone scripts and the combined child has no auto-run side effects", async (t) => {
  const modules = ["candidate-enrichment.js", "step6-news-enrichment.js", "step7-twitter-enrichment.js", "step8-context-enrichment.js", "step8.1-pattern-enrichment.js"]
  await runOfflineChild(t, `
    for (const url of ${JSON.stringify(modules.map(name => new URL("../src/" + name, import.meta.url).href))}) {
      await import(url)
    }
    assert.equal(process.exitCode, undefined)
  `)
})

test("combined real default calls retain Twitter key validation before any source, prompt or tmp access", async (t) => {
  const url = new URL("../src/candidate-enrichment.js", import.meta.url)
  await runOfflineChild(t, `
    process.argv = [process.execPath, ${JSON.stringify(fileURLToPath(url))}]
    const errors = []
    mock.method(console, "error", (...args) => errors.push(args.join(" ")))
    await import(${JSON.stringify(url.href)})
    assert.equal(process.exitCode, 1)
    assert.match(errors.join("\\n"), /TWITTERAPI_IO_KEY is not set in .env/)
    process.exitCode = 0
  `)
})

test("combined real local preparation preserves data, PNGs, analysis and manifest in an isolated tmp", { timeout: 20_000 }, async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "candidate-enrichment-artifacts-"))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  const input = createShortlist(["SOL"])
  await fs.mkdir(path.join(directory, "tmp", "step2-data-bootstrap", "SOL--XTVCSOL"), { recursive: true })
  await fs.writeFile(path.join(directory, "tmp", "step5-preliminary-filter.json"), JSON.stringify(input))
  await fs.writeFile(path.join(directory, "tmp", "step8.1-pattern-enrichment.json"), JSON.stringify({ stale: true }))
  await fs.writeFile(path.join(directory, "tmp", "unrelated.json"), JSON.stringify({ untouched: true }))
  await fs.writeFile(path.join(directory, "tmp", "step2-data-bootstrap", "SOL--XTVCSOL", "data.json"), JSON.stringify({
    coin: input.candidates[0].coin,
    timeframe: "1h",
    chart: {
      info: { fullName: input.candidates[0].coin.marketSymbol },
      periods: Array.from({ length: 200 }, (_, index) => ({
        time: Date.parse(input.asOf) / 1_000 - (198 - index) * 3_600,
        open: 100 + index, max: 102 + index, min: 99 + index, close: 101 + index, volume: 1_000 + index,
      })).reverse(),
    },
  }))
  await promisify(execFile)(process.execPath, ["--input-type=module", "--eval", `
    import assert from "node:assert/strict"
    import { mock } from "node:test"
    import dotenv from ${JSON.stringify(import.meta.resolve("dotenv"))}
    import { CopilotClient } from ${JSON.stringify(import.meta.resolve("@github/copilot-sdk"))}
    dotenv.config = () => ({ parsed: {} })
    const fetch = mock.method(globalThis, "fetch", async () => assert.fail("Network forbidden"))
    const start = mock.method(CopilotClient.prototype, "start", async () => assert.fail("SDK forbidden"))
    const { runCandidateEnrichment } = await import(${JSON.stringify(new URL("../src/steps/candidate-enrichment/run-candidate-enrichment.js", import.meta.url).href)})
    const calls = []
    await runCandidateEnrichment({
      concurrency: 9,
      referenceTimestamp: 1800000000,
      fetchNews: async () => ({ items: [] }),
      fetchStory: async () => assert.fail("No stories expected"),
      fetchPage: async () => ({ tweets: [] }),
      callAgent: async (_, message, settings) => {
        assert.equal(settings.attachments.length, 2)
        calls.push(JSON.parse(message).symbol)
        return JSON.stringify({ symbol: "SOL", summary: "No clear pattern.", caveat: null })
      },
    })
    assert.deepEqual(calls, ["SOL"])
    assert.equal(fetch.mock.callCount(), 0)
    assert.equal(start.mock.callCount(), 0)
  `], { cwd: directory, timeout: 10_000, env: { DOTENV_CONFIG_PATH: "/dev/null", TWITTERAPI_IO_KEY: "" } })
  const read = filename => fs.readFile(path.join(directory, "tmp", filename), "utf8").then(JSON.parse)
  const report = await read("step8.1-pattern-enrichment.json")
  const manifest = await read("step8.1-pattern-data/manifest.json")
  const candidate = manifest.candidates[0]
  assert.equal(manifest.generatedAt, report.generatedAt)
  assert.deepEqual(manifest.patternEnrichment, report.patternEnrichment)
  assert.equal(candidate.status, "available")
  assert.equal(candidate.summary, "No clear pattern.")
  const data = await read(`step8.1-pattern-data/${candidate.directory}/data.json`)
  assert.equal(data.asOf, input.asOf)
  assert.equal(data.candles.length, 168)
  assert.deepEqual(await read(`step8.1-pattern-data/${candidate.directory}/analysis.json`), report.candidates[0])
  for (const file of [candidate.files.svg, candidate.files.recentSvg]) {
    const svg = await fs.readFile(path.join(directory, file), "utf8")
    assert.match(svg, /width="1400" height="800"/)
  }
  for (const file of [candidate.files.png, candidate.files.recentPng]) {
    const png = await fs.readFile(path.join(directory, file))
    assert.equal(png.toString("hex", 0, 8), "89504e470d0a1a0a")
  }
  assert.equal((await read("step6-news-enrichment.json")).candidates[0].news.status, "empty")
  assert.equal((await read("step7-twitter-enrichment.json")).candidates[0].twitter.status, "empty")
  assert.equal((await read("step8-context-enrichment.json")).candidates[0].socialSentiment, null)
  assert.deepEqual(await read("unrelated.json"), { untouched: true })
})
