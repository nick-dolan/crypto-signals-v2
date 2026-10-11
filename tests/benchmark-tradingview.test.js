import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import test, { after, before, beforeEach, mock } from "node:test"
import dotenv from "dotenv"
import { isFinite } from "../src/helpers/utils.typed.js"
import { createCoverageStudyRequests } from "../src/steps/step2-data-bootstrap/coverage-study-definitions.js"

let runTradingViewBenchmark
let environment
let networkGuards

before(async () => {
  // Keep import-time dotenv and error redaction away from real credentials.
  environment = process.env
  process.env = {}
  mock.method(dotenv, "config", () => ({ parsed: {} }))
  networkGuards = [
    mock.method(globalThis, "fetch", () => assert.fail("Unexpected fetch request")),
    mock.method(net.Socket.prototype, "connect", () => assert.fail("Unexpected socket connection")),
  ]
  const benchmark = await import("../src/research/benchmark-tradingview.js")
  runTradingViewBenchmark = benchmark.runTradingViewBenchmark
})

after(() => {
  try {
    for (const guard of networkGuards ?? []) {
      assert.equal(guard.mock.callCount(), 0)
    }
  } finally {
    mock.restoreAll()
    process.env = environment
  }
})

beforeEach((context) => {
  context.mock.method(console, "log", () => {})
})

function createCoin (rank) {
  return {
    rank, baseCurrencyId: `OFFLINE${rank}`, symbol: `COIN${rank}`, name: `Offline coin ${rank}`,
    tradingViewSymbol: `CRYPTO:COIN${rank}USD`, categories: [],
    circulatingSupply: 1_000_000, marketCap: 10_000_000, fullyDilutedValuation: 20_000_000,
    market: { baseCurrencyId: `OFFLINE${rank}`, tradingViewSymbol: `BINANCE:COIN${rank}USDT.P` },
  }
}

async function writeJson (file, value) {
  await fs.writeFile(file, JSON.stringify(value), "utf8")
}

async function createFixture (context, coins = [3, 1, 5, 2, 4].map(createCoin)) {
  const container = await fs.mkdtemp(path.join(os.tmpdir(), "benchmark-tradingview-test-"))
  context.after(() => fs.rm(container, { recursive: true, force: true }))
  const directory = path.join(container, "benchmark")
  await fs.mkdir(path.join(directory, "inputs"), { recursive: true })
  const universeFile = path.join(directory, "inputs", "step1-crypto-universe.json")
  const referenceFile = path.join(directory, "inputs", "step3-market-context.json")
  const nowTimestamp = 1_800_000_123
  await writeJson(universeFile, { source: "offline", selection: {}, coins })
  await writeJson(referenceFile, { collectedAt: new Date(nowTimestamp * 1_000).toISOString() })
  return {
    directory, coins, nowTimestamp, universeFile, referenceFile,
    run: (connection, options = {}) => runTradingViewBenchmark({ directory, concurrency: 1, ...options }, connection),
  }
}

function expectedTimes (hours, nowTimestamp) {
  const currentHour = Math.floor(nowTimestamp / 3_600) * 3_600
  return Array.from({ length: hours }, (_, index) => currentHour - (hours - index) * 3_600)
}

function createPeriods (hours, values, nowTimestamp) {
  const times = expectedTimes(hours, nowTimestamp)
  return [
    { time: times[0] - 3_600, ...values },
    ...times.map(time => ({ time, ...values })),
    ...[times.at(-1) + 3_600, times.at(-1) + 7_200].map(time => ({
      time, ...Object.fromEntries(Object.keys(values).map(field => [field, null])),
    })),
  ].reverse()
}

function createChartData (coin, requests, nowTimestamp) {
  return {
    chart: {
      info: { fullName: coin.market.tradingViewSymbol, baseCurrencyId: coin.baseCurrencyId },
      periods: createPeriods(2_400, { open: 1, max: 2, min: 0.5, close: 1.5, volume: 0 }, nowTimestamp),
    },
    studies: Object.fromEntries(requests.map(request => [request.key, {
      status: "fulfilled",
      value: {
        request, fields: request.fields,
        periods: createPeriods(
          request.key === "volumeDelta" ? 1_666 : 2_400,
          Object.fromEntries(Object.keys(request.fields).map(field => [field, 0])),
          nowTimestamp,
        ),
      },
    }])),
  }
}

function createConnection (context, fixture, transform = data => data) {
  let onError
  let onDisconnected
  const client = {
    onError (callback) {
      onError = callback
    },
    onDisconnected (callback) {
      onDisconnected = callback
    },
  }
  return {
    client,
    emitError: (...messages) => onError(...messages),
    emitDisconnected: () => onDisconnected(),
    connect: context.mock.fn(async () => client),
    disconnect: context.mock.fn(async () => onDisconnected?.()),
    fetchChartStudies: context.mock.fn(async (connected, requests, options) => {
      assert.equal(connected, client)
      const coin = fixture.coins.find(candidate => candidate.market.tradingViewSymbol === options.symbol)
      assert.ok(coin, "Request must use a frozen coin's market")
      assert.equal(options.timeframe, "60")
      assert.equal(options.range, 2_401)
      assert.equal(options.to, Math.floor(fixture.nowTimestamp / 3_600) * 3_600 - 1)
      assert.deepEqual(requests, createCoverageStudyRequests(coin.tradingViewSymbol))
      return transform(createChartData(coin, requests, fixture.nowTimestamp), coin)
    }),
  }
}

function inside (directory, file) {
  const relative = path.relative(directory, file)
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

for (const concurrency of [1, 2, 3, 8]) {
  test(`benchmark caps concurrency at ${concurrency} and keeps rank order despite out-of-order completion`, { timeout: 10_000 }, async (context) => {
    const fixture = await createFixture(context)
    const started = Array.from({ length: 4 }, () => Promise.withResolvers())
    const gates = Array.from({ length: 4 }, () => Promise.withResolvers())
    const completed = []
    const activeAtDisconnect = []
    let startedCount = 0
    let active = 0
    let peak = 0
    const connection = createConnection(context, fixture, async (data, coin) => {
      const index = startedCount++
      peak = Math.max(peak, ++active)
      started[index]?.resolve()
      await gates[index]?.promise
      active--
      completed.push(coin.baseCurrencyId)
      return data
    })
    connection.disconnect = context.mock.fn(async () => {
      activeAtDisconnect.push(active)
      connection.emitDisconnected()
    })
    const running = fixture.run(connection, { concurrency, count: 4 })
    try {
      const capacity = Math.min(concurrency, 4)
      await started[capacity - 1].promise
      assert.equal(connection.fetchChartStudies.mock.callCount(), capacity)
      assert.equal(active, capacity)
      assert.equal(connection.disconnect.mock.callCount(), 0)
      for (let index = capacity; index < 4; index++) {
        gates[index - 1].resolve()
        await started[index].promise
        assert.equal(active, capacity)
      }
      for (const gate of gates.toReversed()) {
        gate.resolve()
      }
      const { metrics } = await running
      const rankedIds = [1, 2, 3, 4].map(rank => createCoin(rank).baseCurrencyId)
      assert.deepEqual(metrics.results.map(result => result.baseCurrencyId), rankedIds)
      if (concurrency > 1) {
        assert.notDeepEqual(completed, rankedIds)
      }
      assert.equal(peak, capacity)
      assert.equal(metrics.maxActive, peak)
      assert.equal(connection.connect.mock.callCount(), 1)
      assert.equal(connection.disconnect.mock.callCount(), 1)
      assert.deepEqual(activeAtDisconnect, [0])
      assert.equal(metrics.acceptedCount, 4)
      assert.equal(metrics.unexpectedDisconnects, 0)
      assert.equal(metrics.success, true)
      assert.ok([metrics.connectionTimeMs, metrics.wallTimeMs, metrics.totalTimeMs].every(isFinite))
    } finally {
      for (const gate of gates) {
        gate.resolve()
      }
      await running
    }
  })
}

for (const failure of ["client error", "disconnect", "chart limiter", "study limiter", "empty client error"]) {
  test(`benchmark stops queued work after ${failure}, drains active work and never reconnects`, { timeout: 10_000 }, async (context) => {
    const fixture = await createFixture(context)
    const started = Promise.withResolvers()
    const firstFinished = Promise.withResolvers()
    const gates = [Promise.withResolvers(), Promise.withResolvers()]
    console.log.mock.mockImplementation((message) => {
      if (message.includes(" COIN1 ")) {
        firstFinished.resolve()
      }
    })
    const completed = []
    const activeAtDisconnect = []
    let calls = 0
    let active = 0
    const connection = createConnection(context, fixture, async (data, coin) => {
      const index = calls++
      active++
      if (index === 1) {
        started.resolve()
      }
      try {
        await gates[index]?.promise
        if (index === 0 && failure === "chart limiter") {
          throw new Error("429 Too many chart requests")
        }
        if (index === 0 && failure === "study limiter") {
          data.studies.activeContributors = { status: "rejected", reason: new Error("Study quota exceeded") }
        }
        return data
      } finally {
        active--
        completed.push(coin.baseCurrencyId)
      }
    })
    connection.disconnect = context.mock.fn(async () => {
      activeAtDisconnect.push(active)
      connection.emitDisconnected()
    })
    const running = fixture.run(connection, { concurrency: 2 })
    try {
      await started.promise
      if (failure === "client error") {
        connection.emitError(new Error("Shared client failed"), "offline transport")
      } else if (failure === "empty client error") {
        connection.emitError(new Error(""))
      } else if (failure === "disconnect") {
        connection.emitDisconnected()
      }
      assert.equal(connection.disconnect.mock.callCount(), 0)
      gates[0].resolve()
      await firstFinished.promise
      assert.equal(active, 1, "The second request is still held behind its barrier")
      assert.equal(connection.disconnect.mock.callCount(), 0, "Disconnect must wait for the remaining active request")
      gates[1].resolve()
      const { metrics } = await running
      assert.equal(connection.fetchChartStudies.mock.callCount(), 2, "Only already active requests may finish")
      assert.equal(connection.connect.mock.callCount(), 1)
      assert.equal(connection.disconnect.mock.callCount(), 1)
      assert.deepEqual(activeAtDisconnect, [0])
      assert.deepEqual(completed.sort(), ["OFFLINE1", "OFFLINE2"])
      assert.deepEqual(metrics.results.map(result => result.baseCurrencyId), [1, 2, 3, 4, 5].map(rank => `OFFLINE${rank}`))
      assert.deepEqual(metrics.results.map(result => result.skipped), [false, false, true, true, true])
      assert.equal(metrics.skippedCount, 3)
      assert.equal(metrics.success, false)
      assert.notEqual(metrics.stopReason, null)
      assert.equal(metrics.unexpectedDisconnects, failure === "disconnect" ? 1 : 0)
      assert.equal(metrics.clientErrors.length, failure.includes("client error") ? 1 : 0)
      if (failure === "study limiter") {
        assert.equal(metrics.results[0].complete, true, "Optional social failure must not hide the limiter")
        assert.equal(metrics.studyErrorCount, 1)
      }
    } finally {
      for (const gate of gates) {
        gate.resolve()
      }
      await running
    }
  })
}

test("ordinary chart failures reject one coin without retries or stopping other coins", async (context) => {
  const fixture = await createFixture(context, [3, 1, 2].map(createCoin))
  const connection = createConnection(context, fixture, (data, coin) => {
    if (coin.rank === 1) {
      throw new Error("Chart unavailable")
    }
    return data
  })
  const { resultDirectory, metrics } = await fixture.run(connection)
  assert.equal(connection.fetchChartStudies.mock.callCount(), 3)
  assert.equal(connection.connect.mock.callCount(), 1)
  assert.equal(connection.disconnect.mock.callCount(), 1)
  assert.equal(metrics.stopReason, null)
  assert.equal(metrics.rejectedCount, 1)
  assert.equal(metrics.acceptedCount, 2)
  assert.equal(metrics.skippedCount, 0)
  assert.equal(metrics.results[0].error, "Chart unavailable")
  assert.deepEqual(await fs.readdir(path.join(resultDirectory, "step2-data-bootstrap")), ["COIN2--OFFLINE2", "COIN3--OFFLINE3"])
  assert.equal(metrics.success, false)
})

test("disconnect waits for active snapshot writes, not just fetched charts", { timeout: 10_000 }, async (context) => {
  const fixture = await createFixture(context, [createCoin(1)])
  const saving = Promise.withResolvers()
  const gate = Promise.withResolvers()
  const writeFile = fs.writeFile
  context.mock.method(fs, "writeFile", async (file, ...args) => {
    if (path.basename(file) === "data.json") {
      saving.resolve()
      await gate.promise
    }
    return writeFile(file, ...args)
  })
  const connection = createConnection(context, fixture)
  const running = fixture.run(connection)
  try {
    await saving.promise
    assert.equal(connection.disconnect.mock.callCount(), 0)
    gate.resolve()
    const { metrics } = await running
    assert.equal(connection.disconnect.mock.callCount(), 1)
    assert.equal(metrics.success, true)
  } finally {
    gate.resolve()
    await running
  }
})

test("snapshots stay isolated, preserve 2400/1666 closed hours and match a baseline at another concurrency", async (context) => {
  const fixture = await createFixture(context, [createCoin(1)])
  const originalInputs = await Promise.all([fixture.universeFile, fixture.referenceFile].map(file => fs.readFile(file, "utf8")))
  const sparseLiquidations = (data) => {
    const times = expectedTimes(2_400, fixture.nowTimestamp)
    const study = data.studies.liquidations.value
    study.periods = study.periods.filter(period => period.time === times[0] || period.time === times.at(-1))
    return data
  }
  const first = await fixture.run(createConnection(context, fixture, sparseLiquidations))
  const baseline = path.join(first.resultDirectory, "metrics.json")
  const baselineBytes = await fs.readFile(baseline, "utf8")
  const second = await fixture.run(createConnection(context, fixture, sparseLiquidations), { concurrency: 3, baseline })
  assert.notEqual(first.resultDirectory, second.resultDirectory)
  for (const { resultDirectory, metrics } of [first, second]) {
    assert.equal(inside(fixture.directory, resultDirectory), true)
    assert.deepEqual(await fs.readdir(resultDirectory), ["metrics.json", "step2-data-bootstrap"])
    assert.deepEqual(await fs.readdir(path.join(resultDirectory, "step2-data-bootstrap")), ["COIN1--OFFLINE1"])
    assert.deepEqual(await fs.readdir(path.join(resultDirectory, "step2-data-bootstrap", "COIN1--OFFLINE1")), ["data.json"])
    const [result] = metrics.results
    assert.equal(inside(resultDirectory, result.dataFile), true)
    const data = JSON.parse(await fs.readFile(result.dataFile, "utf8"))
    assert.equal(data.collectedAt, new Date(fixture.nowTimestamp * 1_000).toISOString())
    assert.equal(data.requestedHours, 2_400)
    assert.equal(data.availability.social.status, "available")
    for (const [key, source] of [["ohlcv", data.chart], ...Object.entries(data.studies)]) {
      const times = expectedTimes(key === "volumeDelta" ? 1_666 : 2_400, fixture.nowTimestamp)
      assert.deepEqual(source.periods.map(period => period.time), times, key)
      assert.equal(result.saved[key].periodCount, times.length)
      assert.equal(result.saved[key].firstTime, times[0])
      assert.equal(result.saved[key].lastTime, times.at(-1))
      assert.equal(result.saved[key].gridHash, createHash("sha256").update(JSON.stringify(times)).digest("hex"))
      assert.equal(result.saved[key].valuesHash, createHash("sha256").update(JSON.stringify(source.periods)).digest("hex"))
      if (key !== "liquidations") {
        assert.deepEqual(result.raw[key], result.saved[key], key)
      }
    }
    assert.equal(result.raw.liquidations.periodCount, 2)
    assert.equal(data.studies.liquidations.periods[1].long, 0)
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(resultDirectory, "metrics.json"), "utf8")), metrics)
    assert.deepEqual(metrics.regressions, [])
    assert.deepEqual(metrics.valueChanges, [])
    assert.equal(metrics.success, true)
  }
  assert.equal(await fs.readFile(baseline, "utf8"), baselineBytes)
  assert.deepEqual(await Promise.all([fixture.universeFile, fixture.referenceFile].map(file => fs.readFile(file, "utf8"))), originalInputs)
  assert.deepEqual((await fs.readdir(fixture.directory)).sort(), [path.basename(first.resultDirectory), path.basename(second.resultDirectory), "inputs"].sort())
})

test("baseline preflight requires the exact frozen time and ordered coin identities before connecting", async (context) => {
  const fixture = await createFixture(context, [2, 1].map(createCoin))
  const baseline = path.join(fixture.directory, "baseline.json")
  const connection = createConnection(context, fixture)
  for (const previous of [
    { nowTimestamp: fixture.nowTimestamp + 1, results: [{ baseCurrencyId: "OFFLINE1" }, { baseCurrencyId: "OFFLINE2" }] },
    { nowTimestamp: fixture.nowTimestamp, results: [{ baseCurrencyId: "OFFLINE1" }, { baseCurrencyId: "OTHER" }] },
    { nowTimestamp: fixture.nowTimestamp, results: [{ baseCurrencyId: "OFFLINE2" }, { baseCurrencyId: "OFFLINE1" }] },
    { nowTimestamp: fixture.nowTimestamp, results: [{ baseCurrencyId: "OFFLINE1" }] },
  ]) {
    await writeJson(baseline, previous)
    await assert.rejects(fixture.run(connection, { baseline }), /Baseline must use the same frozen time and coins/)
  }
  await assert.rejects(fixture.run(connection, { count: 3 }), /only 2 are available/)
  await assert.rejects(fixture.run(connection, { concurrency: 0 }), /positive safe integer/)
  await writeJson(fixture.referenceFile, { collectedAt: "invalid" })
  await assert.rejects(fixture.run(connection), /Frozen collectedAt is required/)
  assert.equal(connection.connect.mock.callCount(), 0)
  assert.equal(connection.disconnect.mock.callCount(), 0)
  assert.equal(connection.fetchChartStudies.mock.callCount(), 0)
  assert.deepEqual(await fs.readdir(fixture.directory), ["baseline.json", "inputs"])
})

for (const alreadyUnavailable of [false, true]) {
  test(`optional social regressions remain visible when baseline social is ${alreadyUnavailable ? "unavailable" : "available"}`, async (context) => {
    const fixture = await createFixture(context, [createCoin(1)])
    const transform = (data) => {
      if (alreadyUnavailable) {
        data.studies.createdPosts = { status: "rejected", reason: new Error("Study unavailable") }
      }
      return data
    }
    const first = await fixture.run(createConnection(context, fixture, transform))
    assert.equal(first.metrics.success, true)
    const degraded = await fixture.run(createConnection(context, fixture, (data) => {
      transform(data)
      if (alreadyUnavailable) {
        const missingTime = expectedTimes(2_400, fixture.nowTimestamp).at(-1)
        data.studies.activeContributors.value.periods = data.studies.activeContributors.value.periods
          .filter(period => period.time !== missingTime)
      } else {
        data.studies.activeContributors = { status: "rejected", reason: new Error("Study unavailable") }
      }
      return data
    }), { baseline: path.join(first.resultDirectory, "metrics.json") })
    assert.equal(degraded.metrics.acceptedCount, 1)
    assert.equal(degraded.metrics.results[0].complete, true)
    assert.equal(degraded.metrics.results[0].coverage.social.status, "unavailable")
    assert.equal(degraded.metrics.socialAvailableCount, 0)
    assert.equal(degraded.metrics.stopReason, null)
    assert.equal(degraded.metrics.success, false)
    assert.ok(degraded.metrics.regressions.some(({ source, reason }) => source === "activeContributors"
      && reason === (alreadyUnavailable ? "Fewer complete hours than the baseline" : "Study request now fails")))
    if (!alreadyUnavailable) {
      assert.ok(degraded.metrics.regressions.some(({ source }) => source === "social"))
    }
    const data = JSON.parse(await fs.readFile(degraded.metrics.results[0].dataFile, "utf8"))
    assert.equal(data.availability.social.status, "unavailable")
    for (const request of createCoverageStudyRequests(fixture.coins[0].tradingViewSymbol).filter(request => request.group === "social")) {
      assert.equal(request.key in data.studies, false)
    }
  })
}

test("missing a closed Volume Delta hour rejects the coin, saves no data and reports a baseline regression", async (context) => {
  const fixture = await createFixture(context, [createCoin(1)])
  const first = await fixture.run(createConnection(context, fixture))
  const { resultDirectory, metrics } = await fixture.run(createConnection(context, fixture, (data) => {
    const missingTime = expectedTimes(1_666, fixture.nowTimestamp)[0]
    data.studies.volumeDelta.value.periods = data.studies.volumeDelta.value.periods.filter(period => period.time !== missingTime)
    return data
  }), { baseline: path.join(first.resultDirectory, "metrics.json") })
  assert.equal(metrics.success, false)
  assert.equal(metrics.rejectedCount, 1)
  assert.equal(metrics.results[0].raw.volumeDelta.periodCount, 1_665)
  assert.ok(metrics.results[0].reasonCodes.includes("volumeDelta:missing_hours"))
  assert.deepEqual(metrics.results[0].saved, {})
  assert.equal(metrics.results[0].dataFile, null)
  assert.ok(metrics.regressions.some(({ source }) => source === "coin"))
  assert.ok(metrics.regressions.some(({ source, reason }) => source === "volumeDelta" && reason === "Fewer complete hours than the baseline"))
  assert.deepEqual(await fs.readdir(resultDirectory), ["metrics.json"])
})

test("changed values on the same hourly grid are visible without a coverage regression", async (context) => {
  const fixture = await createFixture(context, [createCoin(1)])
  const first = await fixture.run(createConnection(context, fixture))
  const { metrics } = await fixture.run(createConnection(context, fixture, (data) => {
    const latestTime = expectedTimes(2_400, fixture.nowTimestamp).at(-1)
    data.studies.openInterest.value.periods.find(period => period.time === latestTime).close = 1
    return data
  }), { baseline: path.join(first.resultDirectory, "metrics.json") })
  assert.deepEqual(metrics.valueChanges, [{ symbol: "COIN1", source: "openInterest" }])
  assert.deepEqual(metrics.regressions, [])
  assert.equal(metrics.success, true)
})

test("persisted coverage errors must not bypass redaction of synthetic credentials", async (context) => {
  const fixture = await createFixture(context, [createCoin(1)])
  const { resultDirectory, metrics } = await fixture.run(createConnection(context, fixture, (data) => {
    data.studies.activeContributors = { status: "rejected", reason: new Error("Study unavailable: token=offline-test-credential") }
    return data
  }))
  assert.deepEqual(metrics.results[0].studyErrors, [{ key: "activeContributors", message: "Study unavailable: token=[redacted]" }])
  const persisted = await fs.readFile(path.join(resultDirectory, "metrics.json"), "utf8")
  assert.equal(persisted.includes("offline-test-credential"), false, "Nested coverage must be redacted too")
})

test("coin identities must not allow writes outside the isolated benchmark directory", async (context) => {
  const coin = createCoin(1)
  coin.baseCurrencyId = "../../../escaped"
  coin.market.baseCurrencyId = coin.baseCurrencyId
  const fixture = await createFixture(context, [coin])
  const writes = []
  const writeFile = fs.writeFile
  context.mock.method(fs, "writeFile", async (file, ...args) => {
    writes.push(file)
    // Block the unsafe write while retaining evidence of the attempted escape.
    assert.equal(inside(fixture.directory, file), true, "Write escaped the benchmark directory")
    return writeFile(file, ...args)
  })
  await fixture.run(createConnection(context, fixture)).catch((error) => {
    assert.match(error.message, /baseCurrencyId|path|directory/i)
  })
  assert.deepEqual(writes.filter(file => !inside(fixture.directory, file)), [], "Every write must stay inside the isolated directory")
})
