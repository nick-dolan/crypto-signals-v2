import assert from "node:assert/strict"
import test from "node:test"
import { setImmediate } from "node:timers/promises"
import { buildCompleteCryptoUniverse } from "../src/steps/step2-data-bootstrap/build-complete-crypto-universe.js"

function createMarket (
  baseCurrencyId,
  {
    exchange = "BINANCE",
    instrumentType = "swap",
    quoteSymbol = "USDT",
    symbol = `${baseCurrencyId}${quoteSymbol}.P`,
    typeSpecifications = ["crypto", "perpetual"],
    volume24hUsd = 1_000_000,
  } = {},
) {
  return {
    tradingViewSymbol: `${exchange}:${symbol}`,
    symbol,
    baseSymbol: baseCurrencyId.replace("XTVC", ""),
    baseCurrencyId,
    quoteSymbol,
    exchange,
    price: 1,
    volume24hUsd,
    instrumentType,
    typeSpecifications,
  }
}

function createCoin (
  rank,
  {
    baseCurrencyId = `XTVC${rank}`,
    market = createMarket(baseCurrencyId),
    symbol = `COIN${rank}`,
  } = {},
) {
  return {
    rank,
    baseCurrencyId,
    symbol,
    name: `Coin ${rank}`,
    tradingViewSymbol: `CRYPTO:COIN${rank}USD`,
    categories: ["cryptocurrencies"],
    circulatingSupply: 1_000_000,
    marketCap: 10_000_000,
    fullyDilutedValuation: 12_000_000,
    market,
  }
}

function createSourceUniverse (
  coins,
  {
    selection = {
      exchange: "BINANCE",
      quoteSymbol: "USDT",
      instrumentType: "swap",
      typeSpecification: "perpetual",
    },
    source = "tradingview",
  } = {},
) {
  return {
    source,
    selection,
    coins,
  }
}

function createCoverageResult (
  complete,
  retryable = false,
  {
    dataFile,
    unavailableMetrics = [],
  } = {},
) {
  return {
    complete,
    retryable,
    reasonCodes: complete ? [] : ["premium:missing_values"],
    reasons: complete ? [] : ["Premium is unavailable"],
    unavailableMetrics,
    coverage: {
      ohlcv: {
        completePeriodCount: 2_400,
      },
    },
    ...(dataFile ? { dataFile } : {}),
  }
}

async function withControlledChecks (coins, options, verify) {
  const gates = new Map(coins.map(coin => [
    coin.baseCurrencyId,
    Array.from({ length: options.maxAttempts }, () => Promise.withResolvers()),
  ]))
  const getCheck = (id, attempt = 1) => gates.get(id)[attempt - 1]
  const state = { calls: [], finished: [], active: 0, peak: 0, settled: false }
  const outcome = buildCompleteCryptoUniverse(
    createSourceUniverse(coins),
    async (coin, attempt) => {
      state.calls = [...state.calls, [coin.baseCurrencyId, attempt]]
      state.active += 1
      state.peak = Math.max(state.peak, state.active)

      try {
        return await getCheck(coin.baseCurrencyId, attempt).promise
      } finally {
        state.active -= 1
        state.finished = [...state.finished, [coin.baseCurrencyId, attempt]]
      }
    },
    options,
  ).then(
    (report) => {
      state.settled = true
      return { report }
    },
    (error) => {
      state.settled = true
      return { error }
    },
  )

  try {
    await verify({ getCheck, state, outcome })
  } finally {
    for (const attempts of gates.values()) {
      for (const gate of attempts) {
        gate.resolve(createCoverageResult(true))
      }
    }
    await setImmediate()
    await outcome
  }
}

test("complete universe checks every attached market by rank", async () => {
  const candidates = [
    createCoin(5),
    createCoin(2, { baseCurrencyId: "XTVCEDGEX", symbol: "EDGE" }),
    createCoin(4, { baseCurrencyId: "XTVCBTC", symbol: "BTC" }),
    createCoin(3, { baseCurrencyId: "XTVCEDGED", symbol: "EDGE" }),
  ]
  const checkedIds = []
  const progressEvents = []
  const report = await buildCompleteCryptoUniverse(
    createSourceUniverse(candidates),
    async (coin) => {
      checkedIds.push(coin.baseCurrencyId)

      return createCoverageResult(coin.baseCurrencyId !== "XTVCEDGED")
    },
    {
      concurrency: 1,
      generatedAt: "2026-08-29T12:00:00Z",
      onProgress: event => progressEvents.push(event),
    },
  )

  assert.deepEqual(checkedIds, [
    "XTVCEDGEX",
    "XTVCEDGED",
    "XTVCBTC",
    "XTVC5",
  ])
  assert.deepEqual(
    progressEvents.map(event => [
      event.status,
      event.index,
      event.total,
      event.coin.rank,
    ]),
    [
      ["accepted", 1, 4, 2],
      ["rejected", 2, 4, 3],
      ["accepted", 3, 4, 4],
      ["accepted", 4, 4, 5],
    ],
  )
  assert.deepEqual(
    report.coins.map(coin => coin.baseCurrencyId),
    ["XTVCEDGEX", "XTVCBTC", "XTVC5"],
  )
  assert.deepEqual(
    report.rejected.map(coin => [coin.baseCurrencyId, coin.reasonCodes]),
    [["XTVCEDGED", ["premium:missing_values"]]],
  )
  assert.deepEqual(report.selection, {
    exchange: "BINANCE",
    quoteSymbol: "USDT",
    instrumentType: "swap",
    typeSpecification: "perpetual",
  })
  assert.equal(report.candidateCount, 4)
  assert.equal(report.coinCount, 3)
})

for (const { name, candidates, orderedIds } of [
  {
    name: "rank order",
    candidates: [30, 9, 5, 20, 2, 12].map(rank => createCoin(rank)),
    orderedIds: [2, 5, 9, 12, 20, 30].map(rank => `XTVC${rank}`),
  },
  {
    name: "stable equal ranks",
    candidates: [
      createCoin(20),
      ...["A", "B", "C", "D", "E"].map(symbol => createCoin(2, {
        baseCurrencyId: `XTVC${symbol}`,
        symbol,
      })),
    ],
    orderedIds: ["XTVCA", "XTVCB", "XTVCC", "XTVCD", "XTVCE", "XTVC20"],
  },
]) {
  test(`complete universe caps concurrency at 2, overlaps checks and preserves ${name}`, { timeout: 10_000 }, async () => {
    const progressEvents = []
    await withControlledChecks(candidates, {
      concurrency: 2,
      maxAttempts: 1,
      onProgress: event => progressEvents.push(event),
    }, async ({ getCheck, state, outcome }) => {
      // Yield only to flush promise continuations; checker completion needs an explicit gate release.
      await setImmediate()
      assert.deepEqual(state.calls, orderedIds.slice(0, 2).map(id => [id, 1]))
      assert.equal(state.active, 2)
      assert.equal(state.finished.length, 0)
      assert.equal(state.settled, false)

      for (const [position, index] of [1, 0, 3, 4, 5, 2].entries()) {
        const id = orderedIds[index]
        getCheck(id).resolve(createCoverageResult([0, 1, 4].includes(index), false, {
          dataFile: `tmp/step2-data-bootstrap/${id}/data.json`,
        }))
        await setImmediate()
        assert.deepEqual(state.calls, orderedIds.slice(0, Math.min(position + 3, 6)).map(id => [id, 1]))
        assert.equal(state.peak, 2)
        assert.equal(state.active, Math.min(2, 5 - position))

        if (position < 5) {
          assert.equal(state.settled, false, "must wait for every active checker")
        }
      }

      const { report, error } = await outcome
      assert.ifError(error)
      assert.deepEqual(state.finished, [1, 0, 3, 4, 5, 2].map(index => [orderedIds[index], 1]))
      assert.equal(report.candidateCount, 6)
      assert.equal(report.coinCount, 3)
      assert.deepEqual(
        report.coins.map(coin => [coin.baseCurrencyId, coin.attempts, coin.dataFile]),
        [0, 1, 4].map(index => [
          orderedIds[index], 1, `tmp/step2-data-bootstrap/${orderedIds[index]}/data.json`,
        ]),
      )
      assert.deepEqual(
        report.rejected.map(coin => [coin.baseCurrencyId, coin.attempts]),
        [2, 3, 5].map(index => [orderedIds[index], 1]),
      )
      assert.equal(report.rejected.every(coin => !("dataFile" in coin)), true)
      assert.deepEqual(
        [...progressEvents].sort((first, second) => first.index - second.index).map(event => [
          event.coin.baseCurrencyId, event.status, event.index, event.total, event.accepted?.dataFile,
        ]),
        orderedIds.map((id, index) => [
          id,
          [0, 1, 4].includes(index) ? "accepted" : "rejected",
          index + 1,
          6,
          [0, 1, 4].includes(index) ? `tmp/step2-data-bootstrap/${id}/data.json` : undefined,
        ]),
      )
    })
  })
}

test("complete universe keeps concurrent retries and attempts local to each coin", { timeout: 10_000 }, async () => {
  const progressEvents = []
  const expectedCalls = [["XTVC5", 1], ["XTVC11", 1], ["XTVC5", 2], ["XTVC11", 2], ["XTVC11", 3], ["XTVC30", 1]]
  await withControlledChecks([30, 11, 5].map(rank => createCoin(rank)), {
    concurrency: 2,
    maxAttempts: 3,
    onProgress: event => progressEvents.push(event),
  }, async ({ getCheck, state, outcome }) => {
    await setImmediate()
    assert.deepEqual(state.calls, expectedCalls.slice(0, 2))
    assert.equal(state.active, 2)

    getCheck("XTVC5").reject(new Error("Temporary coverage failure"))
    await setImmediate()
    assert.deepEqual(state.calls, expectedCalls.slice(0, 3))

    for (const attempt of [1, 2]) {
      getCheck("XTVC11", attempt).resolve(createCoverageResult(false, true, {
        unavailableMetrics: ["premium"],
      }))
      await setImmediate()
      assert.deepEqual(state.calls, expectedCalls.slice(0, attempt + 3))
      assert.equal(state.active, 2)
      assert.equal(state.peak, 2)
    }

    getCheck("XTVC5", 2).resolve(createCoverageResult(true, false, {
      dataFile: "tmp/step2-data-bootstrap/XTVC5/data.json",
    }))
    await setImmediate()
    assert.deepEqual(state.calls, expectedCalls)
    assert.equal(state.active, 2)
    getCheck("XTVC30").resolve(createCoverageResult(false, false, {
      unavailableMetrics: ["premium"],
    }))
    await setImmediate()
    assert.equal(state.active, 1)
    assert.equal(state.settled, false)
    getCheck("XTVC11", 3).resolve(createCoverageResult(false, true, {
      unavailableMetrics: ["premium"],
    }))

    const { report, error } = await outcome
    assert.ifError(error)
    assert.deepEqual(state.calls, expectedCalls)
    assert.equal(state.active, 0)
    assert.equal(state.peak, 2)
    assert.deepEqual(
      report.coins.map(coin => [coin.rank, coin.attempts, coin.dataFile]),
      [[5, 2, "tmp/step2-data-bootstrap/XTVC5/data.json"]],
    )
    assert.deepEqual(
      report.rejected.map(coin => [coin.rank, coin.attempts, coin.unavailableMetrics, coin.confirmedUnavailableMetrics]),
      [[11, 3, ["premium"], ["premium"]], [30, 1, ["premium"], []]],
    )
    assert.deepEqual(
      [...progressEvents].sort((first, second) => first.coin.rank - second.coin.rank).map(event => [
        event.coin.rank, event.status, event.index, event.total,
        event.attempt ?? event.accepted?.attempts ?? event.rejection?.attempts,
      ]),
      [
        [5, "retrying", 1, 3, 1],
        [5, "accepted", 1, 3, 2],
        [11, "retrying", 2, 3, 1],
        [11, "retrying", 2, 3, 2],
        [11, "rejected", 2, 3, 3],
        [30, "rejected", 3, 3, 1],
      ],
    )
    assert.deepEqual(
      progressEvents.filter(event => event.status === "retrying").map(event => [
        event.coin.rank, event.result.reasonCodes, event.result.confirmedUnavailableMetrics,
      ]),
      [
        [5, ["coverage:request_failed"], []],
        [11, ["premium:missing_values"], []],
        [11, ["premium:missing_values"], ["premium"]],
      ],
    )
  })
})

for (const status of ["retrying", "accepted", "rejected"]) {
  test(`complete universe preserves the original ${status} progress error and drains active checks`, { timeout: 10_000 }, async () => {
    const failure = new Error(`onProgress ${status} failed`)
    let progressThrew = false
    await withControlledChecks([createCoin(11), createCoin(5)], {
      concurrency: 2,
      maxAttempts: 2,
      onProgress: (event) => {
        if (event.coin.rank === 5 && event.status === status) {
          progressThrew = true
          throw failure
        }
      },
    }, async ({ getCheck, state, outcome }) => {
      await setImmediate()
      assert.deepEqual(state.calls, [["XTVC5", 1], ["XTVC11", 1]])
      assert.equal(state.active, 2)
      getCheck("XTVC5").resolve(createCoverageResult(status === "accepted", status === "retrying"))
      await setImmediate()
      assert.equal(progressThrew, true)
      assert.equal(state.active, 1)
      assert.equal(state.settled, false, "progress errors must wait for the active checker")
      getCheck("XTVC11").resolve(createCoverageResult(true))

      const { error } = await outcome
      assert.strictEqual(error, failure)
      assert.equal(state.active, 0)
      assert.deepEqual(state.calls, [["XTVC5", 1], ["XTVC11", 1]])
      assert.deepEqual(state.finished, state.calls)
    })
  })
}

test("complete universe validates positive safe-integer concurrency before checking coverage", async () => {
  let calls = 0
  for (const coins of [[], [createCoin(1)]]) {
    for (const concurrency of [0, -1, 1.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1, "2", null, true, false, {}, [], 2n, Symbol("2")]) {
      await assert.rejects(
        buildCompleteCryptoUniverse(
          createSourceUniverse(coins),
          async () => {
            calls += 1
            return createCoverageResult(true)
          },
          { concurrency },
        ),
        /concurrency.*positive.*integer/i,
        `concurrency=${String(concurrency)}, candidates=${coins.length}`,
      )
      assert.equal(calls, 0)
    }
  }
})

test("complete universe accepts explicit positive safe-integer concurrency", async () => {
  for (const concurrency of [1, 2, Number.MAX_SAFE_INTEGER]) {
    let calls = 0
    const report = await buildCompleteCryptoUniverse(
      createSourceUniverse([createCoin(1)]),
      async () => {
        calls += 1
        return createCoverageResult(true)
      },
      { concurrency },
    )
    assert.equal(calls, 1)
    assert.equal(report.coinCount, 1)
  }
})

test("complete universe checks distinct coins with the same rank independently", async () => {
  const checkedIds = []
  const report = await buildCompleteCryptoUniverse(
    createSourceUniverse([createCoin(3), createCoin(1), { ...createCoin(2), rank: 1 }]),
    async (coin) => {
      checkedIds.push(coin.baseCurrencyId)

      return createCoverageResult(true)
    },
  )

  assert.deepEqual(checkedIds, ["XTVC1", "XTVC2", "XTVC3"])
  assert.equal(report.candidateCount, 3)
  assert.equal(report.coinCount, 3)
  assert.deepEqual(
    report.coins.map(coin => [coin.baseCurrencyId, coin.rank]),
    [["XTVC1", 1], ["XTVC2", 1], ["XTVC3", 3]],
  )
})

test("complete universe rejects duplicate baseCurrencyId values with equal or different ranks", async () => {
  for (const rank of [1, 2]) {
    await assert.rejects(
      buildCompleteCryptoUniverse(
        createSourceUniverse([createCoin(1), createCoin(rank, { baseCurrencyId: "XTVC1" })]),
        async () => createCoverageResult(true),
      ),
      /duplicate baseCurrencyId: XTVC1/,
    )
  }
})

test("complete universe accepts every complete coin and retries transient failures", async () => {
  let attempts = 0
  const progressEvents = []
  const report = await buildCompleteCryptoUniverse(
    createSourceUniverse([createCoin(1)]),
    async (_coin, attempt) => {
      attempts += 1
      assert.equal(attempt, attempts)

      if (attempts === 1) {
        throw new Error("Temporary WebSocket failure")
      }

      return createCoverageResult(true)
    },
    {
      generatedAt: "2026-08-29T12:00:00Z",
      onProgress: event => progressEvents.push(event),
    },
  )

  assert.equal(attempts, 2)
  assert.deepEqual(
    progressEvents.map(event => [event.status, event.index, event.total]),
    [
      ["retrying", 1, 1],
      ["accepted", 1, 1],
    ],
  )
  assert.equal(report.candidateCount, 1)
  assert.equal(report.coinCount, 1)
  assert.equal(report.coins[0].attempts, 2)
})

test("complete universe keeps the accepted coin data file reference", async () => {
  const dataFile = "tmp/step2-data-bootstrap/COIN1--XTVC1/data.json"
  const report = await buildCompleteCryptoUniverse(
    createSourceUniverse([createCoin(1)]),
    async () => createCoverageResult(true, false, { dataFile }),
  )

  assert.equal(report.coins[0].dataFile, dataFile)
  assert.equal("hourlyData" in report.coins[0], false)
})

test("complete universe confirms unavailable metrics with a second attempt", async () => {
  let attempts = 0
  const report = await buildCompleteCryptoUniverse(
    createSourceUniverse([createCoin(1)]),
    async () => {
      attempts += 1

      return createCoverageResult(false, true, {
        unavailableMetrics: ["premium"],
      })
    },
  )

  assert.equal(attempts, 2)
  assert.equal(report.rejected[0].attempts, 2)
  assert.deepEqual(report.rejected[0].unavailableMetrics, ["premium"])
  assert.deepEqual(report.rejected[0].confirmedUnavailableMetrics, ["premium"])
  assert.equal("dataFile" in report.rejected[0], false)
})

test("complete universe does not confirm absence after a failed first request", async () => {
  let attempts = 0
  const report = await buildCompleteCryptoUniverse(
    createSourceUniverse([createCoin(1)]),
    async () => {
      attempts += 1

      if (attempts === 1) {
        throw new Error("Temporary WebSocket failure")
      }

      return createCoverageResult(false, true, {
        unavailableMetrics: ["premium"],
      })
    },
  )

  assert.deepEqual(report.rejected[0].unavailableMetrics, ["premium"])
  assert.deepEqual(report.rejected[0].confirmedUnavailableMetrics, [])
})

test("complete universe only rechecks market identity needed by step 2", async () => {
  await assert.rejects(
    buildCompleteCryptoUniverse(
      createSourceUniverse([createCoin(1, { market: null })]),
      async () => createCoverageResult(true),
    ),
    /market is required/,
  )

  await assert.rejects(
    buildCompleteCryptoUniverse(
      createSourceUniverse([
        createCoin(1, { market: createMarket("XTVCOTHER") }),
      ]),
      async () => createCoverageResult(true),
    ),
    /baseCurrencyId does not match its coin/,
  )

  const preselectedMarket = createMarket("XTVC1", { exchange: "BYBIT" })
  preselectedMarket.price = null
  preselectedMarket.volume24hUsd = null
  preselectedMarket.typeSpecifications = []

  const report = await buildCompleteCryptoUniverse(
    createSourceUniverse([createCoin(1, { market: preselectedMarket })]),
    async () => createCoverageResult(true),
  )

  assert.equal(report.coinCount, 1)
})

test("complete universe does not hardcode the market selection", async () => {
  const selection = {
    exchange: "EXAMPLE",
    quoteSymbol: "USD",
    instrumentType: "futures",
    typeSpecification: "quarterly",
  }
  const market = createMarket("XTVC1", {
    exchange: selection.exchange,
    instrumentType: selection.instrumentType,
    quoteSymbol: selection.quoteSymbol,
    symbol: "COIN1USDZ26",
    typeSpecifications: ["crypto", selection.typeSpecification],
  })
  const report = await buildCompleteCryptoUniverse(
    createSourceUniverse(
      [createCoin(1, { market })],
      { selection, source: "fixture" },
    ),
    async () => createCoverageResult(true),
    { generatedAt: "2026-08-29T12:00:00Z" },
  )

  assert.equal(report.source, "fixture")
  assert.deepEqual(report.selection, selection)
  assert.equal(report.coinCount, 1)
})
