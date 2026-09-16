import { readTmpJson } from "./helpers/fs-helper.js"
import { runStep } from "./helpers/run-step-helper.js"
import { addReportContext } from "./steps/step11-report/add-report-context.js"
import { buildAltMarketBackground } from "./steps/step11-report/build-alt-market-background.js"
import { buildReportData } from "./steps/step11-report/build-report-data.js"
import { renderReportHtml } from "./steps/step11-report/render-report-html.js"
import { saveReportHtml } from "./steps/step11-report/save-report-html.js"

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
    altMarketBackground: await buildAltMarketBackground({
      asOf: analysis.asOf,
      breadth4h: shortlist.marketContext?.breadth ?? payload.marketContext?.breadth4h,
    }),
    reportCreatedAt: new Date().toISOString(),
  }
  const html = await renderReportHtml(report)
  const outputPath = await saveReportHtml(html, report.reportCreatedAt)

  console.log(`✓ Saved ${report.candidateCount} candidates with weekly charts and top-candidate news/Twitter context to ${outputPath}`)
  const warnings = report.coins.filter(coin => coin.history.warning)
  if (warnings.length) {
    console.warn(`⚠ ${warnings.length} candidates have history warnings; see the report for details`)
  }
}

await runStep("step11-report.js", runReportStep)
