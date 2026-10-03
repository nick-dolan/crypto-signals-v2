import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import vm from "node:vm"

import { createReportStore } from "../src/reports/store.js"
import { createReportServer } from "../src/server/index.js"
import { readWebAsset } from "../src/web/read-web-asset.js"

function createReport () {
  const unsafe = "</ScRiPt><script>globalThis.injected = true</script><img src=x onerror=alert(1)> <!-- REPORT_SCRIPT --> & \" ' $& \u2028\u2029 🚀"
  return {
    reportCreatedAt: "2026-12-31T20:59:59.999Z",
    asOf: "2026-12-31T20:00:00.000Z",
    timeframe: "1h",
    objective: "P(сильное движение в следующие 4–12 часов)",
    candidateCount: 2,
    universeCoinCount: 250,
    marketContext: { breadth4h: 0.696 },
    altMarketBackground: { status: "unavailable", change4hPct: null, breadth4h: null, warning: unsafe },
    definitions: { volumeZ: "Аномалия объёма", unsafe },
    flagDefinitions: { coiling: "Сжатие" },
    coinDescriptions: { BTC: { description: unsafe, sources: [{ url: "https://example.com/?a='b'", checkedAt: null }] } },
    coins: [
      {
        symbol: "BTC", name: "Bitcoin", baseCurrencyId: "BTC", marketSymbol: "BINANCE:BTCUSDT.P",
        movementProbability: 0.6000000000000001, topRank: 1, estimateConfidence: "medium",
        explanation: unsafe, drivers: [unsafe, "Объём"], counterSignals: [],
        features: { volumeZ: 2.051, quietOi: true, flags: ["coiling"], fundingRate: -0.0000123456789, missing: null },
        history: {
          candles: [{ time: 100, open: 0.2, high: 0.3, low: 0.1, close: 0.25 }],
          volume: [{ time: 100, value: 0 }, { time: 200 }],
          openInterest: [{ time: 100, value: 123456.123456789 }, { time: 200, value: null }],
          warning: unsafe,
        },
        information: {
          news: { status: "failed", error: unsafe, items: [] },
          twitter: { status: "available", tweets: [{ id: "2103826582045618585", text: unsafe, likeCount: 0 }] },
        },
      },
      {
        symbol: "ETH", movementProbability: 0.1, topRank: null,
        features: { volumeZ: null, quietOi: false, flags: [] },
        history: { candles: [], volume: [], openInterest: [], warning: "История недоступна" },
      },
    ],
    peerRadar: {
      status: "available", warning: unsafe,
      data: { observationCount: 1, observations: [{ coin: { symbol: "OUTSIDE" }, explanation: unsafe, leaders: [] }] },
      histories: {
        OUTSIDE: { symbol: "OUTSIDE", points: [{ time: 100 }, { time: 200, value: null }, { time: 300, value: 0.09964 }], warning: unsafe },
      },
    },
  }
}

function reportMetadata (id, report) {
  const { reportCreatedAt, asOf, candidateCount, universeCoinCount } = report
  return { id, reportCreatedAt, asOf, candidateCount, universeCoinCount }
}

function embeddedData (html) {
  const script = /<script id="report-data" type="application\/json">([\s\S]*?)<\/script>/i.exec(html)
  assert.ok(script, "The report contains its JSON data element")
  return script[1]
}

test("real HTTP server serves the Parquet archive, default web assets and offline downloads", { timeout: 30_000 }, async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "report-server-integration-"))
  const stores = []
  let server
  context.after(async () => {
    try {
      if (server?.listening) {
        await new Promise((resolve, reject) => {
          server.close(error => error ? reject(error) : resolve())
          server.closeAllConnections()
        })
      }
    } finally {
      try {
        await Promise.all(stores.map(store => store.close()))
      } finally {
        await fs.rm(directory, { recursive: true, force: true })
      }
    }
  })

  const store = await createReportStore({ directory })
  stores.push(store)
  server = createReportServer({ store })
  await new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject)
      resolve()
    })
  })

  async function request (pathname) {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${pathname}`, { signal: AbortSignal.timeout(5_000) })
    const body = await response.text()
    assert.equal(response.headers.get("x-content-type-options"), "nosniff", pathname)
    assert.equal(Number(response.headers.get("content-length")), Buffer.byteLength(body), pathname)
    return { status: response.status, headers: response.headers, body }
  }

  assert.deepEqual(JSON.parse((await request("/api/reports")).body), { groups: [], total: 0, nextCursor: null })
  const report = createReport()
  const { id } = await store.save(report)

  await context.test("list metadata and calendar groups come from the real saved snapshot", async () => {
    const response = await request("/api/reports")
    assert.equal(response.status, 200)
    assert.equal(response.headers.get("content-type"), "application/json; charset=utf-8")
    assert.deepEqual(JSON.parse(response.body), {
      groups: [{ key: "2026-12-28", label: "28.12.2026 — 03.01.2027", reports: [reportMetadata(id, report)] }],
      total: 1,
      nextCursor: null,
    })
    assert.equal(JSON.parse((await request("/api/reports?group=month")).body).groups[0].key, "2026-12")
    assert.ok(!response.body.includes(directory))
  })

  await context.test("the real list and shared shell serve every referenced browser asset", async () => {
    const home = await request("/")
    const shell = await request(`/reports/${id}`)
    assert.equal(home.status, 200)
    assert.equal(shell.status, 200)
    assert.equal(home.headers.get("content-type"), "text/html; charset=utf-8")
    assert.equal(shell.headers.get("content-type"), "text/html; charset=utf-8")
    assert.equal(home.body, (await readWebAsset("index.html")).content)
    assert.equal(embeddedData(shell.body), "null")
    assert.doesNotMatch(shell.body, /REPORT_(DATA|STYLES|SCRIPT|CHARTS|LICENSE)/)

    const assets = [...new Set([...`${home.body}\n${shell.body}`.matchAll(/(?:src|href)="(\/assets\/[^"\s]+)"/g)].map(match => match[1]))]
    assert.ok(assets.length > 0)
    await Promise.all(assets.map(async (pathname) => {
      const response = await request(pathname)
      const expected = await readWebAsset(pathname.slice("/assets/".length))
      assert.equal(response.status, 200, pathname)
      assert.equal(response.headers.get("content-type"), expected.contentType, pathname)
      assert.equal(response.body, expected.content, pathname)
      if (pathname.endsWith(".js")) {
        assert.doesNotThrow(() => new vm.Script(response.body), pathname)
      }
    }))
  })

  await context.test("JSON round-trips all nested data, exact numbers, nulls and missing values", async () => {
    const responses = await Promise.all(Array.from({ length: 4 }, () => request(`/api/reports/${id}`)))
    for (const response of responses) {
      assert.equal(response.status, 200)
      assert.equal(response.headers.get("content-type"), "application/json; charset=utf-8")
      assert.deepEqual(JSON.parse(response.body), report)
    }
  })

  await context.test("offline attachment embeds the exact saved data without allowing script breakout", async () => {
    const response = await request(`/api/reports/${id}/download`)
    assert.equal(response.status, 200)
    assert.equal(response.headers.get("content-type"), "text/html; charset=utf-8")
    assert.equal(response.headers.get("content-disposition"), `attachment; filename="report-${id}.html"`)
    const data = embeddedData(response.body)
    assert.deepEqual(JSON.parse(data), report)
    assert.doesNotMatch(data, /[<\u2028\u2029]/)
    assert.ok(data.includes("\\u003c/ScRiPt>"))
    assert.ok(data.includes("\\u2028\\u2029"))
    assert.doesNotMatch(response.body, /<script>globalThis\.injected|<img src=x/i)
    assert.doesNotMatch(response.body, /<(?:script|link|img)\b[^>]*(?:src|href)\s*=/i)
    assert.match(response.body, /Apache License/)
  })

  await context.test("a missing UUID still gets the shared shell while both data endpoints return 404", async () => {
    const missing = randomUUID()
    const shell = await request(`/reports/${missing}`)
    assert.equal(shell.status, 200)
    assert.equal(embeddedData(shell.body), "null")
    for (const pathname of [`/api/reports/${missing}`, `/api/reports/${missing}/download`]) {
      const response = await request(pathname)
      assert.equal(response.status, 404)
      assert.deepEqual(JSON.parse(response.body), { error: "Report not found" })
    }
  })

  await context.test("an independent writer publishes a new snapshot visible without restarting the server", async () => {
    const writer = await createReportStore({ directory })
    stores.push(writer)
    const fresh = { ...structuredClone(report), reportCreatedAt: "2027-01-03T21:00:00.000Z" }
    fresh.coins[0].explanation = "Опубликовано вторым экземпляром хранилища"
    const saved = await writer.save(fresh)
    await writer.close()

    const [list, json, original] = await Promise.all([
      request("/api/reports?group=month&limit=1"), request(`/api/reports/${saved.id}`), request(`/api/reports/${id}`),
    ])
    assert.equal(list.status, 200)
    const page = JSON.parse(list.body)
    assert.equal(page.total, 2)
    assert.equal(page.groups[0].key, "2027-01")
    assert.deepEqual(page.groups[0].reports, [reportMetadata(saved.id, fresh)])
    assert.ok(page.nextCursor)
    const next = JSON.parse((await request(`/api/reports?group=month&limit=1&cursor=${page.nextCursor}`)).body)
    assert.equal(next.total, 2)
    assert.equal(next.groups[0].key, "2026-12")
    assert.deepEqual(next.groups[0].reports, [reportMetadata(id, report)])
    assert.equal(next.nextCursor, null)
    assert.equal(json.status, 200)
    assert.deepEqual(JSON.parse(json.body), fresh)
    assert.equal(original.status, 200)
    assert.deepEqual(JSON.parse(original.body), report)
  })
})
