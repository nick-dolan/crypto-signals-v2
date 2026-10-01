import { pathToFileURL } from "node:url"

import { readTmpJson } from "./helpers/fs-helper.js"
import { runStep } from "./helpers/run-step-helper.js"
import { isString } from "./helpers/utils.typed.js"
import { createReportStore } from "./reports/store.js"
import { writeTelegramPreview } from "./reports/telegram/preview.js"

export async function runTelegramStep ({ readJson = readTmpJson, createStore = createReportStore, createPreview = writeTelegramPreview } = {}) {
  const saved = await readJson("step13-report.json")
  if (!isString(saved?.id) || !saved.id.trim()) {
    throw new Error("Step 13 output is missing a report ID")
  }

  const store = await createStore()
  let report
  try {
    report = await store.read(saved.id)
    if (!report) {
      throw new Error(`Step 13 report ${saved.id} was not found in the archive`)
    }
  } finally {
    await store.close()
  }

  const result = await createPreview(report, { source: `reports/${saved.id}` })
  console.log(`✓ Candidates: ${result.candidateCount}/10 · Messages: ${result.messageCount} · Omitted: ${result.omittedCount}`)
  console.log(`  Release: ${result.directory}\n  Preview: ${result.previewPath}\n  Manifest: ${result.manifestPath}`)
  console.log("Step 14: release prepared locally. Nothing was sent to Telegram.")
  return result
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runStep("step14-telegram.js", runTelegramStep)
}
