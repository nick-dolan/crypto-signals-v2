import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"

import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { gunzipSync, gzipSync } from "node:zlib"
import { DuckDBInstance } from "@duckdb/node-api"

import { readParquet, writeParquet } from "../src/reports/parquet.js"
import { createReportStore } from "../src/reports/store.js"

async function parquetSchema (connection, filename) {
  const result = await connection.runAndReadAll(
    "SELECT decode(key) AS key, decode(value) AS value FROM parquet_kv_metadata(?)", [filename],
  )
  const metadata = result.getRowObjectsJS()
  assert.deepEqual(metadata.map(entry => entry.key), ["report_store_schema_gzip"], filename)
  const value = metadata[0].value
  const json = gunzipSync(Buffer.from(value, "base64")).toString("utf8")
  assert.equal(value, gzipSync(json, { level: 9 }).toString("base64"), filename)
  return JSON.parse(json)
}

async function parquetColumns (connection, filename) {
  const result = await connection.runAndReadAll(
    "SELECT name, type, converted_type FROM parquet_schema(?) WHERE type IS NOT NULL", [filename],
  )
  return new Map(result.getRowObjectsJS().map(({ name, ...column }) => [name, column]))
}

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
    coinCount: 250,
    marketDefinitions: {
      status: "Текст с 'кавычками', \"JSON\" и переносом\nстроки 🚀",
      optional: null,
      nested: { labels: ["0", "1.25", "false"], empty: {} },
    },
    definitions: [{ feature: "quietOi", description: "Тихий OI" }, {}, null, []],
    flagDefinitions: [],
    coinDescriptions: Object.fromEntries([
      ["__proto__", { description: "Собственный ключ 🚀", sources: [], warning: null }],
      ["B", {
        description: "",
        sources: [{ title: "Источник", url: "https://example.test/?a=1&b=2" }, { url: "https://example.test/next", note: null }],
      }],
      ["sparse", {}],
      ["toString", null],
      ["", { sources: [] }],
    ]),
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
      data: { coinCount: 245, observations: [{ symbol: "OUTSIDE", leaders: [{ symbol: "LEADER", gapAtr: 5.688581314878884 }] }] },
      histories: {
        OUTSIDE: { points: [{ time: 100 }, { time: 200, value: null }, { time: 300, value: 0.09964 }] },
      },
    },
  }
  const expected = structuredClone(report)
  const { id, directory: snapshotDirectory } = await store.save(report)
  assert.deepEqual(report, expected)
  assert.deepEqual((await fs.readdir(snapshotDirectory)).sort(), ["coins.parquet", "history.parquet", "peer-radar.parquet", "report.parquet"])
  report.coins[0].features.volumeZ = 999
  await store.close()
  store = await createReportStore({ directory })

  assert.deepEqual(await store.read(id), expected)
  assert.deepEqual((await store.list()).map(entry => entry.id), [id])
})

test("legacy coin counts are restored for listing, reading and saving without legacy fields", async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "report-store-"))
  let store
  let instance
  let connection
  context.after(async () => {
    await store?.close()
    connection?.closeSync()
    instance?.closeSync()
    await fs.rm(directory, { recursive: true, force: true })
  })
  instance = await DuckDBInstance.create(":memory:", { threads: "1", temp_directory: "" })
  connection = await instance.connect()
  const expected = {
    reportCreatedAt: "2026-09-26T13:00:48.708Z",
    asOf: "2026-09-26T11:00:00.000Z",
    candidateCount: 1,
    coinCount: 250,
    coins: [{ symbol: "A", movementProbability: 0.6000000000000001 }],
    peerRadar: { status: "available", data: { coinCount: 245, loadedCoinCount: 200, observations: [] } },
  }
  const { coins, peerRadar, coinCount, ...header } = expected
  const { coinCount: radarCoinCount, ...radarData } = peerRadar.data
  const id = randomUUID()
  const folder = path.join(directory, id)
  await fs.mkdir(folder)
  await writeParquet(connection, path.join(folder, "report.parquet"), [{
    report: { ...header, universeCoinCount: coinCount },
    manifest: { version: 2, id, coins: 1, history: 0, peerRadar: 1, textFields: [], coinDescriptions: false },
  }])
  await writeParquet(connection, path.join(folder, "coins.parquet"), coins)
  await writeParquet(connection, path.join(folder, "history.parquet"), [], { coinIndex: 0, history: null })
  await writeParquet(connection, path.join(folder, "peer-radar.parquet"), [{
    radar: { ...peerRadar, data: { ...radarData, universeCoinCount: radarCoinCount } },
  }])

  store = await createReportStore({ directory })
  const metadata = { ...header, coinCount }
  assert.deepEqual(await store.list(), [{ id, ...metadata }])
  const restored = await store.read(id)
  assert.deepEqual(restored, expected)
  const saved = await store.save(restored)
  await store.close()
  store = await createReportStore({ directory })
  assert.deepEqual(await store.read(saved.id), expected)
  assert.deepEqual(await store.list(), [id, saved.id].sort().map(id => ({ id, ...metadata })))

  const [savedHeader] = await readParquet(connection, path.join(saved.directory, "report.parquet"))
  const [savedRadar] = await readParquet(connection, path.join(saved.directory, "peer-radar.parquet"))
  assert.deepEqual(savedHeader.report, { ...header, coinCount })
  assert.deepEqual(savedRadar.radar, peerRadar)
})

test("saved reports pack only eligible text and preserve physical DOUBLE columns with gzip schema metadata", async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "report-store-"))
  let store
  let instance
  let connection
  context.after(async () => {
    await store?.close()
    connection?.closeSync()
    instance?.closeSync()
    await fs.rm(directory, { recursive: true, force: true })
  })
  instance = await DuckDBInstance.create(":memory:", { threads: "1", temp_directory: "" })
  connection = await instance.connect()
  store = await createReportStore({ directory })

  for (const { fields, textFields, coinDescriptions, numericPaths = [] } of [
    {
      fields: {
        marketDefinitions: { status: "Текст: 0.25, не число" },
        definitions: [{ label: "Выражение 'rate' 🚀", optional: null }, []],
        flagDefinitions: [],
        coinDescriptions: { A: { description: "Описание", sources: [] }, empty: [], scalar: "Текст", boolean: false, absent: null },
      },
      textFields: ["marketDefinitions", "definitions", "flagDefinitions"], coinDescriptions: true,
    },
    {
      fields: {
        marketDefinitions: { reference: { units: [{ unexpectedNumber: 0.6000000000000001 }] } },
        definitions: [{ referenceNumber: -0.0000123456789 }],
        flagDefinitions: { flag: { nestedNumber: 0 } },
        coinDescriptions: { A: { description: "Число в справочнике", stats: { score: -0.00000001234567 } } },
      },
      textFields: [], coinDescriptions: false,
      numericPaths: [
        ["marketDefinitions", "reference", "units", 0, "unexpectedNumber"],
        ["definitions", 0, "referenceNumber"],
        ["flagDefinitions", "flag", "nestedNumber"],
        ["coinDescriptions", "A", "stats", "score"],
      ],
    },
    {
      fields: { marketDefinitions: "Не JSON: {foo}", definitions: null, coinDescriptions: null },
      textFields: [], coinDescriptions: false,
    },
    {
      fields: { marketDefinitions: [], definitions: {}, flagDefinitions: {}, coinDescriptions: {} },
      textFields: ["marketDefinitions", "definitions", "flagDefinitions"], coinDescriptions: true,
    },
    {
      fields: { marketDefinitions: 0, definitions: false, flagDefinitions: null, coinDescriptions: ["Описание", null, {}] },
      textFields: [], coinDescriptions: false,
    },
    { fields: { coinDescriptions: "Нет словаря" }, textFields: [], coinDescriptions: false },
    { fields: {}, textFields: [], coinDescriptions: false },
  ]) {
    const report = {
      reportCreatedAt: "2026-09-26T13:00:48.708Z",
      asOf: "2026-09-26T11:00:00.000Z",
      candidateCount: 1,
      coinCount: 250,
      marketContext: { changePct: 0.2262839160786661 },
      notes: { label: "Не из списка текстовых блоков" },
      coins: [{
        symbol: "A", movementProbability: 0.6000000000000001, topRank: 1,
        features: { rate: -0.0000123456789, volumeZ: 2.051 },
      }],
      ...fields,
    }
    const { id, directory: snapshotDirectory } = await store.save(report)
    const filename = name => path.join(snapshotDirectory, `${name}.parquet`)
    const schemas = {}
    for (const name of ["report", "coins", "history", "peer-radar"]) {
      schemas[name] = await parquetSchema(connection, filename(name))
    }
    const [header] = await readParquet(connection, filename("report"))
    assert.deepEqual(header.manifest, { version: 2, id, coins: 1, history: 0, peerRadar: 0, textFields, coinDescriptions })
    assert.deepEqual(await store.read(id), report)
    assert.equal(schemas.report.report.marketContext.changePct, "DOUBLE")
    assert.deepEqual(schemas.report.report.notes, { label: "VARCHAR" })
    assert.equal(schemas.coins.features.rate, "DOUBLE")
    assert.equal(schemas.coins.features.volumeZ, "DOUBLE")

    const reportColumns = await parquetColumns(connection, filename("report"))
    const coinColumns = await parquetColumns(connection, filename("coins"))
    assert.equal(reportColumns.get("changePct")?.type, "DOUBLE")
    for (const key of ["movementProbability", "topRank", "rate", "volumeZ"]) {
      assert.equal(coinColumns.get(key)?.type, "DOUBLE", key)
    }
    for (const key of textFields) {
      assert.equal(header.report[key], JSON.stringify(report[key]))
      assert.equal(schemas.report.report[key], "VARCHAR")
      assert.deepEqual(reportColumns.get(key), { type: "BYTE_ARRAY", converted_type: "UTF8" })
    }
    if (coinDescriptions) {
      assert.deepEqual(header.report.coinDescriptions, Object.entries(report.coinDescriptions).map(([key, value]) => ({ key, value })))
      if (Object.keys(report.coinDescriptions).length) {
        assert.equal(schemas.report.report.coinDescriptions[0].key, "VARCHAR")
      }
    }
    for (const keys of numericPaths) {
      assert.equal(keys.reduce((schema, key) => schema[key], schemas.report.report), "DOUBLE", keys.join("."))
      assert.equal(reportColumns.get(keys.at(-1))?.type, "DOUBLE", keys.join("."))
    }
  }
})
