import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { randomUUID } from "node:crypto"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { setTimeout } from "node:timers/promises"
import { promisify } from "node:util"
import { DuckDBConnection, DuckDBInstance } from "@duckdb/node-api"
import { createReportStore } from "../src/reports/store.js"
import { writeParquet } from "../src/reports/parquet.js"

function createReport () {
  return {
    reportCreatedAt: "2026-09-26T13:00:48.708Z",
    asOf: "2026-09-26T11:00:00.000Z",
    timeframe: "1h",
    objective: "P(сильное движение в следующие 4–12 часов)",
    candidateCount: 2,
    universeCoinCount: 250,
    marketContext: { breadth4h: 0.696, altMarketBackground: { status: "up", change4hPct: 0.2262839160786661, warning: null } },
    definitions: { volumeZ: "Аномалия объёма", peerLeaders: "Лидеры соседей" },
    flagDefinitions: {},
    informationSources: { news: { from: "2026-09-25T12:00:00Z", asOf: "2026-09-26T12:00:00Z" } },
    coinDescriptions: { A: { description: "Immutable description 🚀", sources: [{ url: "https://example.com/?a='b'", checkedAt: null }] } },
    coins: [
      {
        symbol: "B", name: "Coin B", baseCurrencyId: "B", marketSymbol: "BINANCE:BUSDT.P",
        movementProbability: 0.6000000000000001, estimateConfidence: "medium", topRank: null,
        drivers: ["second", "first"], counterSignals: [], explanation: "Строка\nс кавычками \" и ' <script>",
        features: {
          volumeZ: 2.051, fundingRate: -0.0000123456789, quietOi: true, socialStatus: "unavailable",
          socialDominanceZ: null, flags: ["coiling", "laggard"], coingeckoTrendingCategories: [],
          peerLeaders: [{ symbol: "LEADER", ageHours: 3, responseRatio: -0.25 / 3.6, caveat: null }],
          nested: { scores: [0, 1.2345678901234567, null], optional: null },
        },
        history: {
          candles: [{ time: 200, open: 0.2, high: 0.3, low: 0.1, close: 0.25 }, { time: 100, open: 1, high: 2, low: 0.5, close: 1.5 }],
          volume: [{ time: 200 }, { time: 100, value: null }, { time: 300, value: 0 }],
          openInterest: [{ time: 100, value: 123456.123456789 }, { time: 200 }],
          warning: "Пропуски не заполнены",
        },
        socialSignificant: false, socialSentiment: null,
        information: {
          news: { status: "empty", error: null, items: [] },
          twitter: { status: "available", tweets: [{ id: "2103826582045618585", text: "A tweet", likeCount: 0, urls: [] }] },
        },
      },
      {
        symbol: "A", movementProbability: 0.1, topRank: 1,
        features: { volumeZ: null, quietOi: false, flags: [], peerLeaders: [], nested: {} },
        history: { candles: [], volume: [], openInterest: [], warning: "История недоступна" },
        information: { news: { status: "failed", error: "Unavailable", items: [] } },
      },
    ],
    peerRadar: {
      status: "available", warning: null,
      data: {
        asOf: "2026-09-26T11:00:00.000Z", schemaVersion: 1, coverage: { available: 1, unavailable: 2 },
        observationCount: 1,
        observations: [{
          coin: { baseCurrencyId: "OUTSIDE", symbol: "OUTSIDE", marketSymbol: null },
          verdict: "watch", caveats: [],
          leaders: [{ symbol: "LEADER", gapAtr: 5.688581314878884, responseRatio: 0.0584192439862531 }],
        }],
      },
      histories: {
        OUTSIDE: { symbol: "OUTSIDE", marketSymbol: null, points: [{ time: 100 }, { time: 200, value: null }, { time: 300, value: 0.09964 }], warning: "Gap" },
        LEADER: { symbol: "LEADER", points: [], warning: null },
      },
    },
  }
}

async function temporaryDirectory (t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "report-store-"))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  return directory
}

async function openStore (t, directory) {
  const store = await createReportStore({ directory })
  t.after(() => store.close())
  return store
}

async function sqlConnection (t) {
  const instance = await DuckDBInstance.create(":memory:", { threads: "1", temp_directory: "" })
  const connection = await instance.connect()
  t.after(() => {
    connection.closeSync()
    instance.closeSync()
  })
  return connection
}

test("round-trips the complete nested snapshot, absence/null, order, gaps and unavailable history", async (t) => {
  const directory = await temporaryDirectory(t)
  const store = await openStore(t, directory)
  const report = createReport()
  const before = structuredClone(report)
  const saved = await store.save(report)
  assert.match(saved.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  assert.equal(saved.directory, path.join(directory, saved.id))
  assert.deepEqual((await fs.readdir(saved.directory)).sort(), ["coins.parquet", "history.parquet", "peer-radar.parquet", "report.parquet"])
  assert.deepEqual(await store.read(saved.id), before)
  assert.deepEqual(report, before)
  await store.close()
  const reopened = await openStore(t, directory)
  assert.deepEqual(await reopened.read(saved.id), before)
  assert.deepEqual(await reopened.list(), [{
    id: saved.id, reportCreatedAt: report.reportCreatedAt, asOf: report.asOf,
    candidateCount: 2, universeCoinCount: 250,
  }])
})

for (const [label, peerRadar] of [
  ["unavailable", { status: "unavailable", warning: "Нет данных", data: null, histories: {} }],
  ["empty", { status: "available", warning: null, data: { observations: [], observationCount: 0, coverage: { unavailable: 250 } }, histories: {} }],
  ["null", null],
  ["missing", undefined],
]) {
  test(`empty coins and ${label} radar remain distinct`, async (t) => {
    const store = await openStore(t, await temporaryDirectory(t))
    const report = { ...createReport(), candidateCount: 0, coins: [] }
    delete report.peerRadar
    if (peerRadar !== undefined) {
      report.peerRadar = peerRadar
    }
    const { id } = await store.save(report)
    assert.deepEqual(await store.read(id), report)
  })
}

test("optional histories, explicit nulls, empty objects and exact JS numbers survive", async (t) => {
  const store = await openStore(t, await temporaryDirectory(t))
  const report = createReport()
  delete report.coins[0].history
  report.coins[1].history = null
  report.coins[0].features.exact = [Number.MAX_VALUE, Number.MIN_VALUE, Number.MAX_SAFE_INTEGER, 9007199254740992, -1e-200]
  report.coins[0].features.empty = [{}, null, { optional: null }]
  report.extra = { empty: {}, text: ["1", "2026-09-26", "true", "null"], explicitNull: null }
  const { id } = await store.save(report)
  assert.deepEqual(await store.read(id), report)
})

test("features, assessments, OHLCV/OI, leaders and peer histories are queryable typed data", async (t) => {
  const directory = path.join(await temporaryDirectory(t), "archive's reports")
  const store = await openStore(t, directory)
  const report = createReport()
  const saved = await store.save(report)
  const connection = await sqlConnection(t)
  const coins = await connection.runAndReadAll(`
    SELECT data.symbol AS symbol, data.features.volumeZ * 2 AS feature,
      typeof(data.features.volumeZ) AS featureType, typeof(data.movementProbability) AS assessmentType,
      typeof(data.features.socialDominanceZ) AS unavailableType, data.features.socialDominanceZ + 1 AS unavailable,
      typeof(data.features.peerLeaders) AS leadersType
    FROM read_parquet(?) WHERE position = 0
  `, [path.join(saved.directory, "coins.parquet")])
  assert.equal(coins.getRowObjectsJS()[0].feature, 4.102)
  assert.equal(coins.getRowObjectsJS()[0].featureType, "DOUBLE")
  assert.equal(coins.getRowObjectsJS()[0].assessmentType, "DOUBLE")
  assert.equal(coins.getRowObjectsJS()[0].unavailableType, "DOUBLE")
  assert.equal(coins.getRowObjectsJS()[0].unavailable, null)
  assert.match(coins.getRowObjectsJS()[0].leadersType, /STRUCT\(.*responseRatio DOUBLE.*\)\[\]/)
  const history = await connection.runAndReadAll(`
    SELECT data.coinIndex AS coinIndex, data.history.candles[1].close AS close,
      data.history.openInterest[1].value AS oi, data.history.volume[3].value AS volume,
      typeof(data.history.candles) AS candlesType, typeof(data.history.openInterest[1].value) AS oiType,
      len(data.history.volume) AS volumeCount
    FROM read_parquet(?) WHERE position = 0
  `, [path.join(saved.directory, "history.parquet")])
  assert.equal(history.getRowObjectsJS()[0].close, 0.25)
  assert.equal(history.getRowObjectsJS()[0].oi, report.coins[0].history.openInterest[0].value)
  assert.equal(history.getRowObjectsJS()[0].volume, 0)
  assert.equal(history.getRowObjectsJS()[0].oiType, "DOUBLE")
  assert.equal(history.getRowObjectsJS()[0].volumeCount, 3n)
  assert.match(history.getRowObjectsJS()[0].candlesType, /STRUCT\(.*"close" DOUBLE.*\)\[\]/)
  const radar = await connection.runAndReadAll(`
    SELECT data.radar.data.observations[1].leaders[1].gapAtr AS gap,
      data.histories[1].history.points[3].value AS price,
      typeof(data.histories[1].history.points[1].value) AS priceType
    FROM read_parquet(?)
  `, [path.join(saved.directory, "peer-radar.parquet")])
  assert.deepEqual(radar.getRowObjectsJS(), [{ gap: 5.688581314878884, price: 0.09964, priceType: "DOUBLE" }])
  const schemas = await connection.runAndReadAll("DESCRIBE SELECT * FROM read_parquet(?)", [path.join(saved.directory, "report.parquet")])
  assert.match(schemas.getRowObjectsJS().find(row => row.column_name === "data").column_type, /^STRUCT\(/)
  assert.deepEqual(await store.read(saved.id), report)
})

test("same timestamps get unique IDs, input/read mutations do not alter snapshots", async (t) => {
  const store = await openStore(t, await temporaryDirectory(t))
  const report = createReport()
  const before = structuredClone(report)
  const saves = [store.save(report), store.save(report), store.save(report)]
  report.coins[0].features.volumeZ = 999
  report.coinDescriptions.A.description = "Changed"
  const saved = await Promise.all(saves)
  assert.equal(new Set(saved.map(item => item.id)).size, 3)
  for (const { id } of saved) {
    assert.deepEqual(await store.read(id), before)
  }
  const read = await store.read(saved[0].id)
  read.coins[0].history.volume.length = 0
  assert.deepEqual(await store.read(saved[0].id), before)
  const listed = await store.list()
  listed[0].candidateCount = 999
  assert.equal((await store.list())[0].candidateCount, 2)
})

test("list projects metadata only, caches it, and discovers another store's publications", async (t) => {
  const directory = await temporaryDirectory(t)
  const writer = await openStore(t, directory)
  const reader = await openStore(t, directory)
  const first = await writer.save(createReport())
  const original = DuckDBConnection.prototype.runAndReadAll
  const queries = []
  const spy = t.mock.method(DuckDBConnection.prototype, "runAndReadAll", function(sql, values, ...rest) {
    queries.push({ sql, values })
    if (sql.includes("FROM read_parquet")) {
      assert.match(values[0], /report\.parquet$/)
      assert.doesNotMatch(sql, /SELECT \*/)
      assert.doesNotMatch(sql, /features|histories|candles/)
    }
    return original.call(this, sql, values, ...rest)
  })
  assert.deepEqual((await reader.list()).map(row => row.id), [first.id])
  assert.ok(queries.length > 0)
  queries.length = 0
  await reader.list()
  assert.deepEqual(queries, [])
  const second = await writer.save({ ...createReport(), reportCreatedAt: "2026-09-26T14:00:00Z" })
  queries.length = 0
  assert.deepEqual((await reader.list()).map(row => row.id), [second.id, first.id])
  assert.ok(queries.every(({ values }) => !values.includes(path.join(first.directory, "report.parquet"))))
  spy.mock.restore()
})

test("staging, legacy files, symlinks and invalid IDs are ignored", async (t) => {
  const directory = await temporaryDirectory(t)
  const store = await openStore(t, directory)
  const staging = path.join(directory, `.report-${randomUUID()}-partial`)
  await fs.mkdir(staging)
  await fs.writeFile(path.join(staging, "report.parquet"), "partial")
  await fs.writeFile(path.join(directory, "report.html"), "legacy")
  await fs.writeFile(path.join(directory, "report.json"), "legacy")
  await fs.mkdir(path.join(directory, "old-report"))
  const linked = randomUUID()
  await fs.symlink(staging, path.join(directory, linked))
  assert.deepEqual(await store.list(), [])
  for (const id of [randomUUID(), linked, "../report", "../" + randomUUID(), "", null, 1, {}, "report.html", path.basename(staging)]) {
    assert.equal(await store.read(id), null)
  }
})

test("a complete staged snapshot stays invisible until the single rename publishes it", async (t) => {
  const directory = await temporaryDirectory(t)
  const writer = await openStore(t, directory)
  const reader = await openStore(t, directory)
  const original = fs.rename
  const rename = t.mock.method(fs, "rename", async (source, destination) => {
    assert.equal(path.dirname(source), directory)
    assert.equal(path.dirname(destination), directory)
    assert.ok(path.basename(source).startsWith("."))
    assert.deepEqual((await fs.readdir(source)).sort(), ["coins.parquet", "history.parquet", "peer-radar.parquet", "report.parquet"])
    assert.deepEqual(await reader.list(), [])
    assert.equal(await reader.read(path.basename(destination)), null)
    return original(source, destination)
  })
  const saved = await writer.save(createReport())
  assert.equal(rename.mock.callCount(), 1)
  assert.deepEqual((await reader.list()).map(row => row.id), [saved.id])
  assert.deepEqual(await reader.read(saved.id), createReport())
})

for (const failure of ["write", "rename"]) {
  test(`${failure} failure rolls back staging, preserves old snapshots and leaves the store usable`, async (t) => {
    const directory = await temporaryDirectory(t)
    const store = await openStore(t, directory)
    const existing = await store.save(createReport())
    let mock
    if (failure === "write") {
      const original = DuckDBConnection.prototype.run
      mock = t.mock.method(DuckDBConnection.prototype, "run", function(sql, ...rest) {
        if (sql.includes("COPY (") && sql.includes("history.parquet")) {
          throw new Error("Injected Parquet write failure")
        }
        return original.call(this, sql, ...rest)
      })
    } else {
      mock = t.mock.method(fs, "rename", async () => {
        throw new Error("Injected publish failure")
      })
    }
    await assert.rejects(store.save(createReport()), /Failed to save report .*Injected/)
    mock.mock.restore()
    assert.deepEqual(await fs.readdir(directory), [existing.id])
    assert.deepEqual(await store.read(existing.id), createReport())
    const next = await store.save(createReport())
    assert.notEqual(next.id, existing.id)
    assert.equal((await store.list()).length, 2)
  })
}

test("conflicting numeric types fail explicitly rather than storing opaque financial JSON", async (t) => {
  const directory = await temporaryDirectory(t)
  const store = await openStore(t, directory)
  const report = createReport()
  report.coins[1].features.volumeZ = "not a number"
  await assert.rejects(store.save(report), /volumeZ.*numeric data must remain typed/)
  assert.deepEqual(await fs.readdir(directory), [])
})

for (const filename of ["report.parquet", "coins.parquet", "history.parquet", "peer-radar.parquet"]) {
  test(`malformed published ${filename} is an actionable error for read and cold list`, async (t) => {
    const directory = await temporaryDirectory(t)
    const store = await openStore(t, directory)
    const saved = await store.save(createReport())
    await fs.writeFile(path.join(saved.directory, filename), "Not Parquet")
    for (const operation of [() => store.read(saved.id), () => store.list()]) {
      await assert.rejects(operation, (error) => {
        assert.match(error.message, /Invalid report archive/)
        assert.ok(error.message.includes(saved.id))
        assert.ok(error.message.includes(filename))
        assert.match(error.message, /Restore or remove/)
        return true
      })
    }
  })
}

test("valid Parquet with mismatched manifest counts is rejected rather than inventing metadata", async (t) => {
  const directory = await temporaryDirectory(t)
  const store = await openStore(t, directory)
  const saved = await store.save(createReport())
  const filename = path.join(saved.directory, "coins.parquet")
  await fs.rm(filename)
  await writeParquet(await sqlConnection(t), filename, [{ symbol: "ONLY-ONE" }])
  await assert.rejects(store.list(), /Invalid report archive.*coins\.parquet row count/)
  await assert.rejects(store.read(saved.id), /Invalid report archive.*coins\.parquet row count/)
})

test("invalid report metadata is rejected before staging, without fallback timestamps or counts", async (t) => {
  const directory = await temporaryDirectory(t)
  const store = await openStore(t, directory)
  for (const patch of [{ reportCreatedAt: null }, { asOf: "invalid" }, { candidateCount: 1 }, { universeCoinCount: -1 }]) {
    await assert.rejects(store.save({ ...createReport(), ...patch }), /timestamp|candidate|coins/)
  }
  assert.deepEqual(await fs.readdir(directory), [])
})

test("a UUID directory with missing files is not silently treated as an absent report", async (t) => {
  const directory = await temporaryDirectory(t)
  const store = await openStore(t, directory)
  const id = randomUUID()
  await fs.mkdir(path.join(directory, id))
  await assert.rejects(store.list(), /Invalid report archive.*report\.parquet/)
  await assert.rejects(store.read(id), /Invalid report archive.*report\.parquet/)
})

test("independent processes can publish concurrently while an existing reader discovers snapshots", { timeout: 30_000 }, async (t) => {
  const directory = await temporaryDirectory(t)
  const reader = await openStore(t, directory)
  assert.deepEqual(await reader.list(), [])
  const script = `
    import { createReportStore } from ${JSON.stringify(new URL("../src/reports/store.js", import.meta.url).href)}
    const store = await createReportStore({ directory: ${JSON.stringify(directory)} })
    try {
      const saved = await Promise.all([store.save(${JSON.stringify(createReport())}), store.save(${JSON.stringify(createReport())})])
      console.log(JSON.stringify(saved.map(({ id }) => id)))
    } finally { await store.close() }
  `
  let finished = false
  const writers = Promise.all([1, 2].map(() => promisify(execFile)(process.execPath, ["--input-type=module", "--eval", script], { timeout: 20_000 })))
    .finally(() => finished = true)
  const observations = []
  const polling = (async () => {
    while (!finished) {
      observations.push(await reader.list())
      await setTimeout(10)
    }
  })()
  const [results] = await Promise.all([writers, polling])
  const ids = results.flatMap(({ stdout }) => JSON.parse(stdout))
  assert.equal(new Set(ids).size, 4)
  assert.deepEqual((await reader.list()).map(row => row.id).sort(), ids.sort())
  assert.ok(observations.length > 0)
  for (const id of ids) {
    assert.deepEqual(await reader.read(id), createReport())
  }
  assert.deepEqual((await fs.readdir(directory)).sort(), ids.sort())
})

test("default archive survives tmp reset and mutable dictionary changes without a shared database", { timeout: 20_000 }, async (t) => {
  const directory = await temporaryDirectory(t)
  const report = createReport()
  const { stdout } = await promisify(execFile)(process.execPath, ["--input-type=module", "--eval", `
    import fs from "node:fs/promises"
    import { createReportStore } from ${JSON.stringify(new URL("../src/reports/store.js", import.meta.url).href)}
    import { resetTmpDirectory } from ${JSON.stringify(new URL("../src/helpers/fs-helper.js", import.meta.url).href)}
    const store = await createReportStore()
    const saved = await store.save(${JSON.stringify(report)})
    await store.close()
    await fs.mkdir("tmp", { recursive: true })
    await fs.writeFile("tmp/unrelated.json", "{}")
    await fs.mkdir("data", { recursive: true })
    await fs.writeFile("data/coin-descriptions.json", JSON.stringify({ coins: [] }))
    await resetTmpDirectory()
    const reopened = await createReportStore()
    try { console.log(JSON.stringify({ saved, report: await reopened.read(saved.id), list: await reopened.list() })) }
    finally { await reopened.close() }
  `], { cwd: directory, timeout: 15_000 })
  const result = JSON.parse(stdout)
  assert.equal(result.saved.directory, path.join(directory, "reports", result.saved.id))
  assert.deepEqual(result.report, report)
  assert.equal(result.list[0].id, result.saved.id)
  assert.deepEqual(await fs.readdir(path.join(directory, "tmp")), [])
  assert.deepEqual((await fs.readdir(directory)).sort(), ["data", "reports", "tmp"])
  assert.deepEqual(await fs.readdir(path.join(directory, "reports")), [result.saved.id])
})

test("close waits for queued operations, releases DuckDB resources, is idempotent and rejects later work", async (t) => {
  const directory = await temporaryDirectory(t)
  const store = await createReportStore({ directory })
  const closeConnection = t.mock.method(DuckDBConnection.prototype, "closeSync")
  const closeInstance = t.mock.method(DuckDBInstance.prototype, "closeSync")
  const saving = store.save(createReport())
  const closing = store.close()
  assert.equal(store.close(), closing)
  const saved = await saving
  await closing
  assert.equal(closeConnection.mock.callCount(), 1)
  assert.equal(closeInstance.mock.callCount(), 1)
  for (const operation of [() => store.list(), () => store.read(saved.id), () => store.save(createReport())]) {
    await assert.rejects(operation, /Report store is closed/)
  }
  const reopened = await openStore(t, directory)
  assert.deepEqual(await reopened.read(saved.id), createReport())
})
