import { readTmpJson } from "./helpers/fs-helper.js"
import { runStep } from "./helpers/run-step-helper.js"
import { addReportContext } from "./steps/step13-report/add-report-context.js"
import { buildPeerRadarHistories } from "./steps/step13-report/build-peer-radar-histories.js"
import { buildReportData } from "./steps/step13-report/build-report-data.js"
import { readCoinDescriptions } from "./steps/step13-report/read-coin-descriptions.js"
import { readPeerRadarReport } from "./steps/step13-report/read-peer-radar-report.js"
import { renderReportHtml } from "./steps/step13-report/render-report-html.js"
import { saveReportHtml } from "./steps/step13-report/save-report-html.js"

async function runReportStep () {
  const [analysis, payload, shortlist, sources, context] = await Promise.all([
    readTmpJson("step7-agent-analysis.json"),
    readTmpJson("step6-agent-payload.json"),
    readTmpJson("step5-preliminary-filter.json"),
    readTmpJson("step9-twitter-enrichment.json"),
    readTmpJson("step10-context-enrichment.json"),
  ])
  const peerRadar = await readPeerRadarReport(analysis.asOf)
  const report = {
    ...addReportContext(await buildReportData(analysis, payload, shortlist), sources, context),
    peerRadar: {
      ...peerRadar,
      histories: peerRadar.data ? await buildPeerRadarHistories(peerRadar.data) : {},
    },
    reportCreatedAt: new Date().toISOString(),
  }
  report.coinDescriptions = await readCoinDescriptions([
    ...report.coins,
    ...(report.peerRadar.data?.observations ?? []).map(observation => observation.coin),
  ])
  const html = await renderReportHtml(report)
  const outputPath = await saveReportHtml(html, report.reportCreatedAt)

  console.log(`✓ Saved ${report.candidateCount} candidates with weekly charts and top-candidate news/Twitter context to ${outputPath}`)
  if (report.peerRadar.warning) {
    console.warn(`⚠ ${report.peerRadar.warning}`)
  }
  const warnings = report.coins.filter(coin => coin.history.warning)
  if (warnings.length) {
    console.warn(`⚠ ${warnings.length} candidates have history warnings; see the report for details`)
  }
}

await runStep("step13-report.js", runReportStep)
