import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import { buildCoinCardData } from "../src/reports/coin-card/build-coin-card-data.js"
import { createDemoReport } from "../src/reports/coin-card/create-demo-report.js"
import { runCoinCardPreview, writeCoinCardPreview } from "../src/reports/coin-card/preview.js"
import { createReportStore } from "../src/reports/store.js"

async function temporaryDirectory (t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "coin-card-preview-"))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  return directory
}

function assertPreviewSvg (svg, asOf, hours) {
  assert.match(svg, /^<svg\b[^>]*width="1200"[^>]*height="1280"[^>]*viewBox="0 0 1200 1280"/)
  assert.deepEqual([...svg.matchAll(/<g class="candle" data-time="(\d+)"[^>]*>[\s\S]*?<rect\b/g)].map(([, time]) => Number(time)),
    Array.from({ length: hours }, (_, index) => Date.parse(asOf) / 1_000 - (hours - 1 - index) * 3_600))
  assert.equal([...svg.matchAll(/<rect class="volume-bar"/g)].length, hours)
  assert.equal([...svg.matchAll(/<circle\b/g)].length, hours)
  assert.equal([...svg.matchAll(new RegExp(`>${hours}/168 ч</text>`, "g"))].length, 3)
  assert.match(svg, /Окно: 7 дней · начало свечей на оси/)
  if (hours === 168) {
    assert.match(svg, /<desc>Цена, объём и Open Interest за 7 дней из сохранённого отчёта\.<\/desc>/)
  }
}

async function snapshotFiles (directory) {
  return Promise.all((await fs.readdir(directory)).sort().map(async filename => [filename, await fs.readFile(path.join(directory, filename))]))
}

for (const hours of [168, 72]) {
  test(`renders the latest saved ${hours}-hour Parquet report without changing the snapshots`, async (t) => {
    const directory = await temporaryDirectory(t)
    const archive = path.join(directory, "reports")
    const store = await createReportStore({ directory: archive })
    const report = { ...createDemoReport(), demo: false, reportCreatedAt: "2026-10-01T10:30:00Z", candidateCount: 1, universeCoinCount: 1 }
    for (const key of ["candles", "volume", "openInterest"]) {
      report.coins[0].history[key] = report.coins[0].history[key].slice(-hours)
    }
    const before = structuredClone(report)
    const olderReport = { ...report, reportCreatedAt: "2026-10-01T09:30:00Z", coins: [{ ...report.coins[0], symbol: "OLDER" }] }
    const saved = await store.save(report)
    const older = await store.save(olderReport)
    await store.close()
    const snapshots = await Promise.all([saved, older].map(({ directory }) => snapshotFiles(directory)))

    const result = await runCoinCardPreview({
      directory: path.join(directory, "images"),
      createStore: () => createReportStore({ directory: archive }),
    })
    assert.equal(result.symbol, "DEMO")
    assert.equal(result.demo, false)
    const svg = await fs.readFile(result.files.svg, "utf8")
    assert.match(svg, /CRYPTO SIGNALS/)
    assertPreviewSvg(svg, report.asOf, hours)
    const png = await fs.readFile(result.files.png)
    assert.deepEqual(png.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    assert.equal(png.readUInt32BE(16), 1200)
    assert.equal(png.readUInt32BE(20), 1280)
    assert.deepEqual(report, before)
    assert.deepEqual((await fs.readdir(archive)).sort(), [saved.id, older.id].sort())
    assert.deepEqual(await Promise.all([saved, older].map(({ directory }) => snapshotFiles(directory))), snapshots)
    const reopened = await createReportStore({ directory: archive })
    try {
      assert.deepEqual(await reopened.read(saved.id), before)
      assert.deepEqual(await reopened.read(older.id), olderReport)
      assert.equal((await reopened.list()).length, 2)
    } finally {
      await reopened.close()
    }
  })
}

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

test("demo supplies exactly seven days of closed hourly price, volume and OI data", () => {
  const report = createDemoReport()
  const before = structuredClone(report)
  const asOf = Date.parse(report.asOf) / 1_000
  const times = Array.from({ length: 168 }, (_, index) => asOf - (167 - index) * 3_600)
  for (const key of ["candles", "volume", "openInterest"]) {
    assert.equal(report.coins[0].history[key].length, 168)
    assert.deepEqual(report.coins[0].history[key].map(point => point.time), times)
  }
  const data = buildCoinCardData(report, report.coins[0])
  assert.equal(data.points.length, 168)
  assert.deepEqual(data.points.map(point => point.time), times)
  assert.deepEqual(data.coverage, { candles: 168, volume: 168, openInterest: 168 })
  assert.deepEqual(data.warnings, [])
  assert.equal(data.price, report.coins[0].history.candles.at(-1).close)
  assert.deepEqual(report, before)
})

test("explicit demo mode renders 168 candles, is labelled and never opens the archive", async (t) => {
  const result = await runCoinCardPreview({
    demo: true, directory: await temporaryDirectory(t),
    createStore: async () => assert.fail("demo must not read the archive"),
  })
  assert.equal(result.demo, true)
  const svg = await fs.readFile(result.files.svg, "utf8")
  assert.match(svg, /ДЕМО · СИНТЕТИЧЕСКИЕ ДАННЫЕ/)
  assertPreviewSvg(svg, result.asOf, 168)
  const png = await fs.readFile(result.files.png)
  assert.deepEqual(png.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  assert.equal(png.readUInt32BE(16), 1200)
  assert.equal(png.readUInt32BE(20), 1280)
})

test("demo cannot silently override a requested report or coin", async () => {
  await assert.rejects(runCoinCardPreview({ demo: true, symbol: "SNX" }), /нельзя сочетать/)
  await assert.rejects(runCoinCardPreview({ demo: true, reportId: "saved" }), /нельзя сочетать/)
})
