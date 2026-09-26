import fs from "node:fs/promises"

import { isFinite, isObject, isSafeInteger, isString } from "../helpers/utils.typed.js"
import { createChartUpdater } from "./chart-update.js"

function browserTypes () {
  // Radash's isArray is native; the other helpers can be shared verbatim.
  return `{ isArray: Array.isArray, ${Object.entries({ isFinite, isObject, isSafeInteger, isString })
    .map(([name, helper]) => `${name}: ${helper.toString()}`).join(",\n")} }`
}

async function readAsset (url, contentType) {
  return { content: await fs.readFile(url, "utf8"), contentType }
}

export async function readWebAsset (name) {
  switch (name) {
    case "index.html":
      return readAsset(new URL("./index.html", import.meta.url), "text/html; charset=utf-8")
    case "report.css":
    case "web.css":
      return readAsset(new URL(name, import.meta.url), "text/css; charset=utf-8")
    case "report-loader.js":
    case "reports-list.js":
      return readAsset(new URL(name, import.meta.url), "text/javascript; charset=utf-8")
    case "browser-helpers.js": {
      const script = await fs.readFile(new URL("./browser-helpers.js", import.meta.url), "utf8")
      return {
        content: `(() => { const webTypes = ${browserTypes()};\n${script}\n})()`,
        contentType: "text/javascript; charset=utf-8",
      }
    }
    case "report.js": {
      const script = await fs.readFile(new URL("./report.js", import.meta.url), "utf8")
      return {
        // Both the site and file:// use this exact renderer, with no imports or eval.
        content: `globalThis.renderReport = () => {
          const { isArray, isFinite, isSafeInteger, isString } = ${browserTypes()};
          const updateChartHistory = (${createChartUpdater.toString()})({ isArray, isFinite, isSafeInteger, isString });
          ${script}
        }`,
        contentType: "text/javascript; charset=utf-8",
      }
    }
    case "lightweight-charts.js":
      return readAsset(
        new URL("lightweight-charts.standalone.production.js", import.meta.resolve("lightweight-charts")),
        "text/javascript; charset=utf-8",
      )
    case "chart-license.txt":
      return readAsset(new URL("../LICENSE", import.meta.resolve("lightweight-charts")), "text/plain; charset=utf-8")
    default:
      return null
  }
}
