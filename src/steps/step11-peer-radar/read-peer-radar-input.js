import fs from "node:fs/promises"
import path from "node:path"

import { readCoinPeers } from "../../helpers/coin-peers-helper.js"
import { readTmpJson } from "../../helpers/fs-helper.js"

export async function readPeerRadarInput () {
  const [sourceUniverse, bootstrapSummary, coinPeers, entries] = await Promise.all([
    readTmpJson("step1-crypto-universe.json"),
    readTmpJson("step2-data-bootstrap.json"),
    readCoinPeers(),
    fs.readdir(path.resolve("tmp", "step2-data-bootstrap"), { withFileTypes: true }),
  ])
  const files = entries
    .filter(entry => entry.isDirectory())
    .map(entry => path.join("step2-data-bootstrap", entry.name, "data.json"))
    .sort((first, second) => first.localeCompare(second))

  if (files.length !== bootstrapSummary.coinCount) {
    throw new Error(`Step 2 declares ${bootstrapSummary.coinCount} coins but contains ${files.length} data files`)
  }

  return { sourceUniverse, coinPeers, coinData: await Promise.all(files.map(readTmpJson)) }
}
