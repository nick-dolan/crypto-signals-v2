import assert from "node:assert/strict"
import test from "node:test"

import { mergePublicationEnrichment } from "../src/steps/candidate-enrichment/merge-publications.js"
import { addReportContext } from "../src/steps/step13-report/add-report-context.js"
import { enrichCandidatesWithContext } from "../src/steps/step8-context-enrichment/enrich-candidates-with-context.js"
import { decodeAgentPayload } from "../src/steps/step9-agent-payload/agent-payload-format.js"
import { buildAgentPayload } from "../src/steps/step9-agent-payload/build-agent-payload.js"

function createInputs (tweets = []) {
  const asOf = "2026-10-19T12:00:00.000Z"
  const window = { from: "2026-10-18T12:00:00.000Z", asOf, lookbackHours: 24 }
  const shortlist = {
    asOf, timeframe: "1h", candidateCount: 1,
    marketContext: { segmentShareChange6h: { btc: 0, eth: 0, alts: 0, stables: 0 }, stablecapChange6h: 0 },
    candidates: [{
      coin: { symbol: "TEST", name: "Test", rank: 5 },
      context: {
        atr24hPct: 0.02, marketCap: 1_000_000_000, volume24hUsd: 100_000_000,
        narrativeCategory: null, categoryStatus: "unavailable", socialStatus: "unavailable",
      },
      features: {
        volatilityCompression: {
          rv_24h_over_rv_7d: 1, bb_bandwidth_pct_30d: 0.5, atr_pct_90d: 0.5,
          range_compression_streak: 0, squeeze_age_hours: 0,
        },
        movementLifecycle: {
          prior_runup_atr_72h: 0, prior_drawdown_atr_72h: 0,
          max_24h_runup_last_7d_atr: 1, max_24h_drawdown_last_7d_atr: 1,
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
          oi_change_4h_z_30d: 0, oi_level_percentile_90d: 0.5,
          funding_rate: 0, funding_percentile_90d: 0.5, funding_minus_oi_z_4h: 0,
          premium_z_30d: 0, liq_imbalance_4h: 0, crowd_vs_top_traders: 0,
        },
        social: null,
        relativeStrength: {
          beta_btc_7d: 1, corr_btc_24h: 0.5, corr_btc_change_24h_vs_7d: 0,
          residual_log_return_4h: 0, residual_z_30d: 0, rs_vs_total3es_12h: 0,
        },
        breadthNarrative: { category_momentum_4h: null, category_breadth: null },
        divergences: {},
      },
    }],
  }

  return {
    shortlist,
    referenceTimestamp: Date.parse(asOf) / 1_000,
    news: {
      asOf, generatedAt: asOf,
      newsEnrichment: { ...window, source: "tradingview" },
      candidates: [{ symbol: "TEST", news: { status: "empty", error: null, items: [] } }],
    },
    twitter: {
      asOf, generatedAt: asOf,
      twitterEnrichment: { ...window, source: "twitterapi.io", maxPagesPerCandidate: 2 },
      candidates: [{
        symbol: "TEST",
        twitter: {
          query: "$TEST", status: "partial", error: "Twitter page 2 timed out",
          fetchedPageCount: 1, recentTweetCount: tweets.length, tweets,
        },
      }],
    },
    report: { asOf, coins: [{ symbol: "TEST" }] },
  }
}

test("partial Twitter retains page-one tweets through summarization, agent payload and report", async (t) => {
  const inputs = createInputs([{
    id: "tweet-1", text: "TEST запустил основную сеть.", createdAt: "2026-10-19T11:00:00.000Z",
    hoursAgo: 1, likeCount: 10, retweetCount: 2, viewCount: 100,
    authorUsername: "test", authorFollowers: 1_000,
  }])
  const sources = mergePublicationEnrichment(inputs.shortlist, inputs.news, inputs.twitter, inputs.referenceTimestamp)
  assert.deepEqual(sources.candidates[0].twitter, inputs.twitter.candidates[0].twitter)

  const callAgent = t.mock.fn(async (_prompt, message) => {
    const { symbol, twitter } = JSON.parse(message)
    assert.deepEqual(twitter, inputs.twitter.candidates[0].twitter)
    return JSON.stringify({
      schemaVersion: 4, symbol, newsSummary: null, twitterSummary: twitter.tweets[0].text,
      contextCaveat: "Вторая страница Twitter недоступна; выборка неполная.",
      socialSignificant: true, socialReason: "Проект сообщил о запуске основной сети.", socialSentiment: "bullish",
    })
  })
  const context = await enrichCandidatesWithContext(sources, "Summarize publications", { callAgent })
  assert.equal(callAgent.mock.callCount(), 1)
  assert.equal(context.contextEnrichment.candidateCallCount, 1)

  const payload = buildAgentPayload(inputs.shortlist, context)
  const { candidates: [agentCandidate] } = decodeAgentPayload(JSON.parse(JSON.stringify(payload)))
  const report = addReportContext(inputs.report, sources, context)
  for (const candidate of [context.candidates[0], agentCandidate, report.coins[0]]) {
    assert.equal(candidate.twitterStatus, "partial")
    assert.equal(candidate.twitterSummary, inputs.twitter.candidates[0].twitter.tweets[0].text)
    assert.equal(candidate.contextCaveat, context.candidates[0].contextCaveat)
  }
  assert.match(payload.definitions.twitterStatus, /partial/)
  assert.deepEqual(report.coins[0].information.twitter, inputs.twitter.candidates[0].twitter)
})

test("empty partial Twitter is unknown coverage, not confirmed absence of publications", async (t) => {
  const callAgent = t.mock.fn(async () => {
    throw new Error("Empty publications must not call the model")
  })
  for (const newsStatus of ["empty", "failed"]) {
    const inputs = createInputs()
    inputs.news.candidates[0].news.status = newsStatus
    const sources = mergePublicationEnrichment(inputs.shortlist, inputs.news, inputs.twitter, inputs.referenceTimestamp)
    const context = await enrichCandidatesWithContext(sources, "Summarize publications", { callAgent })
    const { candidates: [agentCandidate] } = decodeAgentPayload(buildAgentPayload(inputs.shortlist, context))
    const report = addReportContext(inputs.report, sources, context)

    assert.equal(context.contextEnrichment.candidateCallCount, 0)
    assert.match(context.candidates[0].contextCaveat, /Twitter.*второй страницы.*ошибк/u)
    assert.match(context.candidates[0].contextCaveat, /не подтверждено/u)
    assert.doesNotMatch(context.candidates[0].contextCaveat, /публикаций нет|публикации отсутствуют/u)
    for (const candidate of [context.candidates[0], agentCandidate, report.coins[0]]) {
      assert.equal(candidate.twitterStatus, "partial")
      assert.equal(candidate.newsSummary, null)
      assert.equal(candidate.twitterSummary, null)
      assert.equal(candidate.socialSignificant, null)
      assert.equal(candidate.socialSentiment, null)
      assert.equal(candidate.contextCaveat, context.candidates[0].contextCaveat)
    }
    assert.deepEqual(report.coins[0].information.twitter, inputs.twitter.candidates[0].twitter)
  }
  assert.equal(callAgent.mock.callCount(), 0)
})

test("partial remains invalid for news at every downstream validation boundary", async (t) => {
  const inputs = createInputs()
  const callAgent = t.mock.fn(async () => {
    throw new Error("Invalid or empty publications must not call the model")
  })
  const sources = mergePublicationEnrichment(inputs.shortlist, inputs.news, inputs.twitter, inputs.referenceTimestamp)
  const context = await enrichCandidatesWithContext(sources, "Summarize publications", { callAgent })
  sources.candidates[0].news.status = "partial"
  context.candidates[0].newsStatus = "partial"

  assert.throws(() => mergePublicationEnrichment(inputs.shortlist, sources, inputs.twitter, inputs.referenceTimestamp),
    /news candidate TEST publications are required/)
  await assert.rejects(enrichCandidatesWithContext(sources, "Summarize publications", { callAgent }),
    /TEST news status is invalid/)
  assert.throws(() => buildAgentPayload(inputs.shortlist, context), /TEST newsStatus is invalid/)
  assert.throws(() => addReportContext(inputs.report, sources, context),
    /TEST news must have an available, empty or failed status/)
  assert.equal(callAgent.mock.callCount(), 0)
})
