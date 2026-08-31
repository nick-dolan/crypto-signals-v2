import fs from "node:fs/promises"
import path from "node:path"

export async function resetTmpDirectory () {
  await fs.rm(path.resolve(process.cwd(), "tmp"), {
    recursive: true,
    force: true,
  })
  await fs.mkdir(path.resolve(process.cwd(), "tmp"), { recursive: true })

  return path.resolve(process.cwd(), "tmp")
}

export async function resetTmpSubdirectory (directoryName) {
  const directoryPath = path.join(
    path.resolve(process.cwd(), "tmp"),
    directoryName,
  )

  await fs.rm(directoryPath, { recursive: true, force: true })
  await fs.mkdir(directoryPath, { recursive: true })

  return directoryPath
}

export async function readTmpJson (filename) {
  const filePath = path.join(path.resolve(process.cwd(), "tmp"), filename)
  const rawData = await fs.readFile(filePath, "utf-8")

  return JSON.parse(rawData)
}

async function writeJson (filePath, data, indentation = 2) {
  const temporaryPath = `${filePath}.${process.pid}.tmp`

  await fs.mkdir(path.dirname(filePath), { recursive: true })

  try {
    await fs.writeFile(
      temporaryPath,
      JSON.stringify(data, null, indentation),
      "utf-8",
    )
    await fs.rename(temporaryPath, filePath)
  } catch (error) {
    await fs.rm(temporaryPath, { force: true })
    throw error
  }

  return filePath
}

export async function writeTmpJson (filename, data) {
  return writeJson(
    path.join(path.resolve(process.cwd(), "tmp"), filename),
    data,
  )
}

export async function writeTmpCompactJson (filename, data) {
  return writeJson(
    path.join(path.resolve(process.cwd(), "tmp"), filename),
    data,
    0,
  )
}

export async function writeOutputJson (filename, data) {
  return writeJson(
    path.join(path.resolve(process.cwd(), "output"), filename),
    data,
  )
}
