import assert from "node:assert/strict"
import path from "node:path"
import test from "node:test"

import { createCoinHistoryTool } from "../src/steps/step7-agent-analysis/create-coin-history-tool.js"

function createInput () {
  const latestTime = 1_800_000_000
  const times = Array.from(
    { length: 14 },
    (_, index) => latestTime - (13 - index) * 3_600,
  )
  const periods = times.map((time, index) => ({
    time,
    open: 100 + index,
    max: 102 + index,
    min: 99 + index,
    close: 101 + index,
    volume: 1_000 + index,
  }))
  const payload = {
    schemaVersion: 2,
    asOf: new Date((latestTime - 3_600) * 1_000).toISOString(),
    timeframe: "1h",
    candidateCount: 1,
    schema: ["symbol"],
    candidates: [["SOL"]],
  }
  const shortlist = {
    asOf: payload.asOf,
    timeframe: "1h",
    candidateCount: 1,
    candidates: [{
      coin: {
        symbol: "SOL",
        baseCurrencyId: "XTVCSOL",
      },
    }],
  }
  const hourlyData = {
    coin: { symbol: "SOL" },
    timeframe: "1h",
    chart: { periods },
    studies: {
      volumeDelta: {
        periods: times.map((time, index) => ({ time, close: index * 10 })),
      },
      openInterest: {
        periods: times.map((time, index) => ({ time, close: 10_000 + index })),
      },
    },
  }

  return { payload, shortlist, hourlyData, times }
}

test("coin history tool lazily returns only requested rows and fields", async () => {
  const { payload, shortlist, hourlyData, times } = createInput()
  let requestedPath
  const tool = createCoinHistoryTool(payload, shortlist, {
    readCoinData: async (relativePath) => {
      requestedPath = relativePath
      return hourlyData
    },
  })

  assert.equal(tool.name, "get_coin_history")
  assert.equal(tool.skipPermission, true)
  assert.equal(tool.defer, "never")
  assert.deepEqual(tool.parameters.properties.symbol.enum, ["SOL"])

  const result = await tool.handler({
    symbol: "SOL",
    fields: ["close", "volumeDelta", "openInterest"],
    hours: 12,
  })
  const history = JSON.parse(result.textResultForLlm)

  assert.equal(result.resultType, "success")
  assert.equal(
    requestedPath,
    path.join("step2-data-bootstrap", "SOL--XTVCSOL", "data.json"),
  )
  assert.deepEqual(history.schema, [
    "time",
    "close",
    "volumeDelta",
    "openInterest",
  ])
  assert.equal(history.rows.length, 12)
  assert.equal(history.rows[0][0], times[1])
  assert.deepEqual(history.rows.at(-1), [
    times.at(-2),
    113,
    120,
    10_012,
  ])
})

test("coin history tool rejects invalid requests and limits total calls", async () => {
  const { payload, shortlist, hourlyData } = createInput()
  const tool = createCoinHistoryTool(payload, shortlist, {
    readCoinData: async () => hourlyData,
  })
  const invalid = await tool.handler({
    symbol: "BTC",
    fields: ["close"],
    hours: 12,
  })

  assert.equal(invalid.resultType, "failure")
  assert.match(invalid.error, /отсутствует/)

  for (let index = 0; index < 4; index += 1) {
    const result = await tool.handler({
      symbol: "SOL",
      fields: ["close"],
      hours: 12,
    })

    assert.equal(result.resultType, "success")
  }

  const limited = await tool.handler({
    symbol: "SOL",
    fields: ["close"],
    hours: 12,
  })

  assert.equal(limited.resultType, "failure")
  assert.match(limited.error, /не более пяти/)
})
