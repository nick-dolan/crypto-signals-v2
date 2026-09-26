import { isArray, isBoolean, isFinite, isObject, isString } from "../helpers/utils.typed.js"

function sqlString (value) {
  return `'${value.replaceAll("'", "''")}'`
}

function numericSchema (schema) {
  if (isArray(schema)) {
    return schema.map(numericSchema)
  }
  if (isObject(schema)) {
    return Object.fromEntries(Object.entries(schema).map(([key, type]) => [key, numericSchema(type)]))
  }
  // JS numbers are doubles; untyped nulls also stay usable in numeric SQL expressions.
  return ["UBIGINT", "BIGINT", "DOUBLE", "NULL"].includes(schema) ? "DOUBLE" : schema
}

function containsNumber (value) {
  return isFinite(value) || ((isArray(value) || isObject(value)) && Object.values(value).some(containsNumber))
}

function prepareValue (value, schema, missing, location = []) {
  if (value === null) {
    return null
  }
  if (isArray(schema)) {
    return value.map((item, index) => prepareValue(item, schema[0], missing, [...location, index]))
  }
  if (isObject(schema)) {
    return Object.fromEntries(Object.entries(schema).map(([key, type]) => {
      if (!Object.hasOwn(value, key)) {
        missing.push([...location, key])
        return [key, null]
      }
      return [key, prepareValue(value[key], type, missing, [...location, key])]
    }))
  }
  if (schema === "JSON" && containsNumber(value)) {
    throw new Error(`Inconsistent types at ${JSON.stringify(location)}: numeric data must remain typed, not JSON`)
  }
  return value
}

function restoreValue (value, schema, label) {
  if (value === null) {
    return null
  }
  if (isArray(schema) && schema.length === 1 && isArray(value)) {
    return value.map(item => restoreValue(item, schema[0], label))
  }
  if (
    isObject(schema) && isObject(value)
    && Object.keys(schema).length === Object.keys(value).length
    && Object.keys(schema).every(key => Object.hasOwn(value, key))
  ) {
    return Object.fromEntries(Object.entries(schema).map(([key, type]) => [key, restoreValue(value[key], type, label)]))
  }
  if (schema === "JSON" && isString(value)) {
    return JSON.parse(value)
  }
  if (
    (schema === "DOUBLE" && isFinite(value)) || (schema === "BOOLEAN" && isBoolean(value))
    || (schema === "VARCHAR" && isString(value))
  ) {
    return value
  }
  throw new Error(`${label}: data does not match its stored Parquet schema`)
}

async function readSchema (connection, filename) {
  const result = await connection.runAndReadAll(`
    SELECT decode(value) AS schema FROM parquet_kv_metadata(?)
    WHERE decode(key) = 'report_store_schema'
  `, [filename])
  const rows = result.getRowObjectsJS()
  if (rows.length !== 1) {
    throw new Error(`${filename}: missing report_store_schema Parquet metadata`)
  }
  const schema = JSON.parse(rows[0].schema)
  if (!isObject(schema)) {
    throw new Error(`${filename}: invalid report_store_schema Parquet metadata`)
  }
  return schema
}

export async function writeParquet (connection, filename, rows, sample = {}) {
  const result = await connection.runAndReadAll(
    "SELECT json_group_structure(value) AS schema FROM json_each(?::JSON)",
    [JSON.stringify([...rows, sample])],
  )
  const schema = numericSchema(JSON.parse(result.getRowObjectsJS()[0].schema))
  if (!isObject(schema)) {
    throw new Error(`${filename}: expected structured records`)
  }
  const values = rows.map((value) => {
    const missing = []
    const data = prepareValue(value, schema, missing)
    return { data, missing: JSON.stringify(missing) }
  })

  // Only typed data and missing-key paths are persisted; the input JSON is an in-memory transport.
  await connection.run(`
    COPY (
      SELECT CAST(key AS INTEGER) AS position,
        json_transform_strict(value->'data', ${sqlString(JSON.stringify(schema))}) AS data,
        value->>'missing' AS missing
      FROM json_each(?::JSON)
      ORDER BY position
    ) TO ${sqlString(filename)} (
      FORMAT PARQUET, COMPRESSION ZSTD,
      KV_METADATA {report_store_schema: ${sqlString(JSON.stringify(schema))}}
    )
  `, [JSON.stringify(values)])
}

export async function parquetRowCount (connection, filename) {
  await readSchema(connection, filename)
  const result = await connection.runAndReadAll(
    "SELECT num_rows::DOUBLE AS count FROM parquet_file_metadata(?)", [filename],
  )
  return result.getRowObjectsJS()[0].count
}

export async function readParquet (connection, filename) {
  const schema = await readSchema(connection, filename)
  const result = await connection.runAndReadAll("SELECT * FROM read_parquet(?) ORDER BY position", [filename])
  return result.getRowObjectsJS().map((row, index) => {
    if (row.position !== index) {
      throw new Error(`${filename}: invalid row order at ${index}`)
    }
    const value = restoreValue(row.data, schema, `${filename} row ${index}`)
    const missing = JSON.parse(row.missing)
    if (!isArray(missing)) {
      throw new Error(`${filename}: invalid missing-key metadata at row ${index}`)
    }
    for (const location of missing) {
      if (!isArray(location) || !location.length) {
        throw new Error(`${filename}: invalid missing-key path at row ${index}`)
      }
      const parent = location.slice(0, -1).reduce((object, key) => (
        object != null && Object.hasOwn(object, key) ? object[key] : undefined
      ), value)
      const key = location.at(-1)
      if (!isObject(parent) || !Object.hasOwn(parent, key) || parent[key] !== null) {
        throw new Error(`${filename}: invalid missing-key path ${JSON.stringify(location)} at row ${index}`)
      }
      delete parent[key]
    }
    return value
  })
}
