import fs from "node:fs/promises"
import path from "node:path"

const TMP_DIR = path.resolve(process.cwd(), "tmp")
const OUTPUT_DIR = path.resolve(process.cwd(), "output")

export async function resetTmpDirectory () {
  await fs.rm(TMP_DIR, { recursive: true, force: true })
  await fs.mkdir(TMP_DIR, { recursive: true })

  return TMP_DIR
}

export async function readTmpJson (filename) {
  const filePath = path.join(TMP_DIR, filename)
  const rawData = await fs.readFile(filePath, "utf-8")

  return JSON.parse(rawData)
}

export async function writeTmpJson (filename, data) {
  await fs.mkdir(TMP_DIR, { recursive: true })
  const filePath = path.join(TMP_DIR, filename)

  await fs.writeFile(filePath, JSON.stringify(data, null, 2), "utf-8")

  return filePath
}

export async function writeOutputJson (filename, data) {
  await fs.mkdir(OUTPUT_DIR, { recursive: true })
  const filePath = path.join(OUTPUT_DIR, filename)

  await fs.writeFile(filePath, JSON.stringify(data, null, 2), "utf-8")

  return filePath
}
