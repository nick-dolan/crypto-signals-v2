import fs from "node:fs/promises"
import path from "node:path"

import { readTmpJson } from "./helpers/fs-helper.js"
import { runStep } from "./helpers/run-step-helper.js"
import { buildReportData } from "./steps/step7.1-report/build-report-data.js"
import { renderReportHtml } from "./steps/step7.1-report/render-report-html.js"

async function runReportStep () {
  const [analysis, payload, shortlist] = await Promise.all([
    readTmpJson("step7-agent-analysis.json"),
    readTmpJson("step6-agent-payload.json"),
    readTmpJson("step5-preliminary-filter.json"),
  ])
  const report = await buildReportData(analysis, payload, shortlist)
  const html = await renderReportHtml(report)
  const outputPath = path.resolve("tmp", "step7.1-report.html")
  await fs.writeFile(outputPath, html, "utf8")

  console.log(`✓ Saved ${report.candidateCount} candidates with weekly charts to ${outputPath}`)
  const warnings = report.coins.filter(coin => coin.history.warning)
  if (warnings.length) {
    console.warn(`⚠ ${warnings.length} candidates have history warnings; see the report for details`)
  }
}

await runStep("step7.1-report.js", runReportStep)
