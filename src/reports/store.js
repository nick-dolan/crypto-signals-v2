import { randomUUID } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { DuckDBInstance } from "@duckdb/node-api"
import { isArray, isFinite, isObject, isSafeInteger, isString } from "../helpers/utils.typed.js"
import { parquetRowCount, readParquet, writeParquet } from "./parquet.js"

function isReportId (id) {
  return isString(id) && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id)
}

function validateMetadata (report) {
  if ([report?.reportCreatedAt, report?.asOf].some(value => !isString(value) || !isFinite(Date.parse(value)))) {
    throw new Error("reportCreatedAt and asOf must be timestamp strings")
  }
  if (
    !isSafeInteger(report.candidateCount) || report.candidateCount < 0
    || !isSafeInteger(report.universeCoinCount) || report.universeCoinCount < report.candidateCount
  ) {
    throw new Error("candidateCount and universeCoinCount must be non-negative integers including all candidates")
  }
}

function validateReport (report) {
  validateMetadata(report)
  if (!isArray(report.coins) || report.coins.length !== report.candidateCount || !report.coins.every(isObject)) {
    throw new Error("coins must be an object array matching candidateCount")
  }
}

function splitReport (report, id) {
  validateReport(report)
  const { coins, peerRadar, ...header } = report
  const histories = coins.flatMap((coin, coinIndex) => (
    Object.hasOwn(coin, "history") ? [{ coinIndex, history: coin.history }] : []
  ))
  const radar = Object.hasOwn(report, "peerRadar") ? [{ radar: peerRadar }] : []
  if (isObject(peerRadar?.histories)) {
    const { histories, ...rest } = peerRadar
    radar[0] = { radar: rest, histories: Object.entries(histories).map(([key, history]) => ({ key, history })) }
  }
  return {
    report: [{ report: header, manifest: { version: 1, id, coins: coins.length, history: histories.length, peerRadar: radar.length } }],
    coins: coins.map(coin => Object.fromEntries(Object.entries(coin).filter(([key]) => key !== "history"))),
    history: histories,
    peerRadar: radar,
  }
}

export async function createReportStore ({ directory = path.resolve("reports") } = {}) {
  directory = path.resolve(directory)
  await fs.mkdir(directory, { recursive: true })
  const instance = await DuckDBInstance.create(":memory:", { threads: "1", temp_directory: "" })
  let connection
  try {
    connection = await instance.connect()
  } catch (error) {
    instance.closeSync()
    throw error
  }
  const metadata = new Map()
  let pending = Promise.resolve()
  let closing

  function enqueue (operation) {
    if (closing) {
      return Promise.reject(new Error("Report store is closed"))
    }
    const result = pending.then(operation)
    pending = result.catch(() => {})
    return result
  }

  function archiveError (id, error) {
    return new Error(`Invalid report archive ${id} at ${path.join(directory, id)}: ${error.message}. Restore or remove this snapshot.`, { cause: error })
  }

  async function snapshotExists (id) {
    if (!isReportId(id)) {
      return false
    }
    try {
      return (await fs.lstat(path.join(directory, id))).isDirectory()
    } catch (error) {
      if (error.code === "ENOENT") {
        return false
      }
      throw error
    }
  }

  async function inspect (id) {
    const folder = path.join(directory, id)
    for (const name of ["report", "coins", "history", "peer-radar"]) {
      const filename = path.join(folder, `${name}.parquet`)
      if (!(await fs.lstat(filename)).isFile()) {
        throw new Error(`${filename}: expected a regular Parquet file`)
      }
    }
    // Project only metadata, never the report's descriptions, features, or time series.
    const result = await connection.runAndReadAll(`
      SELECT position, data.manifest AS manifest,
        data.report.reportCreatedAt AS reportCreatedAt, data.report.asOf AS asOf,
        data.report.candidateCount AS candidateCount, data.report.universeCoinCount AS universeCoinCount
      FROM read_parquet(?)
    `, [path.join(folder, "report.parquet")])
    const rows = result.getRowObjectsJS()
    if (rows.length !== 1) {
      throw new Error("report.parquet must contain exactly one report")
    }
    const { manifest, position, ...fields } = rows[0]
    if (position !== 0) {
      throw new Error("report.parquet must start at position 0")
    }
    validateMetadata(fields)
    if (
      manifest?.version !== 1 || manifest.id !== id || manifest.coins !== fields.candidateCount
      || !isSafeInteger(manifest.history) || manifest.history < 0 || manifest.history > manifest.coins
      || ![0, 1].includes(manifest.peerRadar)
    ) {
      throw new Error("report.parquet has an invalid or unsupported manifest")
    }
    for (const [name, count] of [["report", 1], ["coins", manifest.coins], ["history", manifest.history], ["peer-radar", manifest.peerRadar]]) {
      if (await parquetRowCount(connection, path.join(folder, `${name}.parquet`)) !== count) {
        throw new Error(`${name}.parquet row count does not match report.parquet`)
      }
    }
    return { id, ...fields }
  }

  return {
    async save (report) {
      // Capture at call time, before queued I/O, so later caller mutations cannot change a snapshot.
      const id = randomUUID()
      // DuckDB rejects lone UTF-16 surrogates, which can occur in truncated source text.
      const snapshot = JSON.parse(JSON.stringify(report, (_, value) => isString(value) ? value.toWellFormed() : value))
      const parts = splitReport(snapshot, id)
      return enqueue(async () => {
        const staging = await fs.mkdtemp(path.join(directory, `.report-${id}-`))
        const destination = path.join(directory, id)
        try {
          await writeParquet(connection, path.join(staging, "report.parquet"), parts.report)
          await writeParquet(connection, path.join(staging, "coins.parquet"), parts.coins, {
            symbol: null, movementProbability: 0, topRank: 0, features: {},
          })
          await writeParquet(connection, path.join(staging, "history.parquet"), parts.history, {
            coinIndex: 0,
            history: {
              candles: [{ time: 0, open: 0, high: 0, low: 0, close: 0 }],
              volume: [{ time: 0, value: 0 }],
              openInterest: [{ time: 0, value: 0 }],
              warning: null,
            },
          })
          await writeParquet(connection, path.join(staging, "peer-radar.parquet"), parts.peerRadar, {
            radar: { status: null, warning: null, data: { observations: [] } },
            histories: [{ key: "", history: { points: [{ time: 0, value: 0 }] } }],
          })
          await fs.rename(staging, destination)
          return { id, directory: destination }
        } catch (error) {
          await fs.rm(staging, { recursive: true, force: true })
          throw new Error(`Failed to save report ${id}: ${error.message}`, { cause: error })
        }
      })
    },

    read (id) {
      return enqueue(async () => {
        if (!await snapshotExists(id)) {
          return null
        }
        try {
          const fields = await inspect(id)
          const filename = name => path.join(directory, id, `${name}.parquet`)
          const [header] = await readParquet(connection, filename("report"))
          const coins = await readParquet(connection, filename("coins"))
          const histories = await readParquet(connection, filename("history"))
          const radar = await readParquet(connection, filename("peer-radar"))
          const report = { ...header.report, coins }
          validateReport(report)
          const assigned = new Set()
          for (const record of histories) {
            const { coinIndex, history } = record
            if (!isSafeInteger(coinIndex) || coinIndex < 0 || coinIndex >= coins.length || assigned.has(coinIndex) || !Object.hasOwn(record, "history")) {
              throw new Error(`history.parquet has an invalid or duplicate history for coinIndex: ${coinIndex}`)
            }
            coins[coinIndex].history = history
            assigned.add(coinIndex)
          }
          if (radar.length) {
            if (!Object.hasOwn(radar[0], "radar")) {
              throw new Error("peer-radar.parquet is missing its radar record")
            }
            report.peerRadar = radar[0].radar
            if (Object.hasOwn(radar[0], "histories")) {
              const entries = radar[0].histories
              if (
                !isArray(entries) || entries.some(entry => !isString(entry?.key) || !Object.hasOwn(entry, "history"))
                || new Set(entries.map(entry => entry.key)).size !== entries.length
              ) {
                throw new Error("peer-radar.parquet has invalid or duplicate history keys")
              }
              report.peerRadar.histories = Object.fromEntries(entries.map(({ key, history }) => [key, history]))
            }
          }
          metadata.set(id, Object.freeze(fields))
          return report
        } catch (error) {
          throw archiveError(id, error)
        }
      })
    },

    list () {
      return enqueue(async () => {
        const entries = await fs.readdir(directory, { withFileTypes: true })
        const ids = entries.filter(entry => entry.isDirectory() && isReportId(entry.name)).map(entry => entry.name)
        const result = []
        for (const id of ids) {
          if (!metadata.has(id)) {
            try {
              metadata.set(id, Object.freeze(await inspect(id)))
            } catch (error) {
              throw archiveError(id, error)
            }
          }
          result.push({ ...metadata.get(id) })
        }
        return result.sort((first, second) => second.reportCreatedAt.localeCompare(first.reportCreatedAt) || first.id.localeCompare(second.id))
      })
    },

    close () {
      closing ??= pending.then(() => {
        try {
          connection.closeSync()
        } finally {
          instance.closeSync()
        }
      })
      return closing
    },
  }
}
