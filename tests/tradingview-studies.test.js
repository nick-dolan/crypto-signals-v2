import assert from "node:assert/strict"
import test from "node:test"

import { Emitter } from "@mathieuc/tradingview"

import { createTradingViewStudyFetcher } from "../src/api/tradingview/studies/study.js"

test("v4 study values preserve application periods, aliases and missing-hour coverage", async (t) => {
  const indicator = {}
  const metadata = { name: "Active posts", plots: { plot_0: "Active_posts" } }
  const request = {
    key: "activePosts",
    id: "STD;CryptoFund_posts_active",
    version: "7.0",
    inputs: {},
    fields: { value: "Active_posts" },
    allowMissingValues: true,
  }
  const study = Object.assign(new Emitter(), {
    values: [{ $time: 0, Active_posts: 5 }, { $time: 3_600, Active_posts: 0 }],
    remove: t.mock.fn(),
  })
  const chart = {
    createStudy: t.mock.fn(() => {
      queueMicrotask(() => {
        study.emit("ready")
        study.emit("update", ["plots"])
        study.values = [...study.values, { $time: 10_800, Active_posts: 1e100 }]
        study.emit("update", ["plots"])
      })
      return study
    }),
  }
  const fetchStudy = createTradingViewStudyFetcher({
    createIndicator: async () => ({ indicator, metadata }),
  })
  const result = await fetchStudy(chart, request, {
    window: { start: 3_600, end: 14_400 },
    timeframeSeconds: 3_600,
    timeoutMs: 1_000,
    settleDelayMs: 0,
  })

  assert.equal(chart.createStudy.mock.callCount(), 1)
  assert.equal(chart.createStudy.mock.calls[0].arguments[0], indicator)
  assert.equal(study.remove.mock.callCount(), 1)
  assert.deepEqual(result, {
    request,
    indicator: metadata,
    fields: { value: "Active_posts" },
    periods: [
      { time: 3_600, value: 0 },
      { time: 7_200, value: null },
      { time: 10_800, value: null },
    ],
    coverage: {
      periodCount: 3,
      sourcePeriodCount: 2,
      completePeriods: 1,
      partialPeriods: 0,
      missingPeriods: 2,
      duplicatePeriodCount: 0,
      invalidTimestampCount: 0,
    },
  })
})
