import assert from "node:assert/strict"
import fs from "node:fs/promises"
import path from "node:path"
import test from "node:test"

import { resetTmpSubdirectory, writeTmpCompactJson, writeTmpJson } from "../src/helpers/fs-helper.js"

test("writeTmpJson creates nested data directories", async (context) => {
  const directoryName = `fs-helper-test-${process.pid}-${Date.now()}`
  const relativePath = path.join(directoryName, "coin", "data.json")
  const directoryPath = path.resolve(process.cwd(), "tmp", directoryName)

  context.after(() => fs.rm(directoryPath, { recursive: true, force: true }))

  const filePath = await writeTmpJson(relativePath, { saved: true })
  const saved = JSON.parse(await fs.readFile(filePath, "utf-8"))

  assert.deepEqual(saved, { saved: true })
  assert.equal(filePath, path.resolve(process.cwd(), "tmp", relativePath))

  const compactPath = await writeTmpCompactJson(
    path.join(directoryName, "compact.json"),
    { saved: true },
  )

  assert.equal(await fs.readFile(compactPath, "utf-8"), "{\"saved\":true}")

  await resetTmpSubdirectory(directoryName)

  assert.deepEqual(await fs.readdir(directoryPath), [])
})
