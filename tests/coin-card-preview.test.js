import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import { createDemoReport } from "../src/reports/coin-card/create-demo-report.js"
import { runCoinCardPreview, writeCoinCardPreview } from "../src/reports/coin-card/preview.js"
import { createReportStore } from "../src/reports/store.js"

async function temporaryDirectory (t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "coin-card-preview-"))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  return directory
}

test("renders the latest saved Parquet report without changing the snapshot", async (t) => {
  const directory = await temporaryDirectory(t)
  const archive = path.join(directory, "reports")
  const store = await createReportStore({ directory: archive })
  const report = { ...createDemoReport(), demo: false, reportCreatedAt: "2026-10-01T10:30:00Z", candidateCount: 1, universeCoinCount: 1 }
  const saved = await store.save(report)
  await store.save({ ...report, reportCreatedAt: "2026-10-01T09:30:00Z", coins: [{ ...report.coins[0], symbol: "OLDER" }] })
  await store.close()

  const result = await runCoinCardPreview({
    directory: path.join(directory, "images"),
    createStore: () => createReportStore({ directory: archive }),
  })
  assert.equal(result.symbol, "DEMO")
  assert.equal(result.demo, false)
  assert.match(await fs.readFile(result.files.svg, "utf8"), /CRYPTO SIGNALS/)
  assert.deepEqual((await fs.readFile(result.files.png)).subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  const reopened = await createReportStore({ directory: archive })
  try {
    assert.deepEqual(await reopened.read(saved.id), report)
    assert.equal((await reopened.list()).length, 2)
  } finally {
    await reopened.close()
  }
})

test("an empty archive is an error, not a silent demo fallback", async () => {
  let closed = false
  await assert.rejects(runCoinCardPreview({ createStore: async () => ({
    list: async () => [],
    close: async () => {
      closed = true
    },
  }) }), /Архив reports пуст/)
  assert.equal(closed, true)
})

test("an explicitly selected missing report is not replaced with the latest one", async () => {
  let closed = false
  await assert.rejects(runCoinCardPreview({ reportId: "missing", createStore: async () => ({
    list: async () => assert.fail("must not select another report"),
    read: async (id) => {
      assert.equal(id, "missing")
      return null
    },
    close: async () => {
      closed = true
    },
  }) }), /Отчёт missing не найден/)
  assert.equal(closed, true)
})

test("closes the store on archive errors", async () => {
  let closed = false
  await assert.rejects(runCoinCardPreview({ createStore: async () => ({
    list: async () => {
      throw new Error("broken archive")
    },
    close: async () => {
      closed = true
    },
  }) }), /broken archive/)
  assert.equal(closed, true)
})

test("without top candidates requires an explicit symbol rather than promoting an assessment", async (t) => {
  const report = createDemoReport()
  report.coins[0].topRank = null
  const directory = await temporaryDirectory(t)
  await assert.rejects(writeCoinCardPreview(report, { directory }), /нет топ-кандидатов/)
  const result = await writeCoinCardPreview(report, { directory, symbol: "demo" })
  assert.equal(result.symbol, "DEMO")
  await assert.rejects(writeCoinCardPreview(report, { directory, symbol: "OTHER" }), /OTHER отсутствует/)
})

test("the default candidate follows topRank, not array order or an assessment's probability", async (t) => {
  const report = createDemoReport()
  report.coins.unshift({ ...report.coins[0], symbol: "LATE", topRank: null, movementProbability: 0.99 })
  report.coins.unshift({ ...report.coins[1], symbol: "SECOND", topRank: 2 })
  const before = structuredClone(report)
  const result = await writeCoinCardPreview(report, { directory: await temporaryDirectory(t) })
  assert.equal(result.symbol, "DEMO")
  assert.deepEqual(report, before)
})

test("explicit demo mode is labelled and never opens the archive", async (t) => {
  const result = await runCoinCardPreview({
    demo: true, directory: await temporaryDirectory(t),
    createStore: async () => assert.fail("demo must not read the archive"),
  })
  assert.equal(result.demo, true)
  assert.match(await fs.readFile(result.files.svg, "utf8"), /ДЕМО · СИНТЕТИЧЕСКИЕ ДАННЫЕ/)
})

test("demo cannot silently override a requested report or coin", async () => {
  await assert.rejects(runCoinCardPreview({ demo: true, symbol: "SNX" }), /нельзя сочетать/)
  await assert.rejects(runCoinCardPreview({ demo: true, reportId: "saved" }), /нельзя сочетать/)
})
