import { pathToFileURL } from "node:url"

import { readTmpJson } from "./helpers/fs-helper.js"
import { runStep } from "./helpers/run-step-helper.js"
import { isString } from "./helpers/utils.typed.js"
import { createReportStore } from "./reports/store.js"
import { writeTelegramPreview } from "./reports/telegram/preview.js"
import { sendTelegramRelease } from "./reports/telegram/send-telegram-release.js"

export async function runTelegramStep ({
  readJson = readTmpJson,
  createStore = createReportStore,
  createPreview = writeTelegramPreview,
  sendRelease = sendTelegramRelease,
} = {}) {
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
  const delivery = await sendRelease(result, { reportId: saved.id })
  console.log(`Step 14: Telegram post sent (message ID: ${delivery.messageId}).`)
  return { ...result, delivery }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runStep("step14-telegram.js", runTelegramStep)
}
