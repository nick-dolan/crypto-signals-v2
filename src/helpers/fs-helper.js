import fs from "node:fs/promises"
import path from "node:path"

const TMP_DIR = path.resolve(process.cwd(), "tmp")
const OUTPUT_DIR = path.resolve(process.cwd(), "output")

export async function resetTmpDirectory () {
  await fs.rm(TMP_DIR, { recursive: true, force: true })
  await fs.mkdir(TMP_DIR, { recursive: true })

  return TMP_DIR
}

export async function resetTmpSubdirectory (directoryName) {
  const directoryPath = path.join(TMP_DIR, directoryName)

  await fs.rm(directoryPath, { recursive: true, force: true })
  await fs.mkdir(directoryPath, { recursive: true })

  return directoryPath
}

export async function readTmpJson (filename) {
  const filePath = path.join(TMP_DIR, filename)
  const rawData = await fs.readFile(filePath, "utf-8")

  return JSON.parse(rawData)
}

async function writeJson (filePath, data) {
  const temporaryPath = `${filePath}.${process.pid}.tmp`

  await fs.mkdir(path.dirname(filePath), { recursive: true })

  try {
    await fs.writeFile(temporaryPath, JSON.stringify(data, null, 2), "utf-8")
    await fs.rename(temporaryPath, filePath)
  } catch (error) {
    await fs.rm(temporaryPath, { force: true })
    throw error
  }

  return filePath
}

export async function writeTmpJson (filename, data) {
  return writeJson(path.join(TMP_DIR, filename), data)
}

export async function writeOutputJson (filename, data) {
  return writeJson(path.join(OUTPUT_DIR, filename), data)
}
