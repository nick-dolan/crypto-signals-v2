import fs from "node:fs/promises"
import path from "node:path"

import { readCoinPeers } from "../../helpers/coin-peers-helper.js"
import { readTmpJson } from "../../helpers/fs-helper.js"

export async function readFeatureInput () {
  const [sourceUniverse, bootstrapSummary, marketContext, coingeckoTrending, coinPeers, entries] = await Promise.all([
    readTmpJson("step1-crypto-universe.json"),
    readTmpJson("step2-data-bootstrap.json"),
    readTmpJson("step3-market-context.json"),
    readTmpJson("step3.1-coingecko-trending.json"),
    readCoinPeers(),
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
    marketContext,
    coingeckoTrending,
    coinPeers,
    coinData: await Promise.all(coinDataFiles.map(readTmpJson)),
  }
}
