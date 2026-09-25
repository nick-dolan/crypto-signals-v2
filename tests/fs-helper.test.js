import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import { resetTmpSubdirectory, writeDataJson, writeTmpCompactJson, writeTmpJson } from "../src/helpers/fs-helper.js"

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

for (const method of ["writeFile", "rename"]) {
  test(`writeDataJson leaves the previous registry intact when ${method} fails`, async (t) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "data-json-"))
    const previousDirectory = process.cwd()

    try {
      process.chdir(directory)
      const filePath = await writeDataJson("registry.json", { coins: [{ baseCurrencyId: "OLD" }] })
      const original = await fs.readFile(filePath, "utf8")
      assert.equal(filePath, path.join(directory, "data", "registry.json"))

      t.mock.method(fs, method, async () => {
        throw new Error("Disk failure")
      })

      await assert.rejects(writeDataJson("registry.json", { coins: [] }), /Disk failure/)
      assert.equal(await fs.readFile(filePath, "utf8"), original)
      assert.deepEqual(await fs.readdir(path.join(directory, "data")), ["registry.json"])
    } finally {
      process.chdir(previousDirectory)
      await fs.rm(directory, { recursive: true, force: true })
    }
  })
}
