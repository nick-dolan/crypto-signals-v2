import fs from "node:fs/promises"
import path from "node:path"

import { readCoinHistory } from "../../helpers/coin-history-helper.js"
import { readTmpJson, resetTmpSubdirectory, writeTmpJson } from "../../helpers/fs-helper.js"
import { renderSvgPng } from "../../helpers/svg-helper.js"
import { createBootstrapDataRelativePath } from "../step2-data-bootstrap/check-coin-data-coverage.js"
import { buildPatternData, validatePatternShortlist } from "./build-pattern-data.js"
import { buildPatternChartData, buildPatternChartSvg } from "./render-pattern-chart.js"

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
    const report = { asOf: input.asOf, timeframe: "1h" }
    const chartCoin = { ...data.coin, history }
    const dataPath = await writeTmpJson(path.join(relativePath, "data.json"), data)
    const files = {
      data: path.relative(process.cwd(), dataPath),
      svg: path.join("tmp", relativePath, "chart.svg"),
      png: path.join("tmp", relativePath, "chart.png"),
      recentSvg: path.join("tmp", relativePath, "chart-48h.svg"),
      recentPng: path.join("tmp", relativePath, "chart-48h.png"),
    }
    const views = [168, 48].map((hours) => {
      const chart = buildPatternChartData(report, chartCoin, { hours })
      return {
        name: hours === 168 ? "week-168h.png" : "recent-48h.png",
        file: hours === 168 ? files.png : files.recentPng,
        hours,
        from: new Date(chart.points[0].time * 1_000).toISOString(),
        to: data.to,
        coverage: chart.coverage,
      }
    })
    await Promise.all(views.flatMap((view) => {
      const svg = buildPatternChartSvg(report, chartCoin, { hours: view.hours })
      return [
        fs.writeFile(view.hours === 168 ? files.svg : files.recentSvg, svg),
        fs.writeFile(view.file, renderSvgPng(svg)),
      ]
    }))
    candidates.push({
      symbol: data.coin.symbol,
      name: data.coin.name,
      marketSymbol: data.coin.marketSymbol,
      directory: folder,
      files,
      views,
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
