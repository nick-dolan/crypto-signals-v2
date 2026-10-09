import fs from "node:fs/promises"

import { readWebAsset } from "../web/read-web-asset.js"
import { renderIconSprite } from "../web/render-icon-sprite.js"

async function renderShell (replacements) {
  const [template, license, icons] = await Promise.all([
    fs.readFile(new URL("../web/report.html", import.meta.url), "utf8"),
    readWebAsset("chart-license.txt"), renderIconSprite(),
  ])
  replacements.ICONS = icons
  replacements.LICENSE = license.content.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
  return template.replace(/<!-- REPORT_([A-Z]+) -->|"REPORT_DATA"/g, (_, name) => replacements[name ?? "DATA"])
}

export async function renderReportHtml (report) {
  const [styles, script, charts] = await Promise.all([
    readWebAsset("report.css"), readWebAsset("report.js"), readWebAsset("lightweight-charts.js"),
  ])
  return renderShell({
    STYLES: `<style>\n${styles.content}\n</style>`,
    NAVIGATION: "",
    MAIN: "<main id=\"report-shell\" class=\"shell\">",
    CHARTS: `<script>${charts.content}</script>`,
    SCRIPT: `<script>${script.content}\nglobalThis.renderReport()</script>`,
    // Agent text stays data: it cannot close a script or introduce HTML markup.
    DATA: JSON.stringify(report).replaceAll("<", "\\u003c").replaceAll("\u2028", "\\u2028").replaceAll("\u2029", "\\u2029"),
  })
}

export async function renderReportPage () {
  return renderShell({
    STYLES: "<link rel=\"stylesheet\" href=\"/assets/report.css\">\n    <link rel=\"stylesheet\" href=\"/assets/web.css\">",
    NAVIGATION: await fs.readFile(new URL("../web/report-navigation.html", import.meta.url), "utf8"),
    MAIN: "<main id=\"report-shell\" class=\"shell\" hidden>",
    CHARTS: "<script defer src=\"/assets/lightweight-charts.js\"></script>",
    SCRIPT: "<script defer src=\"/assets/browser-helpers.js\"></script>\n    <script defer src=\"/assets/report.js\"></script>\n    <script defer src=\"/assets/report-loader.js\"></script>",
    DATA: "null",
  })
}
