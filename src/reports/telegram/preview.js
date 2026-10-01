import fs from "node:fs/promises"
import path from "node:path"

import { isArray, isObject } from "../../helpers/utils.typed.js"
import { buildCoinCardSvg, renderCoinCardPng } from "../coin-card/render-coin-card.js"
import { buildTelegramRelease } from "./build-telegram-release.js"
import { renderTelegramPreview } from "./render-telegram-preview.js"

export async function writeTelegramPreview (report, { directory = "output/telegram-preview", source = null } = {}) {
  if (!isObject(report) || !isArray(report.coins) || !report.coins.every(isObject)) {
    throw new Error("Некорректный отчёт: coins должен быть массивом объектов монет")
  }
  const manifest = { ...buildTelegramRelease(report), source }
  const json = JSON.stringify(manifest, null, 2)
  const html = renderTelegramPreview(manifest)
  directory = path.resolve(directory)
  await fs.mkdir(directory, { recursive: true })
  const folder = await fs.mkdtemp(path.join(directory, "release-"))
  const manifestPath = path.join(folder, "release.json")
  const previewPath = path.join(folder, "index.html")
  try {
    await fs.mkdir(path.join(folder, "cards"))
    // Sequential writes finish before cleanup can remove this release's folder.
    for (const item of manifest.candidates) {
      const svg = buildCoinCardSvg(report, report.coins[item.coinIndex])
      const png = renderCoinCardPng(svg)
      await fs.writeFile(path.join(folder, item.image), png)
      await fs.writeFile(path.join(folder, item.image.replace(/\.png$/, ".svg")), svg, "utf8")
    }
    await fs.writeFile(manifestPath, json, "utf8")
    await fs.writeFile(previewPath, html, "utf8")
  } catch (error) {
    await fs.rm(folder, { recursive: true, force: true })
    throw error
  }
  return {
    directory: folder, previewPath, manifestPath,
    candidateCount: manifest.candidates.length, messageCount: manifest.messages.length,
    demo: manifest.demo, asOf: manifest.asOf, omittedCount: manifest.omittedCount,
  }
}
