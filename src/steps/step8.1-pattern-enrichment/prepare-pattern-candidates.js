import fs from "node:fs/promises"
import path from "node:path"

import { readCoinHistory } from "../../helpers/coin-history-helper.js"
import { readTmpJson, resetTmpSubdirectory, writeTmpJson } from "../../helpers/fs-helper.js"
import { buildPatternChartSvg, renderCoinCardPng } from "../../reports/coin-card/render-coin-card.js"
import { createBootstrapDataRelativePath } from "../step2-data-bootstrap/check-coin-data-coverage.js"
import { buildPatternData, validatePatternShortlist } from "./build-pattern-data.js"

export async function preparePatternCandidates (input, {
  readCoinData = readTmpJson,
  directory = "step8.1-pattern-data",
} = {}) {
  const asOf = validatePatternShortlist(input)
  await resetTmpSubdirectory(directory)
  const candidates = []

  for (const { coin } of input.candidates) {
    const history = await readCoinHistory(coin, asOf, { readCoinData, includeOpenInterest: false })
    const data = buildPatternData(coin, history, input.asOf)
    const folder = path.basename(path.dirname(createBootstrapDataRelativePath(coin)))
    const relativePath = path.join(directory, folder)
    const svg = buildPatternChartSvg({ asOf: input.asOf, timeframe: "1h" }, { ...data.coin, history })
    const dataPath = await writeTmpJson(path.join(relativePath, "data.json"), data)
    const files = {
      data: path.relative(process.cwd(), dataPath),
      svg: path.join("tmp", relativePath, "chart.svg"),
      png: path.join("tmp", relativePath, "chart.png"),
    }
    await Promise.all([
      fs.writeFile(files.svg, svg),
      fs.writeFile(files.png, renderCoinCardPng(svg)),
    ])
    candidates.push({
      symbol: data.coin.symbol,
      name: data.coin.name,
      marketSymbol: data.coin.marketSymbol,
      directory: folder,
      files,
      coverage: data.coverage,
      ready: data.candles.at(-1).close !== null,
      caveat: data.warnings.join(" ") || null,
    })
  }

  const output = {
    schemaVersion: 1,
    asOf: input.asOf,
    timeframe: "1h",
    from: new Date((asOf - 167 * 3_600) * 1_000).toISOString(),
    to: new Date((asOf + 3_600) * 1_000).toISOString(),
    directory,
    candidateCount: candidates.length,
    candidates,
  }
  await writeTmpJson(path.join(directory, "manifest.json"), output)
  return output
}
