import fs from "node:fs/promises"

export async function renderReportHtml (report) {
  const chartsDirectory = new URL(".", import.meta.resolve("lightweight-charts"))
  const [template, styles, script, charts, license] = await Promise.all([
    fs.readFile(new URL("./report.html", import.meta.url), "utf8"),
    fs.readFile(new URL("./report.css", import.meta.url), "utf8"),
    fs.readFile(new URL("./report.js", import.meta.url), "utf8"),
    fs.readFile(new URL("lightweight-charts.standalone.production.js", chartsDirectory), "utf8"),
    fs.readFile(new URL("../LICENSE", chartsDirectory), "utf8"),
  ])
  const replacements = {
    styles,
    script,
    charts,
    // JSON is data, not markup: agent text must never close the script element.
    data: JSON.stringify(report).replaceAll("<", "\\u003c"),
    license: license.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;"),
  }

  return template.replace(
    /\/\* REPORT_(STYLES|SCRIPT|CHARTS) \*\/|"REPORT_(DATA)"|<!-- REPORT_(LICENSE) -->/g,
    (_, code, data, text) => replacements[(code ?? data ?? text).toLowerCase()],
  )
}
