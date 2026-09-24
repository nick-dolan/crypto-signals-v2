import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { promisify } from "node:util"

import { saveReportHtml } from "../src/steps/step13-report/save-report-html.js"

async function temporaryDirectory (context) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "step13-report-save-"))
  context.after(() => fs.rm(directory, { recursive: true, force: true }))
  return directory
}

for (const [createdAt, filename] of [
  ["2026-09-16T13:30:40.123Z", "report-2026-09-16_16-30-40_GMT+3.html"],
  ["2026-09-16T21:05:06.789Z", "report-2026-09-17_00-05-06_GMT+3.html"],
  ["2026-12-31T22:59:59.999Z", "report-2027-01-01_01-59-59_GMT+3.html"],
  ["2026-01-15T00:00:00.000Z", "report-2026-01-15_03-00-00_GMT+3.html"],
  ["2026-07-15T00:00:00.000Z", "report-2026-07-15_03-00-00_GMT+3.html"],
]) {
  test(`saves ${createdAt} as ${filename} in a new directory`, async (context) => {
    const directory = path.join(await temporaryDirectory(context), "reports")
    const html = "<!doctype html><html lang=\"ru\"><body>Сохранённый отчёт</body></html>"
    const filePath = await saveReportHtml(html, createdAt, directory)

    assert.equal(filePath, path.join(directory, filename))
    assert.equal(await fs.readFile(filePath, "utf8"), html)
    assert.deepEqual(await fs.readdir(directory), [filename])
  })
}

test("repeated reports within the same second keep the existing file and use a suffix", async (context) => {
  const directory = await temporaryDirectory(context)
  const first = await saveReportHtml("first report", "2026-09-16T13:30:40.123Z", directory)
  const second = await saveReportHtml("second report", "2026-09-16T13:30:40.999Z", directory)

  assert.equal(path.basename(first), "report-2026-09-16_16-30-40_GMT+3.html")
  assert.equal(path.basename(second), "report-2026-09-16_16-30-40_GMT+3-1.html")
  assert.equal(await fs.readFile(first, "utf8"), "first report")
  assert.equal(await fs.readFile(second, "utf8"), "second report")
})

test("concurrent saves never overwrite one another", async (context) => {
  const directory = await temporaryDirectory(context)
  const reports = ["first report", "second report", "third report"]
  const paths = await Promise.all(reports.map(html => saveReportHtml(html, "2026-09-16T13:30:40.123Z", directory)))

  assert.equal(new Set(paths).size, reports.length)
  assert.deepEqual(await Promise.all(paths.map(filePath => fs.readFile(filePath, "utf8"))), reports)
  assert.deepEqual((await fs.readdir(directory)).sort(), [
    "report-2026-09-16_16-30-40_GMT+3-1.html",
    "report-2026-09-16_16-30-40_GMT+3-2.html",
    "report-2026-09-16_16-30-40_GMT+3.html",
  ])
})

test("write errors other than filename collisions are propagated", async (context) => {
  const directory = await temporaryDirectory(context)
  const error = Object.assign(new Error("Permission denied"), { code: "EACCES" })
  const write = context.mock.method(fs, "writeFile", async () => {
    throw error
  })

  await assert.rejects(saveReportHtml("report", "2026-09-16T13:30:40.123Z", directory), error)
  assert.equal(write.mock.callCount(), 1)
})

for (const timezone of ["UTC", "America/Los_Angeles", "Asia/Tokyo"]) {
  test(`default reports directory survives tmp cleanup and uses GMT+3 with TZ=${timezone}`, async (context) => {
    const directory = await temporaryDirectory(context)
    const { stdout } = await promisify(execFile)(process.execPath, ["--input-type=module", "--eval", `
      import { saveReportHtml } from ${JSON.stringify(new URL("../src/steps/step13-report/save-report-html.js", import.meta.url).href)}
      import { resetTmpDirectory } from ${JSON.stringify(new URL("../src/helpers/fs-helper.js", import.meta.url).href)}
      const filePath = await saveReportHtml("report", "2026-12-31T21:05:06.789Z")
      await resetTmpDirectory()
      console.log(filePath)
    `], { cwd: directory, env: { ...process.env, TZ: timezone }, timeout: 10_000 })
    const expected = path.join(directory, "reports", "report-2027-01-01_00-05-06_GMT+3.html")

    assert.equal(await fs.realpath(stdout.trim()), await fs.realpath(expected))
    assert.equal(await fs.readFile(expected, "utf8"), "report")
    assert.deepEqual(await fs.readdir(path.join(directory, "tmp")), [])
  })
}
