import { createServer } from "node:http"
import { isIP } from "node:net"
import { pathToFileURL } from "node:url"

import { isFunction, isObject, isString } from "../helpers/utils.typed.js"
import { paginateReports, readListOptions } from "./report-list.js"
import { HttpError, isReportId } from "./validation.js"

function requestTarget (target) {
  const separator = target.indexOf("?")
  const pathname = separator === -1 ? target : target.slice(0, separator)
  // Inspect the raw path; URL normalization would hide dot-segment traversal attempts.
  if (
    !/^\/[A-Za-z0-9_./-]*$/.test(pathname)
    || /\/\/|(?:^|\/)\.{1,2}(?:\/|$)/.test(pathname)
    || /[#\s]/.test(target)
  ) {
    throw new HttpError(400, "Invalid request target")
  }
  return { pathname, params: new URLSearchParams(separator === -1 ? "" : target.slice(separator + 1)) }
}

function send (request, response, status, body, headers = {}) {
  const content = headers["Content-Type"] ? body : JSON.stringify(body)
  const bytes = isString(content) ? Buffer.from(content) : content
  if (!Buffer.isBuffer(bytes)) {
    throw new Error("Invalid response content")
  }

  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": bytes.length,
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "no-store",
    ...headers,
  })
  response.end(request.method === "HEAD" ? undefined : bytes)
}

export function createReportServer ({
  store,
  renderReportHtml = async report => (await import("../reports/render-report-html.js")).renderReportHtml(report),
  renderReportPage = async () => (await import("../reports/render-report-html.js")).renderReportPage(),
  readWebAsset = async name => (await import("../web/read-web-asset.js")).readWebAsset(name),
} = {}) {
  if (!isFunction(store?.read) || !isFunction(store?.list)) {
    throw new TypeError("store must provide read and list functions")
  }
  if (![renderReportHtml, renderReportPage, readWebAsset].every(isFunction)) {
    throw new TypeError("Report renderers must be functions")
  }

  async function readReport (id) {
    const report = await store.read(id)
    if (report === null) {
      throw new HttpError(404, "Report not found")
    }
    if (!isObject(report)) {
      throw new Error("Invalid report archive")
    }
    return report
  }

  return createServer(async (request, response) => {
    try {
      if (!["GET", "HEAD"].includes(request.method)) {
        return send(request, response, 405, { error: "Method not allowed" }, { Allow: "GET, HEAD" })
      }

      const { pathname, params } = requestTarget(request.url)
      if (pathname === "/api/reports") {
        const options = readListOptions(params)
        return send(request, response, 200, paginateReports(await store.list(), options))
      }
      if (params.size) {
        throw new HttpError(400, "Unknown query parameter")
      }

      const assetMatch = /^\/assets\/([A-Za-z0-9][A-Za-z0-9._-]*)$/.exec(pathname)
      if (pathname === "/" || assetMatch) {
        const asset = await readWebAsset(pathname === "/" ? "index.html" : assetMatch[1])
        if (!asset) {
          throw new HttpError(404, "Asset not found")
        }
        return send(request, response, 200, asset.content, { "Content-Type": asset.contentType })
      }

      const reportMatch = /^(\/reports|\/api\/reports)\/([^/]+)(\/download)?$/.exec(pathname)
      if (!reportMatch || (reportMatch[1] === "/reports" && reportMatch[3])) {
        throw new HttpError(404, "Not found")
      }
      if (!isReportId(reportMatch[2])) {
        throw new HttpError(400, "Invalid report ID")
      }

      if (reportMatch[1] === "/reports") {
        return send(request, response, 200, await renderReportPage(), { "Content-Type": "text/html; charset=utf-8" })
      }
      const id = reportMatch[2].toLowerCase()
      const report = await readReport(id)
      if (reportMatch[3]) {
        return send(request, response, 200, await renderReportHtml(report), {
          "Content-Type": "text/html; charset=utf-8",
          "Content-Disposition": `attachment; filename="report-${id}.html"`,
        })
      }
      return send(request, response, 200, report)
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500
      if (status === 500) {
        console.error(`Report request failed (${request.method} ${request.url}):`, error)
      }
      if (response.headersSent || response.destroyed) {
        response.destroy()
        return
      }
      send(request, response, status, { error: status === 500 ? "Internal server error" : error.message })
    }
  })
}

export function readListenOptions (env = process.env) {
  const host = env.HOST ?? "127.0.0.1"
  const port = env.PORT ?? "3000"
  if (!isString(port) || !/^(0|[1-9]\d{0,4})$/.test(port) || Number(port) > 65_535) {
    throw new TypeError("PORT must be an integer between 0 and 65535")
  }
  if (
    !isString(host) || !host.length || host.length > 253
    || (!isIP(host) && (
      /^[\d.]+$/.test(host)
      || !host.split(".").every(label => /^[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$/i.test(label))
    ))
  ) {
    throw new TypeError("HOST must be an IP address or hostname without a scheme or port")
  }
  return { host, port: Number(port) }
}

// Only this owning lifecycle creates/closes a store; the HTTP factory never owns injected resources.
export async function startReportServer ({
  env = process.env,
  createStore = async () => (await import("../reports/store.js")).createReportStore(),
  ...renderers
} = {}) {
  const { host, port } = readListenOptions(env)
  const store = await createStore()
  let server
  try {
    server = createReportServer({ ...renderers, store })
    await new Promise((resolve, reject) => {
      server.once("error", reject)
      server.listen(port, host, () => {
        server.off("error", reject)
        resolve()
      })
    })
  } catch (error) {
    await store.close()
    throw error
  }

  let closing
  function close () {
    closing ??= (async () => {
      process.off("SIGINT", onSignal)
      process.off("SIGTERM", onSignal)
      const timeout = setTimeout(() => server.closeAllConnections(), 5_000)
      timeout.unref()
      try {
        await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
      } finally {
        clearTimeout(timeout)
        await store.close()
      }
    })()
    return closing
  }

  function onSignal () {
    close().catch((error) => {
      console.error("Report server shutdown failed:", error)
      process.exitCode = 1
    })
  }
  process.once("SIGINT", onSignal)
  process.once("SIGTERM", onSignal)
  return { server, close }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { server } = await startReportServer()
    const { address, port } = server.address()
    console.log(`Report server: http://${isIP(address) === 6 ? `[${address}]` : address}:${port}/ (no authentication; local use only)`)
  } catch (error) {
    console.error("Report server could not start. Check HOST, PORT and the report archive.", error)
    process.exitCode = 1
  }
}
