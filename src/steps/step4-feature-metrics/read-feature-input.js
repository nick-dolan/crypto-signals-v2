import fs from "node:fs/promises"
import path from "node:path"

import { readTmpJson } from "../../helpers/fs-helper.js"

export async function readFeatureInput () {
  const [sourceUniverse, bootstrapSummary, marketContext, entries] = await Promise.all([
    readTmpJson("step1-crypto-universe.json"),
    readTmpJson("step2-data-bootstrap.json"),
    readTmpJson("step3-market-context.json"),
    fs.readdir(
      path.resolve(process.cwd(), "tmp", "step2-data-bootstrap"),
      { withFileTypes: true },
    ),
  ])
  const coinDataFiles = entries
    .filter(entry => entry.isDirectory())
    .map(entry => path.join("step2-data-bootstrap", entry.name, "data.json"))
    .sort((first, second) => first.localeCompare(second))

  if (coinDataFiles.length !== bootstrapSummary.coinCount) {
    throw new Error(
      `Step 2 declares ${bootstrapSummary.coinCount} coins but contains ${coinDataFiles.length} data files`,
    )
  }

  return {
    sourceUniverse,
    bootstrapSummary,
    marketContext,
    coinDataFiles,
  }
}
