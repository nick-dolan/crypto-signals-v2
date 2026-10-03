import assert from "node:assert/strict"
import test from "node:test"
import vm from "node:vm"

import { renderReportPage } from "../src/reports/render-report-html.js"
import { readWebAsset } from "../src/web/read-web-asset.js"

function createNode (tag = "div") {
  let text = ""
  return {
    tagName: tag.toUpperCase(), children: [], attributes: new Map(), listeners: new Map(),
    hidden: false, disabled: false,
    get textContent () {
      return text + this.children.map(child => child.textContent).join("")
    },
    set textContent (value) {
      text = String(value)
      this.children = []
    },
    set innerHTML (value) {
      assert.fail(`Unsafe HTML assignment: ${value}`)
    },
    append (...children) {
      this.children.push(...children)
    },
    replaceChildren (...children) {
      this.textContent = ""
      this.append(...children)
    },
    setAttribute (name, value) {
      this.attributes.set(name, String(value))
    },
    addEventListener (name, listener) {
      this.listeners.set(name, listener)
    },
  }
}

function descendants (node) {
  return [node, ...node.children.flatMap(descendants)]
}

async function settle () {
  await new Promise(resolve => setImmediate(resolve))
}

async function browser (t, { page = "list", pathname = "/reports/12345678-1234-4234-8234-123456789abc", renderReport } = {}) {
  const html = page === "list" ? (await readWebAsset("index.html")).content : await renderReportPage()
  const nodes = new Map([...html.matchAll(/<[^>]+\bid="([^"]+)"[^>]*>/g)].map(([tag, id]) => {
    const node = createNode(tag.match(/^<(\w+)/)[1])
    node.hidden = /\bhidden\b/.test(tag)
    node.disabled = /\bdisabled\b/.test(tag)
    for (const [, name, value] of tag.matchAll(/([\w-]+)="([^"]*)"/g)) {
      node.setAttribute(name, value)
    }
    return [id, node]
  }))
  const byId = id => nodes.get(id) ?? null
  const requests = []
  const rendered = []
  const timers = new Map()
  let timerId = 0
  const context = vm.createContext({
    document: { getElementById: byId, createElement: createNode },
    location: { pathname }, URL, URLSearchParams, AbortController,
    setTimeout: (callback, delay) => {
      timers.set(++timerId, { callback, delay })
      return timerId
    },
    clearTimeout: id => timers.delete(id),
    fetch: (url, options) => {
      assert.match(url, /^\/api\/reports(?:\?|\/)/)
      const pending = Promise.withResolvers()
      options.signal.addEventListener("abort", () => pending.reject(new Error("Aborted")))
      requests.push({ url, options, ...pending })
      return pending.promise
    },
    renderReport: () => {
      assert.equal(byId("report-shell").hidden, false, "Charts must see a visible container")
      const data = JSON.parse(byId("report-data").textContent)
      rendered.push(data)
      renderReport?.(data)
    },
  })
  t.after(async () => {
    requests.forEach(request => request.reject(new Error("Test finished")))
    await settle()
  })
  for (const name of ["browser-helpers.js", page === "list" ? "reports-list.js" : "report-loader.js"]) {
    new vm.Script((await readWebAsset(name)).content, { filename: name }).runInContext(context, { timeout: 1_000 })
  }
  return {
    byId, requests, rendered, timers,
    click: id => byId(id).listeners.get("click")(),
    async reply (index, payload, status = 200) {
      requests[index].resolve({
        ok: status >= 200 && status < 300, status,
        // Real response.json() creates values in the browser's realm.
        json: async () => vm.runInContext("JSON.parse", context)(JSON.stringify(payload)),
      })
      await settle()
    },
    async invalidJson (index) {
      requests[index].resolve({
        ok: true, status: 200,
        json: async () => {
          throw new SyntaxError("<unsafe>")
        },
      })
      await settle()
    },
    async reject (index) {
      requests[index].reject(new Error("<img src=x onerror=alert(1)>"))
      await settle()
    },
    async timeout () {
      const timer = [...timers.values()][0]
      assert.ok(timer.delay > 0)
      timer.callback()
      await settle()
    },
  }
}

function summary (index = 1, overrides = {}) {
  return {
    id: `12345678-1234-4234-8234-${String(index).padStart(12, "0")}`,
    reportCreatedAt: "2026-09-27T21:30:45.000Z", asOf: "2026-09-27T20:00:00.000Z",
    candidateCount: 2, universeCoinCount: 300, ...overrides,
  }
}

function listPage (reports = [summary()], { key = "2026-09-28", label = "28 сентября — 4 октября", total = reports.length, nextCursor = null } = {}) {
  return { groups: reports.length ? [{ key, label, reports }] : [], total, nextCursor }
}

function reportLinks (view) {
  return descendants(view.byId("report-groups")).filter(node => node.className === "report-open")
}

test("list loads the API contract, preserves newest-first groups and formats timestamps in fixed UTC+3", async (t) => {
  const view = await browser(t)
  assert.equal(view.requests.length, 1)
  assert.equal(view.requests[0].url, "/api/reports?group=week&limit=30")
  assert.equal(view.requests[0].options.method, "GET")
  assert.equal(view.requests[0].options.credentials, "same-origin")
  assert.equal(view.requests[0].options.cache, "no-store")
  assert.equal(view.requests[0].options.headers.Accept, "application/json")
  assert.equal(view.byId("report-groups").attributes.get("aria-busy"), "true")
  assert.match(view.byId("reports-message").textContent, /Загружаем/)
  assert.equal(view.byId("reports-previous").disabled, true)
  assert.equal(view.byId("reports-next").disabled, true)
  const page = listPage([summary(), summary(2, { candidateCount: 0 })], { total: 3 })
  page.groups.push({ key: "2026-09-21", label: "21–27 сентября", reports: [summary(3)] })
  await view.reply(0, page)
  const groups = view.byId("report-groups").children
  assert.deepEqual(groups.map(node => node.children[0].children[0].textContent), ["28 сентября — 4 октября", "21–27 сентября"])
  assert.deepEqual(reportLinks(view).map(node => node.href), [1, 2, 3].map(index => `/reports/${summary(index).id}`))
  assert.match(reportLinks(view)[0].textContent, /28 сент.*2026.*00:30:45/)
  assert.match(groups[0].textContent, /Срез: 27 сент.*23:00:00/)
  assert.match(groups[0].textContent, /Кандидатов: 0/)
  const downloads = descendants(view.byId("report-groups")).filter(node => node.className === "report-download")
  assert.equal(downloads[0].href, `/api/reports/${summary().id}/download`)
  assert.equal(downloads[0].download, "")
  assert.equal(view.byId("reports-state").hidden, true)
  assert.equal(view.byId("report-groups").attributes.get("aria-busy"), "false")
  assert.equal(view.byId("reports-summary").textContent, "Всего: 3 · показано 1–3 · UTC+3")
  assert.equal(view.timers.size, 0)
  assert.equal(view.requests.length, 1)
})

test("an empty list is distinct from loading and errors", async (t) => {
  const view = await browser(t)
  await view.reply(0, listPage([]))
  assert.match(view.byId("reports-message").textContent, /Сохранённых отчётов пока нет/)
  assert.equal(view.byId("reports-state").hidden, false)
  assert.equal(view.byId("reports-retry").hidden, true)
  assert.equal(view.byId("reports-previous").disabled, true)
  assert.equal(view.byId("reports-next").disabled, true)
  assert.equal(view.byId("report-groups").children.length, 0)
})

test("pagination keeps opaque cursors, continued groups and cached back/forward pages stable until explicit refresh", async (t) => {
  const view = await browser(t)
  const cursor = "opaque+/=?&%# ещё"
  await view.reply(0, listPage([summary()], { total: 3, nextCursor: cursor }))
  const next = view.click("reports-next")
  view.click("reports-next")
  assert.equal(view.requests.length, 2, "Repeated clicks cannot issue duplicate requests")
  assert.equal(new URL(view.requests[1].url, "https://local.invalid").searchParams.get("cursor"), cursor)
  assert.equal(view.byId("reports-next").disabled, true)
  await view.reply(1, listPage([summary(2), summary(3)], { total: 3 }))
  await next
  assert.equal(view.byId("reports-page").textContent, "Страница 2")
  assert.match(view.byId("report-groups").textContent, /Продолжение/)
  assert.equal(view.byId("reports-summary").textContent, "Всего: 3 · показано 2–3 · UTC+3")
  assert.equal(view.byId("reports-next").disabled, true)
  await view.click("reports-previous")
  assert.equal(view.requests.length, 2)
  assert.deepEqual(reportLinks(view).map(node => node.href), [`/reports/${summary().id}`])
  assert.doesNotMatch(view.byId("report-groups").textContent, /Продолжение/)
  await view.click("reports-next")
  assert.equal(view.requests.length, 2, "Returning forward must also use the cached page")
  assert.deepEqual(reportLinks(view).map(node => node.href), [2, 3].map(index => `/reports/${summary(index).id}`))
  const refresh = view.click("reports-refresh")
  assert.equal(view.byId("report-groups").children.length, 0)
  assert.equal(view.requests[2].url, "/api/reports?group=week&limit=30")
  await view.reply(2, listPage([summary(4)], { total: 4, nextCursor: "new-snapshot" }))
  await refresh
  assert.equal(view.byId("reports-page").textContent, "Страница 1")
  assert.equal(view.byId("reports-previous").disabled, true)
  assert.deepEqual(reportLinks(view).map(node => node.href), [`/reports/${summary(4).id}`])
})

test("changing grouping discards pagination and ignores old successful or failed requests", async (t) => {
  const view = await browser(t)
  const month = view.click("group-month")
  assert.equal(view.requests[1].url, "/api/reports?group=month&limit=30")
  const week = view.click("group-week")
  assert.equal(view.requests[2].url, "/api/reports?group=week&limit=30")
  await view.reply(2, listPage([summary(3)], { nextCursor: "week-page-2" }))
  await week
  await view.reply(0, listPage([summary(1)]))
  await view.reply(1, {}, 500)
  await month
  assert.deepEqual(reportLinks(view).map(node => node.href), [`/reports/${summary(3).id}`])
  assert.equal(view.byId("reports-state").hidden, true)
  assert.equal(view.byId("group-week").attributes.get("aria-pressed"), "true")
  assert.equal(view.byId("group-month").attributes.get("aria-pressed"), "false")
  const next = view.click("reports-next")
  await view.reply(3, listPage([summary(4)]))
  await next
  const changed = view.click("group-month")
  assert.equal(view.requests[4].url, "/api/reports?group=month&limit=30")
  await view.reply(4, listPage([summary(5)], { key: "2026-09", label: "Сентябрь 2026" }))
  await changed
  assert.equal(view.byId("reports-page").textContent, "Страница 1")
  assert.equal(view.byId("reports-previous").disabled, true)
  assert.match(view.byId("report-groups").textContent, /Сентябрь 2026/)
})

for (const failure of ["HTTP", "network", "JSON", "schema", "timeout"]) {
  test(`list ${failure} failure has a safe error state and a working retry`, async (t) => {
    const view = await browser(t)
    if (failure === "HTTP") {
      await view.reply(0, { message: "<script>unsafe()</script>" }, 503)
    } else if (failure === "network") {
      await view.reject(0)
    } else if (failure === "JSON") {
      await view.invalidJson(0)
    } else if (failure === "schema") {
      await view.reply(0, { groups: null, total: 3, nextCursor: null })
    } else {
      await view.timeout()
      assert.equal(view.requests[0].options.signal.aborted, true)
    }
    assert.match(view.byId("reports-message").textContent, /Не удалось загрузить список/)
    assert.doesNotMatch(view.byId("reports-message").textContent, /unsafe|<img|<script/)
    assert.equal(view.byId("reports-retry").hidden, false)
    assert.equal(view.byId("report-groups").attributes.get("aria-busy"), "false")
    assert.equal(view.timers.size, 0)
    const retry = view.click("reports-retry")
    assert.equal(view.requests[1].url, view.requests[0].url)
    await view.reply(1, listPage())
    await retry
    assert.equal(view.byId("reports-state").hidden, true)
    assert.equal(reportLinks(view).length, 1)
  })
}

test("failed next page preserves the current page and retries the same cursor without advancing the stack", async (t) => {
  const view = await browser(t)
  await view.reply(0, listPage([summary()], { total: 2, nextCursor: "stable-cursor" }))
  const rows = view.byId("report-groups").children
  const next = view.click("reports-next")
  await view.reject(1)
  await next
  assert.equal(view.byId("report-groups").children, rows)
  assert.equal(view.byId("reports-page").textContent, "Страница 1")
  const retry = view.click("reports-retry")
  assert.equal(view.requests[2].url, view.requests[1].url)
  await view.reply(2, listPage([summary(2)], { total: 2 }))
  await retry
  assert.equal(view.byId("reports-page").textContent, "Страница 2")
  await view.click("reports-previous")
  assert.equal(view.requests.length, 3)
  assert.equal(reportLinks(view)[0].href, `/reports/${summary().id}`)
})

test("API group labels remain literal text and invalid report IDs never become navigable paths", async (t) => {
  const view = await browser(t)
  const unsafe = "</script><img src=x onerror=alert(1)>"
  await view.reply(0, listPage([summary()], { key: unsafe, label: unsafe }))
  assert.equal(view.byId("report-groups").children[0].children[0].children[0].textContent, unsafe)
  assert.equal(descendants(view.byId("report-groups")).some(node => ["SCRIPT", "IMG"].includes(node.tagName)), false)
  const refresh = view.click("reports-refresh")
  await view.reply(1, listPage([summary(1, { id: "../../elsewhere" })]))
  await refresh
  assert.equal(reportLinks(view).length, 0)
  assert.match(view.byId("reports-message").textContent, /Не удалось/)
})

test("report loader waits for JSON, renders once through the shared renderer and exposes the download link", async (t) => {
  const view = await browser(t, { page: "report" })
  assert.equal(view.requests[0].url, "/api/reports/12345678-1234-4234-8234-123456789abc")
  assert.equal(view.byId("report-shell").hidden, true)
  assert.equal(view.byId("report-download").hidden, true)
  assert.match(view.byId("report-load-message").textContent, /Загружаем/)
  view.click("report-retry")
  assert.equal(view.requests.length, 1)
  const report = { asOf: "2026-09-26T00:00:00.000Z", coins: [], objective: "</script><img src=x onerror=alert(1)>" }
  await view.reply(0, report)
  assert.deepEqual(view.rendered, [report])
  assert.equal(view.byId("report-shell").hidden, false)
  assert.equal(view.byId("report-load-state").hidden, true)
  assert.equal(view.byId("report-load-state").attributes.get("aria-busy"), "false")
  assert.equal(view.byId("report-download").hidden, false)
  assert.equal(view.byId("report-download").href, "/api/reports/12345678-1234-4234-8234-123456789abc/download")
  assert.deepEqual(JSON.parse(view.byId("report-data").textContent), report)
  assert.equal(view.byId("report-data").children.length, 0)
  assert.equal(view.requests.length, 1)
  assert.equal(view.timers.size, 0)
})

test("missing reports and invalid URLs show not-found states without rendering or offering a bogus download", async (t) => {
  const missing = await browser(t, { page: "report" })
  await missing.reply(0, { error: "<b>missing</b>" }, 404)
  assert.match(missing.byId("report-load-message").textContent, /Отчёт не найден/)
  assert.equal(missing.byId("report-retry").hidden, true)
  assert.equal(missing.byId("report-download").hidden, true)
  assert.equal(missing.byId("report-shell").hidden, true)
  assert.equal(missing.rendered.length, 0)
  for (const pathname of ["/reports/invalid", "/reports/..", "/reports/%2fetc%2fpasswd", "/reports/", "/reports/id/download"]) {
    const invalid = await browser(t, { page: "report", pathname })
    assert.equal(invalid.requests.length, 0)
    assert.match(invalid.byId("report-load-message").textContent, /некорректный адрес/)
    assert.equal(invalid.byId("report-load-state").attributes.get("aria-busy"), "false")
  }
})

for (const failure of ["HTTP", "network", "JSON", "schema", "timestamp", "timeout"]) {
  test(`report ${failure} failure can be retried without revealing an empty report`, async (t) => {
    const view = await browser(t, { page: "report" })
    if (failure === "HTTP") {
      await view.reply(0, {}, 500)
    } else if (failure === "network") {
      await view.reject(0)
    } else if (failure === "JSON") {
      await view.invalidJson(0)
    } else if (failure === "schema") {
      await view.reply(0, { asOf: "2026-09-26T00:00:00.000Z", coins: {} })
    } else if (failure === "timestamp") {
      await view.reply(0, { asOf: "invalid", coins: [] })
    } else {
      await view.timeout()
    }
    assert.match(view.byId("report-load-message").textContent, /Не удалось загрузить отчёт/)
    assert.equal(view.byId("report-retry").hidden, false)
    assert.equal(view.byId("report-shell").hidden, true)
    assert.equal(view.byId("report-download").hidden, true)
    assert.equal(view.rendered.length, 0)
    const retry = view.click("report-retry")
    await view.reply(1, { asOf: "2026-09-26T00:00:00.000Z", coins: [] })
    await retry
    assert.equal(view.byId("report-shell").hidden, false)
    assert.equal(view.byId("report-load-state").hidden, true)
    assert.equal(view.rendered.length, 1)
  })
}

test("renderer failures also leave a recoverable error state instead of a partly rendered report", async (t) => {
  let fails = true
  const view = await browser(t, {
    page: "report",
    renderReport: () => {
      if (fails) {
        throw new Error("Rendering failed")
      }
    },
  })
  await view.reply(0, { asOf: "2026-09-26T00:00:00.000Z", coins: [] })
  assert.equal(view.byId("report-shell").hidden, true)
  assert.equal(view.byId("report-retry").hidden, false)
  fails = false
  const retry = view.click("report-retry")
  await view.reply(1, { asOf: "2026-09-26T00:00:00.000Z", coins: [] })
  await retry
  assert.equal(view.byId("report-shell").hidden, false)
  assert.equal(view.byId("report-load-state").hidden, true)
})
