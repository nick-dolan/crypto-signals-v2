import fs from "node:fs/promises"
import path from "node:path"

import { readTmpJson } from "./helpers/fs-helper.js"
import { runStep } from "./helpers/run-step-helper.js"
import { addReportContext } from "./steps/step11-report/add-report-context.js"
import { buildReportData } from "./steps/step11-report/build-report-data.js"
import { renderReportHtml } from "./steps/step11-report/render-report-html.js"

async function runReportStep () {
  const [analysis, payload, shortlist, sources, context] = await Promise.all([
    readTmpJson("step7-agent-analysis.json"),
    readTmpJson("step6-agent-payload.json"),
    readTmpJson("step5-preliminary-filter.json"),
    readTmpJson("step9-twitter-enrichment.json"),
    readTmpJson("step10-context-enrichment.json"),
  ])
  const report = {
    ...addReportContext(await buildReportData(analysis, payload, shortlist), sources, context),
    reportCreatedAt: new Date().toISOString(),
  }
  const html = await renderReportHtml(report)
  const outputPath = path.resolve("tmp", "step11-report.html")
  await fs.writeFile(outputPath, html, "utf8")

  console.log(`✓ Saved ${report.candidateCount} candidates with weekly charts and top-candidate news/Twitter context to ${outputPath}`)
  const warnings = report.coins.filter(coin => coin.history.warning)
  if (warnings.length) {
    console.warn(`⚠ ${warnings.length} candidates have history warnings; see the report for details`)
  }
}

await runStep("step11-report.js", runReportStep)
