import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import { createReportStore } from "../src/reports/store.js"

test("saved reports preserve exact numbers, coin order, nulls and history gaps after reopening", async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "report-store-"))
  let store
  context.after(async () => {
    await store?.close()
    await fs.rm(directory, { recursive: true, force: true })
  })
  store = await createReportStore({ directory })
  const report = {
    reportCreatedAt: "2026-09-26T13:00:48.708Z",
    asOf: "2026-09-26T11:00:00.000Z",
    candidateCount: 2,
    universeCoinCount: 250,
    marketContext: { altMarketBackground: { status: "up", change4hPct: 0.2262839160786661, warning: null } },
    coins: [
      {
        symbol: "B", movementProbability: 0.6000000000000001, topRank: null,
        explanation: "Точность данных важнее оформления 🚀",
        features: { fundingRate: -0.0000123456789, volumeZ: 2.051, quietOi: true, socialDominanceZ: null },
        history: {
          candles: [
            { time: 200, open: 0.0000002, high: 0.0000003, low: 0.0000001, close: 0.00000025 },
            { time: 100, open: 1, high: 2, low: 0.5, close: 1.5 },
          ],
          volume: [{ time: 100, value: null }, { time: 200 }, { time: 300, value: 0 }],
          openInterest: [{ time: 100, value: 123456.123456789 }, { time: 200 }],
          warning: "Пропуски не заполнены",
        },
      },
      {
        symbol: "A", movementProbability: 0.1, topRank: 1,
        features: { volumeZ: null, quietOi: false },
      },
    ],
    peerRadar: {
      status: "available",
      data: { observations: [{ symbol: "OUTSIDE", leaders: [{ symbol: "LEADER", gapAtr: 5.688581314878884 }] }] },
      histories: {
        OUTSIDE: { points: [{ time: 100 }, { time: 200, value: null }, { time: 300, value: 0.09964 }] },
      },
    },
  }
  const expected = structuredClone(report)
  const { id } = await store.save(report)
  report.coins[0].features.volumeZ = 999
  await store.close()
  store = await createReportStore({ directory })

  assert.deepEqual(await store.read(id), expected)
  assert.deepEqual((await store.list()).map(entry => entry.id), [id])
})
