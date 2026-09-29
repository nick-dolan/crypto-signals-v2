import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { setImmediate } from "node:timers/promises"

import { runPriceCharacterScan } from "../src/research/scan-price-characters.js"

async function fixture (t, symbols = ["PROVE", "AAA", "BBB", "CCC", "DDD"], analysisDays = 30) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "price-character-scan-"))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  let price = 100
  const snapshot = {
    source: "tradingview", symbol: "PROVE", marketSymbol: "BINANCE:PROVEUSDT.P", timeframe: "15m",
    endTime: 1_800_000_000, analysisDays, requestedDays: 90, collectedAt: "2027-01-15T08:00:00.000Z",
    periods: Array.from({ length: analysisDays * 96 + 97 }, (_, index) => {
      const open = price
      price *= Math.exp(Math.sin(index / 4) * 0.001 + 0.00005)
      return {
        time: 1_800_000_000 - (analysisDays * 96 + 97 - index) * 900,
        open, close: price, max: Math.max(open, price) * 1.0001, min: Math.min(open, price) * 0.9999, volume: 10000,
      }
    }),
  }
  const universe = {
    generatedAt: "2027-01-15T07:00:00.000Z",
    coins: symbols.map((symbol, index) => ({
      baseCurrencyId: `XTVC${symbol}`, symbol, name: `Synthetic ${symbol}`, rank: index + 1,
      market: { tradingViewSymbol: `BINANCE:${symbol}USDT.P` },
    })),
  }
  const options = {
    directory: path.join(root, "experiment"),
    referencePath: path.join(root, "reference-source.json"),
    universePath: path.join(root, "universe-source.json"),
    connect: async () => ({}), disconnect: async () => {},
    fetchPeriods: async () => [...snapshot.periods].reverse(),
  }
  await fs.writeFile(options.referencePath, JSON.stringify(snapshot))
  await fs.writeFile(options.universePath, JSON.stringify(universe))
  return { root, snapshot, universe, options }
}

function deferred () {
  let resolve
  const promise = new Promise((done) => {
    resolve = done
  })
  return { promise, resolve }
}

test("scan is resumable, freezes dates/universe, bounds concurrency, and cached mode needs neither network nor sources", async (t) => {
  const { snapshot, universe, options } = await fixture(t)
  let requests = 0, connections = 0, disconnections = 0, active = 0, maxActive = 0
  const live = {
    ...options,
    connect: async () => {
      connections++
      return {}
    },
    disconnect: async () => {
      disconnections++
    },
    fetchPeriods: async (_, request) => {
      requests++
      maxActive = Math.max(maxActive, ++active)
      assert.deepEqual(request, {
        symbol: request.symbol, timeframe: "15", range: 30 * 96 + 98,
        to: snapshot.endTime - 1, timeoutMs: 45_000, settleDelayMs: 1_000,
      })
      assert.notEqual(request.symbol, "BINANCE:PROVEUSDT.P")
      await setImmediate()
      active--
      return [...snapshot.periods].reverse()
    },
  }
  const first = await runPriceCharacterScan({ ...live, limit: 1 })
  assert.deepEqual(first.coverage, { total: 5, loaded: 2, failed: 0, pending: 3, eligible: 1 })
  assert.equal(requests, 1)
  assert.equal(first.pending.length, 3)
  const savedAnchor = await fs.readFile(path.join(options.directory, "reference.json"), "utf8")
  await fs.writeFile(options.referencePath, JSON.stringify({ ...snapshot, endTime: snapshot.endTime + 900 }))
  await fs.writeFile(options.universePath, JSON.stringify({ coins: [] }))
  const completed = await runPriceCharacterScan(live)
  assert.equal(completed.coverage.total, 5)
  assert.equal(completed.coverage.loaded, 5)
  assert.equal(completed.coverage.pending, 0)
  assert.equal(completed.universeGeneratedAt, universe.generatedAt)
  assert.equal(maxActive, 3)
  assert.equal(requests, 4)
  assert.equal(connections, 2)
  assert.equal(disconnections, 2)
  assert.equal(await fs.readFile(path.join(options.directory, "reference.json"), "utf8"), savedAnchor)
  await fs.rm(options.referencePath)
  await fs.rm(options.universePath)
  const offline = await runPriceCharacterScan({
    ...options, cached: true,
    connect: () => assert.fail("Cached mode connected"),
    fetchPeriods: () => assert.fail("Cached mode fetched data"),
    disconnect: () => assert.fail("Cached mode disconnected without connecting"),
  })
  assert.deepEqual(offline.closest, completed.closest)
  assert.deepEqual(offline.coverage, completed.coverage)
  assert.equal(offline.endTime, snapshot.endTime)
  const html = await fs.readFile(path.join(options.directory, "report.html"), "utf8")
  const payload = JSON.parse(html.match(/<script id="comparison-data" type="application\/json">([\s\S]*?)<\/script>/)[1])
  assert.deepEqual(payload.charts.map(chart => chart.baseCurrencyId).sort(), ["XTVCPROVE", ...offline.closest].sort())
  assert.ok(payload.charts.every(chart => chart.candles.length === 30 * 96 && chart.previousClose === snapshot.periods[96].close))
})

test("failed and incomplete histories are recorded, not ranked or retried implicitly; explicit retry repairs them", async (t) => {
  const { snapshot, options } = await fixture(t, ["PROVE", "AAA", "BBB", "CCC"])
  const first = await runPriceCharacterScan({
    ...options,
    fetchPeriods: async (_, request) => {
      if (request.symbol.includes("AAA")) {
        throw new Error("Synthetic timeout")
      }
      return request.symbol.includes("BBB") ? snapshot.periods.slice(1) : snapshot.periods
    },
  })
  assert.equal(first.coverage.loaded, 2)
  assert.equal(first.coverage.failed, 2)
  assert.equal(first.coverage.pending, 0)
  assert.deepEqual(first.closest, ["XTVCCCC"])
  assert.match(first.rejected[0].reason, /timeout/)
  assert.match(first.rejected[1].reason, /Incomplete 15m history/)
  const unchanged = await runPriceCharacterScan({ ...options, connect: () => assert.fail("Unexpected retry") })
  assert.equal(unchanged.rejected.length, 2)
  const requests = []
  const repaired = await runPriceCharacterScan({
    ...options, retryFailed: true,
    fetchPeriods: async (_, request) => {
      requests.push(request.symbol)
      return snapshot.periods
    },
  })
  assert.deepEqual(requests.sort(), ["BINANCE:AAAUSDT.P", "BINANCE:BBBUSDT.P"])
  assert.equal(repaired.rejected.length, 0)
  assert.equal(repaired.coverage.loaded, 4)
  await assert.rejects(runPriceCharacterScan({ ...options, cached: true, retryFailed: true }), /cannot be combined/)
})

test("stale identity, malformed JSON and gaps in cached candles cannot enter the comparison", async (t) => {
  const { options } = await fixture(t, ["PROVE", "AAA", "BBB", "CCC"])
  await runPriceCharacterScan(options)
  const aaa = path.join(options.directory, "candles", "XTVCAAA.json")
  const changed = JSON.parse(await fs.readFile(aaa, "utf8"))
  changed.endTime += 900
  await fs.writeFile(aaa, JSON.stringify(changed))
  await fs.writeFile(path.join(options.directory, "candles", "XTVCBBB.json"), "not JSON")
  const ccc = path.join(options.directory, "candles", "XTVCCCC.json")
  const incomplete = JSON.parse(await fs.readFile(ccc, "utf8"))
  incomplete.periods.splice(200, 1)
  await fs.writeFile(ccc, JSON.stringify(incomplete))
  const result = await runPriceCharacterScan({ ...options, cached: true })
  assert.equal(result.coverage.loaded, 1)
  assert.equal(result.coverage.failed, 3)
  assert.deepEqual(result.closest, [])
  assert.deepEqual(result.calmer, [])
  assert.ok(result.rejected.some(entry => /frozen reference dates/.test(entry.reason)))
  assert.ok(result.rejected.some(entry => /Incomplete 15m history/.test(entry.reason)))
})

test("connection failure is cleaned up and a disconnected client leaves unattempted coins pending", async (t) => {
  const { options } = await fixture(t)
  let disconnections = 0
  await assert.rejects(runPriceCharacterScan({
    ...options,
    connect: async () => {
      throw new Error("No connection")
    },
    disconnect: async () => {
      disconnections++
    },
  }), /No connection/)
  assert.equal(disconnections, 1)
  const result = await runPriceCharacterScan({
    ...options,
    connect: async () => ({ isOpen: false }),
    disconnect: async () => {
      disconnections++
    },
    fetchPeriods: () => assert.fail("Disconnected client fetched data"),
  })
  assert.equal(disconnections, 2)
  assert.equal(result.coverage.loaded, 1)
  assert.equal(result.coverage.pending, 4)
  assert.equal(result.coverage.failed, 0)
})

test("unsafe or duplicate universe keys and mismatched reference identity fail before network access", async (t) => {
  const { root, universe, options } = await fixture(t)
  for (const [index, coins] of [
    [...universe.coins, universe.coins[1]],
    universe.coins.map((coin, index) => index ? { ...coin, baseCurrencyId: "../escape" } : coin),
    universe.coins.filter(coin => coin.symbol !== "PROVE"),
  ].entries()) {
    await fs.writeFile(options.universePath, JSON.stringify({ ...universe, coins }))
    await assert.rejects(runPriceCharacterScan({
      ...options, directory: path.join(root, `invalid-${index}`), connect: () => assert.fail("Invalid universe connected"),
    }), /Duplicate|safe unique|PROVE must be present/)
  }
  await assert.rejects(runPriceCharacterScan({ ...options, limit: 0 }), /limit must be positive/)
})

test("validated 58d candles win over an interrupted retry error checkpoint without fetching again", async (t) => {
  const { snapshot, options } = await fixture(t, ["PROVE", "AAA"], 58)
  await runPriceCharacterScan(options)
  const candlesPath = path.join(options.directory, "candles", "XTVCAAA.json")
  const resultPath = path.join(options.directory, "results", "XTVCAAA.json")
  const candlesBefore = await fs.readFile(candlesPath, "utf8")
  const previous = JSON.parse(await fs.readFile(resultPath, "utf8"))
  await fs.writeFile(resultPath, JSON.stringify({ ...previous, status: "error", reason: "Old timeout before retry" }))
  const resume = {
    ...options,
    connect: () => assert.fail("Valid cached candles triggered a connection"),
    fetchPeriods: () => assert.fail("Valid cached candles were fetched again"),
    disconnect: () => assert.fail("No connection should have been opened"),
  }
  const recovered = await runPriceCharacterScan(resume)
  assert.deepEqual(recovered.coverage, { total: 2, loaded: 2, failed: 0, pending: 0, eligible: 1 })
  assert.equal(recovered.analysisDays, 58)
  assert.equal(recovered.endTime, snapshot.endTime)
  assert.deepEqual(recovered.candidates[0].profile.windows.map(window => window.days), [7, 30, 58])
  assert.equal(await fs.readFile(candlesPath, "utf8"), candlesBefore)
  assert.deepEqual((await runPriceCharacterScan({ ...resume, cached: true })).coverage, recovered.coverage)

  const invalid = JSON.parse(candlesBefore)
  invalid.endTime += 900
  await fs.writeFile(candlesPath, JSON.stringify(invalid))
  const rejected = await runPriceCharacterScan({ ...resume, cached: true })
  assert.equal(rejected.coverage.failed, 1)
  assert.equal(rejected.coverage.loaded, 1)
  assert.match(rejected.rejected[0].reason, /frozen reference dates/)
})

test("JSON null and other nonobjects are corrupted caches, while ENOENT alone remains pending", async (t) => {
  const { options } = await fixture(t, ["PROVE", "NULL", "FALSE", "ZERO", "TEXT", "ARRAY", "RESULT", "MISSING"])
  await runPriceCharacterScan({ ...options, limit: 1 })
  for (const [symbol, body] of [["NULL", "null"], ["FALSE", "false"], ["ZERO", "0"], ["TEXT", "\"text\""], ["ARRAY", "[]"]]) {
    await fs.writeFile(path.join(options.directory, "candles", `XTVC${symbol}.json`), body)
  }
  await fs.writeFile(path.join(options.directory, "results", "XTVCRESULT.json"), "null")
  const result = await runPriceCharacterScan({
    ...options, cached: true,
    connect: () => assert.fail("Cached corruption check connected"),
    fetchPeriods: () => assert.fail("Corrupt cache was implicitly retried"),
    disconnect: () => assert.fail("Cached corruption check disconnected"),
  })
  assert.deepEqual(result.coverage, { total: 8, loaded: 1, failed: 6, pending: 1, eligible: 0 })
  assert.deepEqual(result.pending.map(coin => coin.baseCurrencyId), ["XTVCMISSING"])
  assert.ok(result.rejected.every(entry => /Expected a JSON object/.test(entry.reason)))
  const checkpoint = JSON.parse(await fs.readFile(path.join(options.directory, "results", "XTVCNULL.json"), "utf8"))
  assert.equal(checkpoint.status, "error")
  assert.match(checkpoint.reason, /Expected a JSON object/)
})

test("an interrupted freeze copy never publishes a partial anchor and cleans its own same-directory temp", async (t) => {
  const { snapshot, options } = await fixture(t, ["PROVE"])
  const frozen = path.join(options.directory, "reference.json")
  const copyFile = fs.copyFile
  const failure = new Error("Interrupted freeze copy")
  let temporary
  const copy = t.mock.method(fs, "copyFile", async (source, destination, flags) => {
    if (source !== options.referencePath) {
      return copyFile(source, destination, flags)
    }
    assert.notEqual(destination, frozen)
    assert.equal(path.dirname(destination), options.directory)
    temporary = destination
    await fs.writeFile(destination, "{\"source\":")
    throw failure
  })
  await assert.rejects(runPriceCharacterScan({ ...options, cached: true }), error => error === failure)
  await assert.rejects(fs.stat(frozen), { code: "ENOENT" })
  await assert.rejects(fs.stat(temporary), { code: "ENOENT" })
  assert.deepEqual((await fs.readdir(options.directory)).sort(), ["candles", "results"])
  copy.mock.restore()

  const resumed = await runPriceCharacterScan({ ...options, cached: true })
  assert.equal(resumed.coverage.loaded, 1)
  assert.deepEqual(JSON.parse(await fs.readFile(frozen, "utf8")), snapshot)
  assert.deepEqual((await fs.readdir(options.directory)).filter(name => name.endsWith(".tmp")), [])
})

test("freeze validates JSON objects before publication and can resume after fixing an invalid source", async (t) => {
  for (const [sourceKey, filename, body] of [["referencePath", "reference.json", "null"], ["universePath", "universe.json", "{"]]) {
    const { snapshot, universe, options } = await fixture(t, ["PROVE"])
    await fs.writeFile(options[sourceKey], body)
    await assert.rejects(runPriceCharacterScan({ ...options, cached: true }), /JSON/)
    const frozen = path.join(options.directory, filename)
    await assert.rejects(fs.stat(frozen), { code: "ENOENT" })
    assert.deepEqual((await fs.readdir(options.directory)).filter(name => name.endsWith(".tmp")), [])

    const original = sourceKey === "referencePath" ? snapshot : universe
    await fs.writeFile(options[sourceKey], JSON.stringify(original))
    await runPriceCharacterScan({ ...options, cached: true })
    assert.deepEqual(JSON.parse(await fs.readFile(frozen, "utf8")), original)
  }
})

test("freeze publishes a complete temp exclusively and preserves a concurrently published winner", async (t) => {
  const { snapshot, universe, options } = await fixture(t, ["PROVE"])
  const frozen = path.join(options.directory, "reference.json")
  const winner = { ...snapshot, collectedAt: "2027-01-15T06:00:00.000Z" }
  const temporaries = []
  const link = fs.link
  t.mock.method(fs, "link", async (source, destination) => {
    assert.notEqual(source, destination)
    assert.equal(path.dirname(source), path.dirname(destination))
    temporaries.push(source)
    const data = JSON.parse(await fs.readFile(source, "utf8"))
    if (destination === frozen) {
      assert.deepEqual(data, snapshot)
      await fs.writeFile(destination, JSON.stringify(winner), { flag: "wx" })
    } else {
      assert.deepEqual(data, universe)
    }
    return link(source, destination)
  })
  const report = await runPriceCharacterScan({ ...options, cached: true })
  assert.equal(report.reference.profile.collectedAt, winner.collectedAt)
  assert.deepEqual(JSON.parse(await fs.readFile(frozen, "utf8")), winner)
  assert.equal(temporaries.length, 2)
  for (const temporary of temporaries) {
    await assert.rejects(fs.stat(temporary), { code: "ENOENT" })
  }
})

test("fatal cache writes stop dispatch and drain all active workers before disconnect and rejection", async (t) => {
  for (const folder of ["candles", "results"]) {
    await t.test(folder, { timeout: 10_000 }, async (t) => {
      const { snapshot, options } = await fixture(t)
      const blocked = deferred()
      const failedWrite = deferred()
      const completedWorkers = deferred()
      const client = { isOpen: true }
      const failure = new Error(`Synthetic ${folder} write failure`)
      const requests = []
      const events = []
      let settled = false, disconnections = 0, completed = 0
      const rename = fs.rename
      t.mock.method(fs, "rename", async (source, destination) => {
        if (destination === path.join(options.directory, folder, "XTVCAAA.json")) {
          failedWrite.resolve()
          throw failure
        }
        return rename(source, destination)
      })
      const running = runPriceCharacterScan({
        ...options,
        connect: async () => client,
        disconnect: async () => {
          disconnections++
          client.isOpen = false
          events.push("disconnect")
        },
        fetchPeriods: async (_, request) => {
          requests.push(request.symbol)
          if (request.symbol !== "BINANCE:AAAUSDT.P") {
            await blocked.promise
          }
          return snapshot.periods
        },
        onProgress: (event) => {
          if (event.status === "ok") {
            events.push(event.coin.symbol)
            if (["BBB", "CCC"].includes(event.coin.symbol) && ++completed === 2) {
              completedWorkers.resolve()
            }
          }
        },
      }).then(value => ({ value }), error => ({ error })).finally(() => {
        settled = true
      })
      let beforeRelease
      try {
        await failedWrite.promise
        await setImmediate()
        beforeRelease = { settled, disconnections }
      } finally {
        blocked.resolve()
      }
      await completedWorkers.promise
      const outcome = await running
      assert.deepEqual(beforeRelease, { settled: false, disconnections: 0 })
      assert.equal(outcome.error, failure)
      assert.equal(disconnections, 1)
      assert.deepEqual(requests, ["BINANCE:AAAUSDT.P", "BINANCE:BBBUSDT.P", "BINANCE:CCCUSDT.P"])
      assert.deepEqual(events.slice(0, -1).sort(), ["BBB", "CCC"])
      assert.equal(events.at(-1), "disconnect")
      for (const symbol of ["BBB", "CCC"]) {
        const result = JSON.parse(await fs.readFile(path.join(options.directory, "results", `XTVC${symbol}.json`), "utf8"))
        assert.equal(result.status, "ok")
      }
      await assert.rejects(fs.stat(path.join(options.directory, "candles", "XTVCDDD.json")), { code: "ENOENT" })
      await assert.rejects(fs.stat(path.join(options.directory, "results", "XTVCDDD.json")), { code: "ENOENT" })
    })
  }
})
