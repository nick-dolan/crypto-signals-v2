import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { once } from "node:events"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { setTimeout as delay } from "node:timers/promises"
import { pathToFileURL } from "node:url"

import { isArray, isFinite, isString } from "../src/helpers/utils.typed.js"

function connectBrowser (browser) {
  let sequence = 0
  let buffer = ""
  const pending = new Map()
  const listeners = new Map()

  function rejectPending (error) {
    for (const request of pending.values()) {
      clearTimeout(request.timer)
      request.reject(error)
    }
    pending.clear()
  }

  browser.once("error", rejectPending)
  browser.once("exit", (code, signal) => rejectPending(new Error(`Browser exited: ${code} ${signal}`)))
  browser.stdio[3].on("error", rejectPending)
  browser.stdio[4].setEncoding("utf8")
  browser.stdio[4].on("data", (chunk) => {
    buffer += chunk
    for (let end = buffer.indexOf("\0"); end !== -1; end = buffer.indexOf("\0")) {
      const message = JSON.parse(buffer.slice(0, end))
      buffer = buffer.slice(end + 1)
      if (message.id) {
        const request = pending.get(message.id)
        if (request) {
          clearTimeout(request.timer)
          pending.delete(message.id)
          if (message.error) {
            request.reject(new Error(`${request.method}: ${JSON.stringify(message.error)}`))
          } else {
            request.resolve(message.result)
          }
        }
      } else {
        for (const listener of listeners.get(message.method) ?? []) {
          listener(message.params, message.sessionId)
        }
      }
    }
  })

  return {
    on (method, listener) {
      if (!listeners.has(method)) {
        listeners.set(method, [])
      }
      listeners.get(method).push(listener)
    },
    send (method, params = {}, sessionId) {
      return new Promise((resolve, reject) => {
        const id = ++sequence
        const timer = setTimeout(() => {
          pending.delete(id)
          reject(new Error(`CDP deadline: ${method}`))
        }, 8_000)
        pending.set(id, { method, resolve, reject, timer })
        browser.stdio[3].write(`${JSON.stringify({ id, method, params, sessionId })}\0`)
      })
    },
  }
}

async function waitFor (check, label) {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    try {
      if (await check()) {
        return
      }
    } catch (error) {
      if (!/Execution context was destroyed|Cannot find context/.test(error.message)) {
        throw error
      }
    }
    await delay(50)
  }
  throw new Error(`Smoke check deadline: ${label}`)
}

function weekKey (date) {
  const local = new Date(date.getTime() + 3 * 3_600_000)
  local.setUTCDate(local.getUTCDate() - (local.getUTCDay() + 6) % 7)
  return local.toISOString().slice(0, 10)
}

// Explicit opt-in: both paths are required; the ordinary suite never launches a browser or reads a local report.
test("real browser: temporary archive, list, charts, peer radar and server-independent HTML download", {
  skip: !(process.env.REPORT_BROWSER && process.env.REPORT_SMOKE_HTML)
    && "Set both REPORT_BROWSER (Chromium/Brave executable) and REPORT_SMOKE_HTML (exported report HTML) to run this smoke check",
  timeout: 85_000,
}, async (t) => {
  const sourcePath = process.env.REPORT_SMOKE_HTML
  const source = await fs.readFile(sourcePath, "utf8")
  const embedded = source.match(/<script id="report-data" type="application\/json">([\s\S]*?)<\/script>/)?.[1]
  assert.ok(embedded, "REPORT_SMOKE_HTML must point to an exported report HTML containing the report-data JSON script")
  const report = JSON.parse(embedded)
  assert.ok(
    isArray(report?.coins) && report.coins.length > 0
    && report.coins.every(coin => isString(coin?.symbol) && coin.symbol.trim()),
    "REPORT_SMOKE_HTML must contain at least one candidate with a nonempty symbol; choose a report with candidates",
  )
  assert.ok(
    report.peerRadar?.status === "available" && isArray(report.peerRadar.data?.observations)
    && report.peerRadar.data.observations.length > 0,
    "REPORT_SMOKE_HTML must include an available, nonempty peer radar; choose a report with saved radar observations and chart histories",
  )
  assert.ok(
    isString(report.reportCreatedAt) && isFinite(Date.parse(report.reportCreatedAt)),
    "REPORT_SMOKE_HTML must include a valid reportCreatedAt timestamp for the calendar grouping smoke check",
  )
  const initialCoin = report.coins.filter(coin => coin.topRank != null)
    .sort((first, second) => first.topRank - second.topRank)[0] ?? report.coins[0]
  assert.ok(
    isArray(initialCoin.history?.candles) && initialCoin.history.candles.length > 0,
    `REPORT_SMOKE_HTML must include saved candles for the initially selected candidate (${initialCoin.symbol}); choose a report with chart history`,
  )
  const selectedCoin = report.coins.find(coin => coin.symbol !== initialCoin.symbol
    && isArray(coin.history?.candles) && coin.history.candles.length > 0) ?? initialCoin
  const matchingCoins = report.coins.filter(coin => `${coin.symbol} ${coin.name}`.toLocaleLowerCase()
    .includes(selectedCoin.symbol.trim().toLocaleLowerCase()))
  const dates = Array.from({ length: 32 }, (_, day) => new Date(Date.parse(report.reportCreatedAt) - day * 86_400_000))
  const weeks = dates.map(weekKey)
  const monthLabels = [...new Set(dates.slice(0, 30).map(date => new Intl.DateTimeFormat("ru-RU", {
    timeZone: "Etc/GMT-3", year: "numeric", month: "long",
  }).format(date)))]
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "report-browser-smoke-"))
  let store
  let server
  let browser
  let stderr = ""
  let deadlineReached = false
  const killBrowser = () => {
    if (browser?.pid) {
      try {
        // A separate process group also contains Chromium's renderers and helpers.
        process.kill(-browser.pid, "SIGKILL")
      } catch (error) {
        if (error.code !== "ESRCH") {
          throw error
        }
      }
    }
  }
  const watchdog = setTimeout(() => {
    deadlineReached = true
    killBrowser()
    server?.closeAllConnections()
    server?.close()
  }, 70_000)
  async function closeServer () {
    if (server?.listening) {
      await new Promise((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve())
        server.closeAllConnections()
      })
    }
  }

  try {
    const { createReportStore } = await import("../src/reports/store.js")
    const { createReportServer } = await import("../src/server/index.js")
    store = await createReportStore({ directory: path.join(directory, "archive") })
    const saved = await store.save(report)
    // Small, unmistakably synthetic entries exercise calendar grouping and the 30-report cursor boundary.
    for (const date of dates.slice(1)) {
      await store.save({
        reportCreatedAt: date.toISOString(),
        asOf: report.asOf, candidateCount: 0, universeCoinCount: report.universeCoinCount,
        coins: [], objective: "Temporary browser smoke fixture",
      })
    }
    server = createReportServer({ store })
    await new Promise((resolve, reject) => {
      server.once("error", reject)
      server.listen(0, "127.0.0.1", resolve)
    })
    const origin = `http://127.0.0.1:${server.address().port}`
    await fs.mkdir(path.join(directory, "downloads"))
    browser = spawn(process.env.REPORT_BROWSER, [
      "--headless=new", "--remote-debugging-pipe", `--user-data-dir=${path.join(directory, "profile")}`,
      "--no-first-run", "--no-default-browser-check", "--disable-background-networking",
      "--disable-component-update", "--disable-default-apps", "--disable-sync", "--disable-extensions",
      "--disable-breakpad", "--disable-crash-reporter", "--disable-client-side-phishing-detection",
      "--metrics-recording-only", "--proxy-server=http://127.0.0.1:9", "--proxy-bypass-list=127.0.0.1;localhost",
      "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1", "about:blank",
    ], { detached: true, stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"] })
    browser.stderr.on("data", (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-12_000)
    })
    const client = connectBrowser(browser)
    const version = await client.send("Browser.getVersion")
    const { targetId } = await client.send("Target.createTarget", { url: "about:blank" })
    const { sessionId } = await client.send("Target.attachToTarget", { targetId, flatten: true })
    const send = (method, params) => client.send(method, params, sessionId)
    const errors = []
    const resourceErrors = []
    const requests = []
    const blocked = []
    let offline = false
    client.on("Runtime.exceptionThrown", ({ exceptionDetails }) => errors.push(exceptionDetails.exception?.description ?? exceptionDetails.text))
    client.on("Runtime.consoleAPICalled", ({ type, args }) => {
      if (type === "error") {
        errors.push(args.map(argument => argument.value ?? argument.description).join(" "))
      }
    })
    client.on("Log.entryAdded", ({ entry }) => {
      if (entry.level === "error") {
        resourceErrors.push({ source: entry.source, text: entry.text, url: entry.url })
      }
    })
    client.on("Network.requestWillBeSent", ({ request }) => requests.push({ url: request.url, offline }))
    client.on("Fetch.requestPaused", ({ requestId, request }, session) => {
      const url = new URL(request.url)
      const allowed = !["http:", "https:"].includes(url.protocol) || (!offline && url.origin === origin)
      if (!allowed) {
        blocked.push(request.url)
      }
      client.send(allowed ? "Fetch.continueRequest" : "Fetch.failRequest", {
        requestId, ...(!allowed && { errorReason: "BlockedByClient" }),
      }, session).catch(error => errors.push(error.message))
    })
    await send("Page.enable")
    await send("Runtime.enable")
    await send("Log.enable")
    await send("Network.enable")
    await send("Network.setCacheDisabled", { cacheDisabled: true })
    await send("Fetch.enable", { patterns: [{ urlPattern: "*", requestStage: "Request" }] })
    await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false })
    await client.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: path.join(directory, "downloads") })
    const evaluate = async (expression) => {
      const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true, userGesture: true })
      if (result.exceptionDetails) {
        throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text)
      }
      return result.result.value
    }
    const click = selector => evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`)
    const frames = () => evaluate("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))")
    const navigate = async (url, ready) => {
      const result = await send("Page.navigate", { url })
      assert.equal(result.errorText, undefined)
      await waitFor(() => evaluate(`location.href === ${JSON.stringify(url)} && (${ready})`), url)
      await frames()
    }

    await navigate(`${origin}/`, "document.querySelectorAll('.report-open').length === 30")
    const weekly = await evaluate("({ labels: [...document.querySelectorAll('.report-group h2')].map(node => node.textContent), hrefs: [...document.querySelectorAll('.report-open')].map(node => node.getAttribute('href')), summary: document.querySelector('#reports-summary').textContent })")
    assert.equal(weekly.hrefs[0], `/reports/${saved.id}`)
    assert.match(weekly.summary, /Всего: 32.*1–30/)
    assert.equal(weekly.labels.length, new Set(weeks.slice(0, 30)).size)
    await click("#reports-next")
    await waitFor(() => evaluate("document.querySelector('#reports-page').textContent === 'Страница 2' && document.querySelectorAll('.report-open').length === 2"), "second cursor page")
    assert.equal(
      (await evaluate("document.querySelector('#report-groups').textContent")).includes("Продолжение"),
      weeks.slice(30).some(week => weeks.slice(0, 30).includes(week)),
    )
    const beforeBack = requests.filter(item => item.url.includes("/api/reports?")).length
    await click("#reports-previous")
    assert.deepEqual(await evaluate("[...document.querySelectorAll('.report-open')].map(node => node.getAttribute('href'))"), weekly.hrefs)
    assert.equal(requests.filter(item => item.url.includes("/api/reports?")).length, beforeBack)
    await click("#group-month")
    await waitFor(() => evaluate(`document.querySelector('#report-groups').getAttribute('aria-busy') === 'false' && document.querySelectorAll('.report-group').length === ${monthLabels.length}`), "month groups")
    const monthly = await evaluate("[...document.querySelectorAll('.report-group h2')].map(node => node.textContent)")
    assert.deepEqual(monthly, monthLabels)
    await click("#group-week")
    await waitFor(() => evaluate(`document.querySelector('#report-groups').getAttribute('aria-busy') === 'false' && document.querySelectorAll('.report-group').length === ${weekly.labels.length}`), "week groups restored")

    async function inspectReport () {
      assert.equal(await evaluate("document.querySelector('#coin-symbol').textContent"), initialCoin.symbol)
      assert.equal(await evaluate("document.querySelectorAll('#candidate-rows tr[data-symbol]').length"), report.candidateCount)
      await frames()
      const chart = await evaluate(`(() => {
        const node = document.querySelector('#chart');
        const canvas = node.querySelector('canvas');
        const colors = new Set();
        if (canvas?.width && canvas.height) {
          const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
          for (let index = 0; index < pixels.length && colors.size < 32; index += 16) {
            if (pixels[index + 3]) colors.add(pixels.slice(index, index + 4).join(','));
          }
        }
        return { width: node.clientWidth, height: node.clientHeight, canvases: node.querySelectorAll('canvas').length,
          colors: colors.size, empty: !document.querySelector('#chart-empty').hidden, library: LightweightCharts.version() };
      })()`)
      assert.ok(chart.width > 500 && chart.height > 100)
      assert.ok(chart.canvases > 0 && chart.colors > 3, JSON.stringify(chart))
      assert.equal(chart.empty, false)
      await click("[data-days='1']")
      assert.equal(await evaluate("document.querySelector('[data-days=\"1\"]').getAttribute('aria-pressed')"), "true")
      await evaluate(`document.querySelector('#search').value = ${JSON.stringify(selectedCoin.symbol)}; document.querySelector('#search').dispatchEvent(new Event('input'))`)
      assert.equal(await evaluate("document.querySelectorAll('#candidate-rows tr[data-symbol]').length"), matchingCoins.length)
      await evaluate(`[...document.querySelectorAll('#candidate-rows tr[data-symbol]')].find(node => node.dataset.symbol === ${JSON.stringify(selectedCoin.symbol)}).querySelector('.coin-button').click()`)
      assert.equal(await evaluate("document.querySelector('#coin-symbol').textContent"), selectedCoin.symbol)
      await evaluate("document.querySelector('#search').value = ''; document.querySelector('#search').dispatchEvent(new Event('input')); document.querySelector('#sort').value = 'probability'; document.querySelector('#sort').dispatchEvent(new Event('change'))")
      assert.equal(await evaluate("document.querySelectorAll('#candidate-rows tr[data-symbol]').length"), report.candidateCount)
      await click("#peer-radar-tab")
      await frames()
      const radar = await evaluate(`({ observations: document.querySelectorAll('.peer-observation').length,
        charts: [...document.querySelectorAll('.peer-chart')].filter(node => !node.hidden && node.querySelector('canvas')).length,
        visible: !document.querySelector('#peer-radar').hidden,
        failures: [...document.querySelectorAll('.peer-comparison .warning')].filter(node => !node.hidden && node.textContent.includes('Не удалось построить')).map(node => node.textContent) })`)
      assert.equal(radar.observations, report.peerRadar.data.observations.length)
      assert.ok(radar.visible && radar.charts > 0, "REPORT_SMOKE_HTML must include drawable peer histories with a valid 1-day chart anchor")
      assert.deepEqual(radar.failures, [])
      await click("[data-peer-days='3']")
      await frames()
      assert.equal(await evaluate("document.querySelector('[data-peer-days=\"3\"]').getAttribute('aria-pressed')"), "true")
      await click("#main-tab")
      await frames()
      assert.equal(await evaluate("document.querySelector('#coin-symbol').textContent"), selectedCoin.symbol)
      assert.ok(await evaluate("!document.querySelector('#main-panel').hidden && document.querySelectorAll('#chart canvas').length > 0"))
      return { chart, radar }
    }

    await click(".report-open")
    await waitFor(() => evaluate(`location.pathname === '/reports/${saved.id}' && document.querySelector('#report-load-state')?.hidden && document.querySelector('#coin-symbol')?.textContent === ${JSON.stringify(initialCoin.symbol)}`), "online report")
    const online = await inspectReport()
    assert.equal(requests.filter(item => item.url === `${origin}/api/reports/${saved.id}`).length, 1)
    await click("#report-download")
    const downloadedPath = path.join(directory, "downloads", `report-${saved.id}.html`)
    await waitFor(async () => {
      try {
        return (await fs.stat(downloadedPath)).size > 0
      } catch (error) {
        if (error.code !== "ENOENT") {
          throw error
        }
        return false
      }
    }, "browser download")
    const downloaded = await fs.readFile(downloadedPath, "utf8")
    assert.deepEqual(JSON.parse(downloaded.match(/<script id="report-data" type="application\/json">([\s\S]*?)<\/script>/)[1]), report)
    assert.doesNotMatch(downloaded, /<(?:script|link|img)\b[^>]*(?:src|href)\s*=/i)
    await closeServer()
    await store.close()
    store = null
    offline = true
    await send("Network.emulateNetworkConditions", { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 })
    await navigate(pathToFileURL(downloadedPath).href, `document.querySelector('#coin-symbol')?.textContent === ${JSON.stringify(initialCoin.symbol)}`)
    const local = await inspectReport()
    const offlineHttp = requests.filter(item => item.offline && /^https?:/.test(item.url))
    assert.deepEqual(offlineHttp, [])
    assert.deepEqual(blocked, [])
    assert.deepEqual(errors, [])
    assert.equal(requests.some(item => item.url.includes("binance.com")), false)
    assert.equal(await fs.readFile(sourcePath, "utf8"), source)
    assert.equal(deadlineReached, false)
    t.diagnostic(JSON.stringify({
      browser: version.product, archive: "temporary, 1 original snapshot + 31 small list fixtures",
      initialCoin: initialCoin.symbol, selectedCoin: selectedCoin.symbol,
      weekly: weekly.labels, monthly, pagination: "30 + 2; cached back navigation",
      online, offline: local, downloadBytes: Buffer.byteLength(downloaded),
      serverStoppedBeforeFileOpen: !server.listening, offlineHttpRequests: offlineHttp.length,
      blockedRequests: blocked, javascriptErrors: errors, resourceErrors, sourceUnchanged: true,
    }, null, 2))
  } catch (error) {
    if (stderr) {
      t.diagnostic(`Browser stderr: ${stderr}`)
    }
    throw error
  } finally {
    clearTimeout(watchdog)
    killBrowser()
    if (browser?.pid && browser.exitCode === null && browser.signalCode === null) {
      await once(browser, "exit")
    }
    await closeServer()
    await store?.close()
    await fs.rm(directory, { recursive: true, force: true })
  }
})
