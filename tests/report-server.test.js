import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { request as httpRequest } from "node:http"
import test from "node:test"
import { promisify } from "node:util"

import { createReportServer, readListenOptions, startReportServer } from "../src/server/index.js"

function reportId (number) {
  return `00000000-0000-4000-8000-${number.toString(16).padStart(12, "0")}`
}

function metadata (number, reportCreatedAt = "2026-09-26T12:00:00.000Z") {
  return {
    id: reportId(number),
    reportCreatedAt,
    asOf: "2020-01-01T00:00:00.000Z",
    candidateCount: number,
    universeCoinCount: 100,
  }
}

function request (server, path, method = "GET") {
  return new Promise((resolve, reject) => {
    const outgoing = httpRequest({
      hostname: "127.0.0.1", port: server.address().port, path, method, agent: false,
    }, (incoming) => {
      const chunks = []
      incoming.on("data", chunk => chunks.push(chunk))
      incoming.on("error", reject)
      incoming.on("end", () => resolve({
        status: incoming.statusCode,
        headers: incoming.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      }))
    })
    outgoing.on("error", reject)
    outgoing.setTimeout(3_000, () => outgoing.destroy(new Error("Test request timed out")))
    outgoing.end()
  })
}

async function closeServer (server) {
  if (server.listening) {
    await new Promise((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve())
      server.closeAllConnections()
    })
  }
}

async function serve (context, overrides = {}) {
  const dependencies = {
    renderReportHtml: context.mock.fn(async report => `<!doctype html><title>Offline ${report.id}</title>`),
    renderReportPage: context.mock.fn(async () => "<!doctype html><title>Общий отчёт</title>"),
    readWebAsset: context.mock.fn(async (name) => {
      const assets = {
        "index.html": { content: "<!doctype html><title>Архив</title>", contentType: "text/html; charset=utf-8" },
        "report.css": { content: "body { color: black }", contentType: "text/css; charset=utf-8" },
        "report.js": { content: Buffer.from("console.log('report')"), contentType: "text/javascript; charset=utf-8" },
      }
      return assets[name] ?? null
    }),
    ...overrides,
    store: {
      list: context.mock.fn(async () => []),
      read: context.mock.fn(async () => null),
      close: context.mock.fn(async () => {}),
      ...overrides.store,
    },
  }
  const server = createReportServer(dependencies)
  context.after(() => closeServer(server))
  await new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  return { server, ...dependencies, request: (path, method) => request(server, path, method) }
}

function ids (page) {
  return page.groups.flatMap(group => group.reports.map(report => report.id))
}

function encodeCursor (value) {
  return Buffer.from(JSON.stringify(value)).toString("base64url")
}

test("importing the server does not start a listener or install signal handlers", async () => {
  const { stdout, stderr } = await promisify(execFile)(process.execPath, ["--input-type=module", "--eval", `
    import assert from "node:assert/strict"
    const before = ["SIGINT", "SIGTERM"].map(signal => process.listenerCount(signal))
    await import(${JSON.stringify(new URL("../src/server/index.js", import.meta.url).href)})
    assert.deepEqual(["SIGINT", "SIGTERM"].map(signal => process.listenerCount(signal)), before)
    console.log("import-safe")
  `], { timeout: 5_000 })
  assert.equal(stdout.trim(), "import-safe")
  assert.equal(stderr, "")
})

test("factory validates dependencies without listening or taking ownership of the store", async (context) => {
  assert.throws(() => createReportServer(), /store/)
  assert.throws(() => createReportServer({ store: { read () {}, list () {} }, renderReportPage: null }), /renderers/)
  const store = { read: async () => null, list: async () => [], close: context.mock.fn() }
  const server = createReportServer({ store })
  assert.equal(server.listening, false)
  await new Promise(resolve => server.close(resolve))
  assert.equal(store.close.mock.callCount(), 0)
})

test("routes serve the list, shared shell, JSON, safe assets and an offline attachment", async (context) => {
  const report = { ...metadata(10), coins: [{ symbol: "BTC", explanation: "Отчёт" }] }
  const app = await serve(context, { store: { read: context.mock.fn(async () => report) } })
  const home = await app.request("/")
  assert.equal(home.status, 200)
  assert.equal(home.body, "<!doctype html><title>Архив</title>")
  assert.equal(home.headers["content-type"], "text/html; charset=utf-8")
  assert.equal(Number(home.headers["content-length"]), Buffer.byteLength(home.body))
  assert.equal(app.readWebAsset.mock.calls[0].arguments[0], "index.html")

  const shell = await app.request(`/reports/${report.id}`)
  assert.equal(shell.status, 200)
  assert.equal(shell.body, "<!doctype html><title>Общий отчёт</title>")
  assert.deepEqual(app.renderReportPage.mock.calls[0].arguments, [])
  assert.equal(shell.headers["content-disposition"], undefined)
  assert.equal(app.store.read.mock.callCount(), 0)

  const json = await app.request(`/api/reports/${report.id.toUpperCase()}`)
  assert.equal(json.status, 200)
  assert.deepEqual(JSON.parse(json.body), report)
  assert.equal(json.headers["content-type"], "application/json; charset=utf-8")
  assert.equal(app.store.read.mock.calls.at(-1).arguments[0], report.id)

  const download = await app.request(`/api/reports/${report.id}/download`)
  assert.equal(download.status, 200)
  assert.equal(download.body, `<!doctype html><title>Offline ${report.id}</title>`)
  assert.equal(download.headers["content-type"], "text/html; charset=utf-8")
  assert.equal(download.headers["content-disposition"], `attachment; filename="report-${report.id}.html"`)
  assert.equal(app.renderReportHtml.mock.calls[0].arguments[0], report)

  for (const [name, contentType] of [["report.css", "text/css"], ["report.js", "text/javascript"]]) {
    const asset = await app.request(`/assets/${name}`)
    assert.equal(asset.status, 200)
    assert.equal(asset.headers["content-type"], `${contentType}; charset=utf-8`)
    assert.equal(asset.headers["x-content-type-options"], "nosniff")
    assert.equal(Number(asset.headers["content-length"]), Buffer.byteLength(asset.body))
  }
  assert.equal(app.store.close.mock.callCount(), 0)
})

test("week groups use creation time, UTC+3 and Monday across the year boundary", async (context) => {
  const rows = [
    metadata(1, "2026-12-27T20:59:59.999Z"),
    metadata(2, "2026-12-27T21:00:00.000Z"),
    metadata(3, "2026-12-31T21:00:00.000Z"),
    metadata(4, "2027-01-03T20:59:59.999Z"),
    metadata(5, "2027-01-03T21:00:00.000Z"),
  ]
  const app = await serve(context, { store: { list: async () => rows } })
  const response = await app.request("/api/reports?group=week")
  assert.equal(response.status, 200)
  const page = JSON.parse(response.body)
  assert.deepEqual(page.groups.map(group => [group.key, group.label, group.reports.map(report => report.id)]), [
    ["2027-01-04", "04.01.2027 — 10.01.2027", [reportId(5)]],
    ["2026-12-28", "28.12.2026 — 03.01.2027", [reportId(4), reportId(3), reportId(2)]],
    ["2026-12-21", "21.12.2026 — 27.12.2026", [reportId(1)]],
  ])
  assert.equal(page.total, 5)
  assert.equal(page.nextCursor, null)
})

test("month groups handle UTC+3 midnight, year changes and leap day", async (context) => {
  const rows = [
    metadata(1, "2024-02-29T20:59:59.999Z"),
    metadata(2, "2024-02-29T21:00:00.000Z"),
    metadata(3, "2026-12-31T20:59:59.999Z"),
    metadata(4, "2027-01-01T00:00:00+03:00"),
  ]
  const app = await serve(context, { store: { list: async () => rows } })
  const page = JSON.parse((await app.request("/api/reports?group=month")).body)
  assert.deepEqual(page.groups.map(group => [group.key, group.reports[0].id]), [
    ["2027-01", reportId(4)], ["2026-12", reportId(3)], ["2024-03", reportId(2)], ["2024-02", reportId(1)],
  ])
})

for (const timezone of ["UTC", "America/Los_Angeles", "Asia/Tokyo"]) {
  test(`calendar grouping does not depend on TZ=${timezone}`, async () => {
    const { stdout } = await promisify(execFile)(process.execPath, ["--input-type=module", "--eval", `
      import { paginateReports } from ${JSON.stringify(new URL("../src/server/report-list.js", import.meta.url).href)}
      const rows = ${JSON.stringify([metadata(1, "2027-01-03T21:00:00.000Z")])}
      console.log(JSON.stringify(['week', 'month'].map(group =>
        paginateReports(rows, { group, limit: 30, cursor: null }).groups[0].key)))
    `], { env: { ...process.env, TZ: timezone }, timeout: 5_000 })
    assert.deepEqual(JSON.parse(stdout), ["2027-01-04", "2027-01"])
  })
}

test("keyset cursor orders equal instants by descending ID and survives fresh inserts", async (context) => {
  const rows = [metadata(1), metadata(3, "2026-09-26T15:00:00+03:00"), metadata(2), metadata(4, "2026-09-25T12:00:00Z")]
  const before = structuredClone(rows)
  const app = await serve(context, { store: { list: async () => rows } })
  const first = JSON.parse((await app.request("/api/reports?limit=2")).body)
  assert.deepEqual(ids(first), [reportId(3), reportId(2)])
  assert.equal(first.total, 4)
  assert.match(first.nextCursor, /^[A-Za-z0-9_-]+$/)
  assert.deepEqual(rows, before)

  rows.push(metadata(9, "2026-09-27T00:00:00Z"), metadata(8))
  const path = `/api/reports?group=week&limit=2&cursor=${first.nextCursor}`
  const pages = await Promise.all([app.request(path), app.request(path)])
  assert.equal(pages[0].body, pages[1].body)
  const second = JSON.parse(pages[0].body)
  assert.deepEqual(ids(second), [reportId(1), reportId(4)])
  assert.equal(second.total, 6)
  assert.equal(second.nextCursor, null)
  assert.equal(first.groups[0].key, second.groups[0].key)
  assert.deepEqual(ids(JSON.parse((await app.request("/api/reports?limit=2")).body)), [reportId(9), reportId(8)])

  rows.splice(rows.findIndex(row => row.id === reportId(2)), 1)
  assert.deepEqual(ids(JSON.parse((await app.request(path)).body)), [reportId(1), reportId(4)])
})

test("pagination counts reports, uses default 30, permits limit changes and splits groups", async (context) => {
  const rows = Array.from({ length: 101 }, (_, index) => metadata(index + 1))
  const app = await serve(context, { store: { list: async () => rows } })
  const first = JSON.parse((await app.request("/api/reports")).body)
  assert.equal(ids(first).length, 30)
  assert.equal(first.groups.length, 1)
  assert.equal(first.total, 101)
  const second = JSON.parse((await app.request(`/api/reports?limit=100&cursor=${first.nextCursor}`)).body)
  assert.equal(ids(second).length, 71)
  assert.equal(second.groups[0].key, first.groups[0].key)
  assert.equal(second.total, 101)
  assert.equal(second.nextCursor, null)
  assert.equal(new Set([...ids(first), ...ids(second)]).size, 101)
  assert.equal(ids(JSON.parse((await app.request("/api/reports?limit=100")).body)).length, 100)
})

test("empty archives and an exhausted or deleted cursor range return an empty page", async (context) => {
  const rows = []
  const app = await serve(context, { store: { list: async () => rows } })
  assert.deepEqual(JSON.parse((await app.request("/api/reports")).body), { groups: [], total: 0, nextCursor: null })
  rows.push(metadata(1), metadata(2))
  const first = JSON.parse((await app.request("/api/reports?limit=1")).body)
  rows.splice(0, 1)
  const path = `/api/reports?cursor=${first.nextCursor}`
  assert.deepEqual(JSON.parse((await app.request(path)).body), { groups: [], total: 1, nextCursor: null })
  rows.length = 0
  assert.deepEqual(JSON.parse((await app.request(path)).body), { groups: [], total: 0, nextCursor: null })
})

test("metadata response exposes only the public contract, never storage paths or SQL", async (context) => {
  const row = metadata(1)
  const app = await serve(context, { store: { list: async () => [{ ...row, directory: "/private/archive", sql: "SELECT secret" }] } })
  const response = await app.request("/api/reports")
  assert.deepEqual(JSON.parse(response.body).groups[0].reports, [row])
  assert.doesNotMatch(response.body, /private|SELECT|directory/)
})

test("invalid list parameters and malformed, noncanonical or cross-group cursors are rejected before storage", async (context) => {
  const app = await serve(context)
  const valid = [1, "week", Date.parse(metadata(1).reportCreatedAt), reportId(10)]
  const badCursors = [
    "", "!", "e30=", "a".repeat(513), Buffer.from("not json").toString("base64url"),
    ...[null, {}, [], [...valid, "extra"], [2, ...valid.slice(1)], [1, "month", ...valid.slice(2)],
      [1, "week", "0", valid[3]], [1, "week", 1.5, valid[3]], [1, "week", 9e15, valid[3]],
      [1, "week", valid[2], "../../secret"], [1, "week", valid[2], valid[3].toUpperCase()],
    ].map(encodeCursor),
  ]
  for (const query of [
    "group=day", "group=", "group=Week", "group=week&group=week", "limit=1&limit=2", "cursor=a&cursor=b",
    "limit=0", "limit=-1", "limit=101", "limit=1.5", "limit=1e2", "limit=01", "limit=", "limit=NaN",
    "limit=%202", "limit=Infinity", "offset=2", "__proto__=x", "group=%ZZ", "limit=2%00",
    ...badCursors.map(cursor => `cursor=${encodeURIComponent(cursor)}`),
  ]) {
    const response = await app.request(`/api/reports?${query}`)
    assert.equal(response.status, 400, query)
    assert.equal(response.headers["content-type"], "application/json; charset=utf-8")
    assert.equal(response.headers["x-content-type-options"], "nosniff")
  }
  assert.equal(app.store.list.mock.callCount(), 0)
})

test("unknown routes, unsafe paths, invalid IDs and unrecognized assets cannot reach storage", async (context) => {
  const app = await serve(context)
  for (const path of [
    "/assets/../index.html", "/api/reports/../reports", "/reports/./x", "/assets/%2e%2e/index.html",
    "/assets/%252e%252e", "/assets/%2fetc%2fpasswd", "/assets/..%5csecret", "/assets/\\secret",
    "/assets/.%2e/index.html", "/assets/report.js%00", "//assets/report.js", "http://localhost/",
    "/assets/report.js#fragment", `/reports/${reportId(1)}?unknown=1`, "/?path=secret",
    "/api/reports/not-a-uuid", "/reports/not-a-uuid", "/api/reports/123/download",
  ]) {
    const response = await app.request(path)
    assert.equal(response.status, 400, path)
  }
  for (const path of [
    "/missing", "/favicon.ico", "/reports", "/api/reports/", "/assets", "/assets/.env", "/assets/a/b.js",
    `/reports/${reportId(1)}/download`, `/api/reports/${reportId(1)}/other`, `/api/reports/${reportId(1)}/`,
  ]) {
    assert.equal((await app.request(path)).status, 404, path)
  }
  assert.equal(app.store.read.mock.callCount(), 0)
  assert.equal(app.store.list.mock.callCount(), 0)
  assert.equal(app.readWebAsset.mock.callCount(), 0)
  assert.equal((await app.request("/assets/secret.db")).status, 404)
  assert.deepEqual(app.readWebAsset.mock.calls[0].arguments, ["secret.db"])
})

test("missing reports get the shared shell without a read; JSON and download still return 404", async (context) => {
  const app = await serve(context)
  const shell = await app.request(`/reports/${reportId(1)}`)
  assert.equal(shell.status, 200)
  assert.equal(shell.body, "<!doctype html><title>Общий отчёт</title>")
  assert.equal(app.store.read.mock.callCount(), 0)
  for (const path of [`/api/reports/${reportId(1)}`, `/api/reports/${reportId(1)}/download`]) {
    const response = await app.request(path)
    assert.equal(response.status, 404)
    assert.deepEqual(JSON.parse(response.body), { error: "Report not found" })
  }
  assert.equal(app.store.read.mock.callCount(), 2)
  assert.equal(app.renderReportPage.mock.callCount(), 1)
  assert.equal(app.renderReportHtml.mock.callCount(), 0)
})

test("GET and HEAD shells remain available when the archive cannot be read", async (context) => {
  const app = await serve(context, {
    store: {
      read: context.mock.fn(async () => {
        throw new Error("Archive unavailable")
      }),
    },
  })
  const shell = await app.request(`/reports/${reportId(1)}`)
  const head = await app.request(`/reports/${reportId(1)}`, "HEAD")
  assert.equal(shell.status, 200)
  assert.equal(head.status, 200)
  assert.equal(head.body, "")
  assert.equal(head.headers["content-length"], shell.headers["content-length"])
  assert.equal(app.store.read.mock.callCount(), 0)
  assert.equal(app.store.list.mock.callCount(), 0)
})

test("HEAD matches GET headers and statuses, including errors, without a response body", async (context) => {
  const app = await serve(context, { store: { read: async id => id === reportId(1) ? metadata(1) : null } })
  for (const path of [
    "/", "/assets/report.css", "/assets/report.js", "/api/reports", `/reports/${reportId(1)}`,
    `/api/reports/${reportId(1)}`, `/api/reports/${reportId(1)}/download`, `/api/reports/${reportId(2)}`,
    "/missing", "/api/reports?limit=0",
  ]) {
    const get = await app.request(path)
    const head = await app.request(path, "HEAD")
    assert.equal(head.status, get.status, path)
    assert.equal(head.body, "", path)
    for (const header of ["content-type", "content-length", "content-disposition", "x-content-type-options", "cache-control"]) {
      assert.equal(head.headers[header], get.headers[header], `${path}: ${header}`)
    }
  }
})

test("unsupported methods return 405 and Allow without touching storage or renderers", async (context) => {
  const app = await serve(context)
  for (const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
    const response = await app.request("/api/reports", method)
    assert.equal(response.status, 405)
    assert.equal(response.headers.allow, "GET, HEAD")
    assert.equal(response.headers["x-content-type-options"], "nosniff")
  }
  assert.equal(app.store.list.mock.callCount(), 0)
  assert.equal(app.store.read.mock.callCount(), 0)
})

test("internal failures return sanitized 500 responses", async (context) => {
  context.mock.method(console, "error", () => {})
  const cause = new Error("SELECT * FROM reports at /private/archive/report.parquet")
  const failure = new SyntaxError("Invalid report archive", { cause })
  const fail = async () => {
    throw failure
  }
  for (const [overrides, paths] of [
    [{ store: { list: fail, read: fail } }, ["/api/reports", `/api/reports/${reportId(1)}`, `/api/reports/${reportId(1)}/download`]],
    [{ store: { list: async () => null } }, ["/api/reports"]],
    [{ store: { list: async () => [{ ...metadata(1), reportCreatedAt: "invalid" }] } }, ["/api/reports"]],
    [{ store: { list: async () => [{ ...metadata(1), reportCreatedAt: "2026-09-26T12:00:00" }] } }, ["/api/reports"]],
    [{ store: { read: async () => "corrupt" } }, [`/api/reports/${reportId(1)}`]],
    [{ readWebAsset: fail }, ["/", "/assets/report.css"]],
    [{ store: { read: async () => metadata(1) }, renderReportPage: fail, renderReportHtml: fail }, [`/reports/${reportId(1)}`, `/api/reports/${reportId(1)}/download`]],
  ]) {
    const app = await serve(context, overrides)
    for (const path of paths) {
      const response = await app.request(path)
      assert.equal(response.status, 500, path)
      assert.deepEqual(JSON.parse(response.body), { error: "Internal server error" })
      assert.doesNotMatch(response.body, /private|SELECT|SyntaxError/)
      assert.equal(response.headers["x-content-type-options"], "nosniff")
      const head = await app.request(path, "HEAD")
      assert.equal(head.status, 500)
      assert.equal(head.body, "")
      assert.equal(head.headers["content-length"], response.headers["content-length"])
    }
  }
})

test("multiple users can read different reports, pages and downloads concurrently", async (context) => {
  const rows = [metadata(1), metadata(2)]
  const app = await serve(context, {
    store: {
      list: async () => rows,
      read: async (id) => {
        await new Promise(resolve => setImmediate(resolve))
        return rows.find(row => row.id === id) ?? null
      },
    },
  })
  await Promise.all(Array.from({ length: 24 }, async (_, index) => {
    const row = rows[index % 2]
    const suffix = index % 3 === 0 ? "/download" : ""
    const response = await app.request(`/api/reports/${row.id}${suffix}`)
    assert.equal(response.status, 200)
    if (suffix) {
      assert.equal(response.body, `<!doctype html><title>Offline ${row.id}</title>`)
    } else {
      assert.deepEqual(JSON.parse(response.body), row)
    }
  }))
  const [week, month] = await Promise.all([app.request("/api/reports?group=week&limit=1"), app.request("/api/reports?group=month&limit=2")])
  assert.equal(ids(JSON.parse(week.body)).length, 1)
  assert.equal(ids(JSON.parse(month.body)).length, 2)
  assert.equal(app.store.close.mock.callCount(), 0)
})

test("listen settings default to loopback and validate explicit ports and hosts", () => {
  assert.deepEqual(readListenOptions({}), { host: "127.0.0.1", port: 3000 })
  for (const host of ["localhost", "127.0.0.1", "0.0.0.0", "::1", "my-host.local"]) {
    assert.deepEqual(readListenOptions({ HOST: host, PORT: "65535" }), { host, port: 65535 })
  }
  assert.equal(readListenOptions({ PORT: "0" }).port, 0)
  for (const port of ["", " ", "3000 ", "-1", "65536", "1.5", "3e3", "03000", "NaN", "Infinity", 3000]) {
    assert.throws(() => readListenOptions({ PORT: port }), /PORT/)
  }
  for (const host of ["", " ", "localhost:3000", "http://localhost", "a/b", "a\\b", "[::1]", "bad_host", "-host", "host-", "a..b", "999.1.1.1", "a".repeat(64), 123]) {
    assert.throws(() => readListenOptions({ HOST: host }), /HOST/)
  }
})

test("owning lifecycle closes its store exactly once and removes signal listeners", async (context) => {
  const store = { list: async () => [], read: async () => null, close: context.mock.fn(async () => {}) }
  const before = ["SIGINT", "SIGTERM"].map(signal => process.listenerCount(signal))
  const app = await startReportServer({ env: { PORT: "0", HOST: "127.0.0.1" }, createStore: async () => store })
  context.after(() => app.close())
  assert.equal(app.server.listening, true)
  assert.equal((await request(app.server, "/api/reports")).status, 200)
  assert.equal(store.close.mock.callCount(), 0)
  assert.deepEqual(["SIGINT", "SIGTERM"].map(signal => process.listenerCount(signal)), before.map(count => count + 1))
  const closing = app.close()
  assert.equal(app.close(), closing)
  await closing
  assert.equal(app.server.listening, false)
  assert.equal(store.close.mock.callCount(), 1)
  assert.deepEqual(["SIGINT", "SIGTERM"].map(signal => process.listenerCount(signal)), before)
})

test("shutdown drains an active read before closing the owned store", async (context) => {
  const reading = Promise.withResolvers()
  const report = Promise.withResolvers()
  const store = {
    list: async () => [],
    read: async () => {
      reading.resolve()
      return report.promise
    },
    close: context.mock.fn(async () => {}),
  }
  const app = await startReportServer({ env: { PORT: "0" }, createStore: async () => store })
  context.after(async () => {
    report.resolve(metadata(1))
    await app.close()
  })
  const response = request(app.server, `/api/reports/${reportId(1)}`)
  await reading.promise
  const closing = app.close()
  assert.equal(store.close.mock.callCount(), 0)
  report.resolve(metadata(1))
  assert.equal((await response).status, 200)
  await closing
  assert.equal(store.close.mock.callCount(), 1)
})

test("failed startup closes only an already-created store; bad env never creates one", async (context) => {
  const createStore = context.mock.fn()
  await assert.rejects(startReportServer({ env: { PORT: "bad" }, createStore }), /PORT/)
  assert.equal(createStore.mock.callCount(), 0)

  const occupied = await serve(context)
  const store = { list: async () => [], read: async () => null, close: context.mock.fn(async () => {}) }
  await assert.rejects(startReportServer({
    env: { PORT: String(occupied.server.address().port), HOST: "127.0.0.1" },
    createStore: async () => store,
  }), { code: "EADDRINUSE" })
  assert.equal(store.close.mock.callCount(), 1)
})

for (const signal of ["SIGINT", "SIGTERM"]) {
  test(`${signal} stops the standalone lifecycle and closes its store`, async () => {
    const { stdout, stderr } = await promisify(execFile)(process.execPath, ["--input-type=module", "--eval", `
      import { startReportServer } from ${JSON.stringify(new URL("../src/server/index.js", import.meta.url).href)}
      await startReportServer({ env: { HOST: '127.0.0.1', PORT: '0' }, createStore: async () => ({
        list: async () => [], read: async () => null,
        close: async () => console.log('store closed'),
      }) })
      process.kill(process.pid, ${JSON.stringify(signal)})
    `], { timeout: 5_000 })
    assert.equal(stdout.trim(), "store closed")
    assert.equal(stderr, "")
  })
}

test("independent executable fails for invalid environment and identifies the invalid setting", async () => {
  await assert.rejects(promisify(execFile)(process.execPath, [new URL("../src/server/index.js", import.meta.url).pathname], {
    env: { ...process.env, PORT: "not-a-port" }, timeout: 5_000,
  }), (error) => {
    assert.equal(error.code, 1)
    assert.match(error.stderr, /PORT/)
    return true
  })
})
