import fs from "node:fs/promises"
import path from "node:path"
import { parseArgs } from "node:util"
import { pathToFileURL } from "node:url"

import { isError } from "../../helpers/utils.typed.js"
import { createReportStore } from "../store.js"
import { createDemoReport } from "./create-demo-report.js"
import { buildCoinCardSvg, renderCoinCardPng } from "./render-coin-card.js"

export async function writeCoinCardPreview (report, { symbol, directory = "output/coin-card" } = {}) {
  const coin = symbol
    ? report.coins.find(coin => coin.symbol.toUpperCase() === symbol.toUpperCase())
    : report.coins.filter(coin => coin.topRank != null).sort((first, second) => first.topRank - second.topRank)[0]
  if (!coin) {
    throw new Error(symbol ? `Монета ${symbol} отсутствует в отчёте` : "В отчёте нет топ-кандидатов. Выберите монету через --symbol")
  }
  const svg = buildCoinCardSvg(report, coin)
  const png = renderCoinCardPng(svg)
  const basename = coin.symbol.replace(/[^a-z\d_-]/gi, "_")
  const files = {
    svg: path.join(directory, `${basename}.svg`),
    png: path.join(directory, `${basename}.png`),
  }
  await fs.mkdir(directory, { recursive: true })
  await Promise.all([
    fs.writeFile(files.svg, svg, "utf8"),
    fs.writeFile(files.png, png),
  ])
  return { symbol: coin.symbol, asOf: report.asOf, demo: report.demo === true, files }
}

export async function runCoinCardPreview ({ symbol, reportId, demo = false, directory, createStore = createReportStore } = {}) {
  if (demo) {
    if (reportId || symbol) {
      throw new Error("--demo нельзя сочетать с --report или --symbol")
    }
    return writeCoinCardPreview(createDemoReport(), { directory })
  }

  const store = await createStore()
  let report
  try {
    const id = reportId ?? (await store.list())[0]?.id
    if (!id) {
      throw new Error("Архив reports пуст. Сначала сохраните отчёт шагом 13, либо используйте --demo только для проверки оформления")
    }
    report = await store.read(id)
    if (!report) {
      throw new Error(`Отчёт ${id} не найден`)
    }
  } finally {
    await store.close()
  }
  return writeCoinCardPreview(report, { symbol, directory })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { values } = parseArgs({ options: {
      symbol: { type: "string" }, report: { type: "string" }, demo: { type: "boolean" },
    } })
    const result = await runCoinCardPreview({ symbol: values.symbol, reportId: values.report, demo: values.demo })
    console.log(result.demo ? "ДЕМО: синтетические данные, не рыночный сигнал." : `Сохранённый срез: ${result.asOf} (открытие последней закрытой свечи).`)
    console.log(`✓ ${result.symbol}: ${result.files.png}\n  SVG: ${result.files.svg}\n  Локальное превью. В Telegram ничего не отправлено.`)
  } catch (error) {
    console.error(isError(error) ? error.message : String(error))
    process.exitCode = 1
  }
}
