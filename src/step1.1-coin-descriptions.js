import fs from "node:fs/promises"
import { readTmpJson } from "./helpers/fs-helper.js"
import { runStep } from "./helpers/run-step-helper.js"
import { updateCoinDescriptions } from "./steps/step1.1-coin-descriptions/update-coin-descriptions.js"

async function runCoinDescriptionsStep () {
  const [sourceUniverse, systemPrompt] = await Promise.all([
    readTmpJson("step1-crypto-universe.json"),
    fs.readFile(new URL("./prompts/coin-description.md", import.meta.url), "utf8"),
  ])
  const result = await updateCoinDescriptions(sourceUniverse, systemPrompt, {
    onProgress: ({ index, total, addedCount }) => {
      console.log(`✓ Checked new coin descriptions ${index}/${total}: ${addedCount} ready`)
    },
  })

  if (!result.missingCount) {
    console.log(`✓ All candidates already have registry entries; ${result.coinCount} descriptions kept unchanged`)
    return
  }

  console.log(`✓ Added ${result.addedCount} descriptions to data/coin-descriptions.json; ${result.coinCount} entries in total`)

  if (result.failedCount) {
    console.warn(`⚠ ${result.failedCount} descriptions remain pending; continuing the main analysis`)
  }
}

await runStep("step1.1-coin-descriptions.js", runCoinDescriptionsStep)
