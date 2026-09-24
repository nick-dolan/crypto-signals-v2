import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"

import { buildAlignedCoinSeries, buildBaseSeries } from "../src/steps/step4-feature-metrics/build-base-series.js"
import { buildFeatureProfiles, createFeatureProfile } from "../src/steps/step4-feature-metrics/build-feature-profiles.js"
import { buildUniverseContext } from "../src/steps/step4-feature-metrics/build-universe-context.js"
import { calculateCoinMetrics } from "../src/steps/step4-feature-metrics/calculate-coin-metrics.js"
import { buildPreliminaryShortlist } from "../src/steps/step5-preliminary-filter/build-preliminary-shortlist.js"

function createRegistry (pairs, extraIds = []) {
  return {
    schemaVersion: 1,
    generatedAt: "2026-06-01T00:00:00.000Z",
    universe: {
      coins: [...new Set([...pairs.flat(), ...extraIds])].map(baseCurrencyId => ({
        baseCurrencyId, reviewStatus: "reviewed",
      })),
    },
    relations: pairs.map(coinIds => ({
      coinIds,
      type: "competitor",
      basis: "Shared product",
      caveat: "Different token economics",
    })),
  }
}

function createInput () {
  // The full feature pipeline needs the 90-day warmup, not only the peer detector's history.
  const times = Array.from({ length: 2_240 }, (_, index) => (
    Date.parse("2026-06-01T00:00:00.000Z") / 1_000 + index * 3_600
  ))
  const definitions = [
    { baseCurrencyId: "XTVCBTC", symbol: "BTC", rank: 1 },
    { baseCurrencyId: "TARGET", rank: 40, volumeMultiplier: 2 },
    { baseCurrencyId: "STRONG", rank: 80, volumeMultiplier: 4 },
    { baseCurrencyId: "LATE_PUMP", rank: 2, jump: 12, ageHours: 8, volumeMultiplier: 6 },
    { baseCurrencyId: "LATE_DUMP", rank: 3, jump: -12, ageHours: 8, volumeMultiplier: 6 },
    { baseCurrencyId: "INCOMPLETE", rank: 4, jump: 8, ageHours: 2, volumeMultiplier: 6 },
    { baseCurrencyId: "QUIET", rank: 5 },
  ]
  const sourceUniverse = {
    generatedAt: new Date((times.at(-1) + 3_600) * 1_000).toISOString(),
    coins: definitions.map(({ baseCurrencyId, symbol = baseCurrencyId, rank }) => ({
      baseCurrencyId,
      symbol,
      rank,
      name: symbol,
      categories: [],
      marketCap: 1_000_000,
      tradingViewSymbol: `CRYPTO:${symbol}USD`,
      market: { tradingViewSymbol: `BINANCE:${symbol}USDT.P` },
    })),
  }
  const coinData = sourceUniverse.coins.map((coin, coinIndex) => {
    const { jump = 0, ageHours = 0, volumeMultiplier = 1 } = definitions[coinIndex]
    const jumpIndex = times.length - 1 - ageHours
    const periods = times.map((time, index) => {
      const close = 100 + Math.sin(index / 11) + (index >= jumpIndex ? jump : 0)
      return {
        time,
        close,
        max: close + 1,
        min: close - 1,
        volume: 100 * (jump !== 0 && index === jumpIndex
          ? 6
          : index >= times.length - 3 ? volumeMultiplier : 1),
      }
    })
    const study = values => ({ periods: times.map((time, index) => ({ time, ...values(index) })) })

    return {
      coin: {
        baseCurrencyId: coin.baseCurrencyId,
        symbol: coin.symbol,
        marketSymbol: coin.market.tradingViewSymbol,
      },
      availability: { social: { status: "unavailable" } },
      chart: { periods },
      studies: {
        volumeDelta: study(index => ({ close: periods[index].volume * 0.2 })),
        openInterest: study(index => ({ close: 1_000 + index })),
        fundingRate: study(index => ({
          rate: coin.baseCurrencyId === "INCOMPLETE" && index === times.length - 1 ? null : 0.0001,
        })),
        liquidations: study(() => ({ long: 1, short: -1 })),
        longShortRatioAccounts: study(() => ({ ratio: 1 })),
        topTradersLongShortPositions: study(() => ({ long: 50, short: -50 })),
        premium: study(() => ({ close: 0.1 })),
      },
    }
  })

  return {
    sourceUniverse,
    coinData,
    coingeckoTrending: { universeGeneratedAt: sourceUniverse.generatedAt, matches: [] },
    marketContext: {
      collectedAt: sourceUniverse.generatedAt,
      series: Object.fromEntries([
        ["total", 10], ["totales", 9], ["total2es", 4], ["total3es", 1],
      ].map(([key, scale]) => [key, {
        symbol: `CRYPTOCAP:${key.toUpperCase()}`,
        periods: times.map((time, index) => ({ time, close: (1_000 + Math.sin(index / 7)) * scale })),
      }])),
    },
    coinPeers: createRegistry([
      ["TARGET", "LATE_PUMP"],
      ["TARGET", "INCOMPLETE"],
      ["QUIET", "INCOMPLETE"],
      ["LATE_PUMP", "INCOMPLETE"],
      ["LATE_DUMP", "INCOMPLETE"],
    ], definitions.map(coin => coin.baseCurrencyId)),
  }
}

function runStep4 (input, registry) {
  const baseCoins = buildBaseSeries(input)
  const universeContext = buildUniverseContext(baseCoins, input.marketContext, registry)
  return { baseCoins, universeContext, ...buildFeatureProfiles(baseCoins, universeContext) }
}

function findCoin (coins, baseCurrencyId) {
  return coins.find(({ coin }) => coin.baseCurrencyId === baseCurrencyId)
}

function withoutPeerContext (profile) {
  const result = { ...profile }
  delete result.peerContext
  return result
}

function withoutCandidatePeerContexts (shortlist) {
  return { ...shortlist, candidates: shortlist.candidates.map(withoutPeerContext) }
}

test("peer context integration through steps 4 and 5", { timeout: 90_000 }, async (t) => {
  const input = createInput()
  const before = structuredClone(input)
  const baseline = runStep4(input, null)
  const enriched = runStep4(input, input.coinPeers)
  const beforeProfiles = structuredClone(enriched.profiles)
  const shortlist = buildPreliminaryShortlist(enriched.profiles)

  await t.test("universe context passes through metric calculation into top-level profile.peerContext", () => {
    const baseCoin = findCoin(enriched.baseCoins, "TARGET")
    const series = buildAlignedCoinSeries(baseCoin.hourlyData, enriched.universeContext.times)
    const calculated = calculateCoinMetrics(series, enriched.universeContext, "TARGET")
    const { profile, rejection } = createFeatureProfile(baseCoin, series, calculated)

    assert.equal(rejection, null)
    assert.equal(enriched.universeContext.peerContextsByCoin.size, enriched.baseCoins.length)
    assert.equal(calculated.peerContext, enriched.universeContext.peerContextsByCoin.get("TARGET"))
    assert.equal(profile.peerContext, calculated.peerContext)
    assert.deepEqual(profile, findCoin(enriched.profiles, "TARGET"))
    assert.equal(profile.peerContext.status, "available")
    assert.equal(profile.peerContext.registryGeneratedAt, input.coinPeers.generatedAt)
    assert.deepEqual(profile.peerContext.leaders.map(leader => leader.baseCurrencyId), ["INCOMPLETE", "LATE_PUMP"])
    assert.equal("peerContext" in calculated.featureSeries, false)
    assert.equal("peerContext" in profile.features, false)
    assert.equal("peerContext" in profile.context, false)
    assert.deepEqual(enriched.profiles.map(withoutPeerContext), baseline.profiles.map(withoutPeerContext))
    assert.deepEqual(enriched.rejected, baseline.rejected)
  })

  await t.test("missing registry or peer coverage does not change profile acceptance or required metrics", async (context) => {
    assert.equal(baseline.profiles.length, input.coinData.length - 1)
    assert.deepEqual(baseline.rejected.map(({ coin }) => coin.baseCurrencyId), ["INCOMPLETE"])

    for (const [status, registry] of [
      ["unavailable", null],
      ["not_covered", createRegistry([["QUIET", "LATE_PUMP"]])],
      ["insufficient_data", createRegistry([["TARGET", "ABSENT"]])],
      ["partial", createRegistry([["TARGET", "INCOMPLETE"], ["TARGET", "ABSENT"]])],
    ]) {
      await context.test(status, () => {
        const result = registry === null ? baseline : runStep4(input, registry)
        assert.equal(findCoin(result.profiles, "TARGET").peerContext.status, status)
        assert.deepEqual(result.profiles.map(withoutPeerContext), baseline.profiles.map(withoutPeerContext))
        assert.deepEqual(result.rejected, baseline.rejected)
      })
    }
  })

  await t.test("step 5 preserves selection, order, reasons, source ranks and late pump/dump exclusions", () => {
    for (const profiles of [
      baseline.profiles,
      baseline.profiles.map(withoutPeerContext),
      enriched.profiles.map(profile => ({ ...profile, peerContext: null })),
    ]) {
      assert.deepEqual(
        withoutCandidatePeerContexts(buildPreliminaryShortlist(profiles)),
        withoutCandidatePeerContexts(shortlist),
      )
    }

    assert.deepEqual(shortlist.candidates.map(({ coin, selection }) => (
      [coin.baseCurrencyId, coin.rank, selection.priority]
    )), [["STRONG", 80, 1], ["TARGET", 40, 2]])
    for (const candidate of shortlist.candidates) {
      assert.ok(candidate.selection.selectedBy.includes("volumeOrderFlow"))
      assert.deepEqual(candidate.peerContext, findCoin(enriched.profiles, candidate.coin.baseCurrencyId).peerContext)
    }
    assert.equal(findCoin(enriched.profiles, "STRONG").peerContext.status, "no_peers")
    assert.equal(findCoin(enriched.profiles, "QUIET").peerContext.freshLeaderCount, 1)
    assert.equal(findCoin(shortlist.candidates, "QUIET"), undefined)
    assert.equal(shortlist.filter.latePumpExcludedCoinCount, 1)
    assert.equal(shortlist.filter.lateDumpExcludedCoinCount, 1)
    for (const [id, flag] of [["LATE_PUMP", "late_pump"], ["LATE_DUMP", "late_dump"]]) {
      const profile = findCoin(enriched.profiles, id)
      assert.equal(profile.features.movementLifecycle[flag], true)
      assert.equal(profile.peerContext.freshLeaderCount, 1)
      assert.ok(profile.features.volumeOrderFlow.volume_acceleration_3h >= 0.25)
      assert.ok(profile.features.volumeOrderFlow.rel_volume_at_time >= 1.5)
      assert.equal(findCoin(shortlist.candidates, id), undefined)
    }
    assert.deepEqual(enriched.profiles, beforeProfiles)
  })

  await t.test("neighbors rejected for missing features or a late move still supply context before filtering", () => {
    const rejected = findCoin(enriched.rejected, "INCOMPLETE")
    assert.ok(rejected.unavailableMetrics.includes("derivatives.funding_rate"))
    assert.equal(findCoin(enriched.profiles, "INCOMPLETE"), undefined)
    assert.equal(findCoin(enriched.profiles, "LATE_PUMP").features.movementLifecycle.late_pump, true)

    const peerContext = findCoin(enriched.profiles, "TARGET").peerContext
    assert.equal(peerContext.peerCount, 2)
    assert.equal(peerContext.availablePeerCount, 2)
    assert.equal(peerContext.freshLeaderCount, 1)
    assert.equal(peerContext.fadingLeaderCount, 1)
    for (const id of ["INCOMPLETE", "LATE_PUMP"]) {
      assert.ok(enriched.universeContext.peerContextsByCoin.has(id))
      assert.ok(peerContext.leaders.some(leader => leader.baseCurrencyId === id))
      assert.equal(findCoin(shortlist.candidates, id), undefined)
    }
    assert.deepEqual(findCoin(shortlist.candidates, "TARGET").peerContext, peerContext)
  })

  await t.test("readFeatureInput and CLI steps use the accepted registry, not a proposal, in an isolated workspace", async (context) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "step4-peer-integration-"))
    context.after(() => fs.rm(directory, { recursive: true, force: true }))
    const writeJson = async (filename, data) => {
      const filePath = path.join(directory, filename)
      await fs.mkdir(path.dirname(filePath), { recursive: true })
      await fs.writeFile(filePath, JSON.stringify(data))
    }
    const readJson = async filename => JSON.parse(await fs.readFile(path.join(directory, filename), "utf8"))
    const run = filename => promisify(execFile)(process.execPath, [
      fileURLToPath(new URL(`../src/${filename}`, import.meta.url)),
    ], { cwd: directory, timeout: 30_000, killSignal: "SIGKILL" })
    const readRegistryInput = async () => {
      const { stdout } = await promisify(execFile)(process.execPath, ["--input-type=module", "--eval", `
        import { readFeatureInput } from ${JSON.stringify(new URL("../src/steps/step4-feature-metrics/read-feature-input.js", import.meta.url).href)}
        console.log(JSON.stringify((await readFeatureInput()).coinPeers))
      `], { cwd: directory, timeout: 10_000, killSignal: "SIGKILL" })
      return JSON.parse(stdout)
    }

    await Promise.all([
      ["tmp/step1-crypto-universe.json", input.sourceUniverse],
      ["tmp/step2-data-bootstrap.json", { coinCount: input.coinData.length }],
      ["tmp/step3-market-context.json", input.marketContext],
      ["tmp/step3.1-coingecko-trending.json", input.coingeckoTrending],
      ["data/coin-peers.proposed.json", createRegistry([["QUIET", "STRONG"]])],
      ...input.coinData.map(data => [`tmp/step2-data-bootstrap/${data.coin.baseCurrencyId}/data.json`, data]),
    ].map(([filename, data]) => writeJson(filename, data)))

    assert.equal(await readRegistryInput(), null)
    await writeJson("data/coin-peers.json", input.coinPeers)
    assert.deepEqual(await readRegistryInput(), input.coinPeers)

    await run("step4-feature-metrics.js")
    const featureMetrics = await readJson("tmp/step4-feature-metrics.json")
    assert.equal(featureMetrics.coinCount, enriched.profiles.length)
    assert.equal(featureMetrics.rejectedCoinCount, enriched.rejected.length)
    assert.deepEqual(featureMetrics.profiles, enriched.profiles)
    assert.deepEqual(featureMetrics.rejected, enriched.rejected)

    await run("step5-preliminary-filter.js")
    const filtered = await readJson("tmp/step5-preliminary-filter.json")
    assert.equal(filtered.candidateCount, shortlist.candidateCount)
    assert.deepEqual(filtered.candidates, shortlist.candidates)
    assert.deepEqual(filtered.filter, shortlist.filter)
    assert.deepEqual(await readJson("data/coin-peers.json"), input.coinPeers)
    assert.deepEqual(await readJson("tmp/step4-feature-metrics.json"), featureMetrics)
    await assert.rejects(fs.access(path.join(directory, "output")), { code: "ENOENT" })
  })

  assert.deepEqual(input, before)
})
