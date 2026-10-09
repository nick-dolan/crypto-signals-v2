import fs from "node:fs/promises"
import { pathToFileURL } from "node:url"

import { readTmpJson, writeTmpJson } from "./helpers/fs-helper.js"
import { runStep } from "./helpers/run-step-helper.js"
import { createReportStore } from "./reports/store.js"
import { addReportContext } from "./steps/step13-report/add-report-context.js"
import { buildPeerRadarHistories } from "./steps/step13-report/build-peer-radar-histories.js"
import { buildReportChartSnapshots } from "./steps/step13-report/build-report-chart-snapshots.js"
import { buildReportData } from "./steps/step13-report/build-report-data.js"
import { readCoinDescriptions } from "./steps/step13-report/read-coin-descriptions.js"
import { readMarketBriefReport } from "./steps/step13-report/read-market-brief-report.js"
import { readPeerRadarReport } from "./steps/step13-report/read-peer-radar-report.js"

export async function runReportStep ({ createStore = createReportStore, buildChartSnapshots = buildReportChartSnapshots } = {}) {
  // A failed rerun must not leave a previous report as the input to step 14.
  await fs.rm("tmp/step13-report.json", { force: true })
  const [analysis, payload, shortlist, sources, context] = await Promise.all([
    readTmpJson("step10-agent-analysis.json"),
    readTmpJson("step9-agent-payload.json"),
    readTmpJson("step5-preliminary-filter.json"),
    readTmpJson("step7-twitter-enrichment.json"),
    readTmpJson("step8-context-enrichment.json"),
  ])
  const [peerRadar, marketBrief] = await Promise.all([
    readPeerRadarReport(analysis.asOf),
    readMarketBriefReport(analysis.asOf),
  ])
  const report = {
    ...addReportContext(await buildReportData(analysis, payload, shortlist), sources, context),
    marketBrief,
    peerRadar: {
      ...peerRadar,
      histories: peerRadar.data ? await buildPeerRadarHistories(peerRadar.data) : {},
    },
  }
  report.coinDescriptions = await readCoinDescriptions([
    ...report.coins,
    ...(report.peerRadar.data?.observations ?? []).map(observation => observation.coin),
  ])
  report.coins = await buildChartSnapshots(report.coins, report.asOf)
  const store = await createStore()
  let archive
  try {
    report.reportCreatedAt = new Date().toISOString()
    archive = await store.save(report)
  } finally {
    await store.close()
  }

  await writeTmpJson("step13-report.json", { id: archive.id, asOf: report.asOf })

  console.log(`✓ Saved ${report.candidateCount} candidates with charts, context and peer radar as a Parquet snapshot`)
  if (report.peerRadar.warning) {
    console.warn(`⚠ ${report.peerRadar.warning}`)
  }
  if (report.marketBrief.warning) {
    console.warn(`⚠ ${report.marketBrief.warning}`)
  }
  const snapshotWarnings = report.coins.filter(coin => coin.chartSnapshot?.warning)
  if (snapshotWarnings.length) {
    console.warn(`⚠ ${snapshotWarnings.length} candidates have chart or release-price capture warnings; see the report for details`)
  }
  const warnings = report.coins.filter(coin => coin.history.warning)
  if (warnings.length) {
    console.warn(`⚠ ${warnings.length} candidates have history warnings; see the report for details`)
  }
  return { report, ...archive }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runStep("step13-report.js", runReportStep)
}
