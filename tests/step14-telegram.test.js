import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { promisify } from "node:util"

import { runTelegramStep } from "../src/step14-telegram.js"

function previewResult () {
  return {
    candidateCount: 0, messageCount: 1, omittedCount: 0,
    directory: "output/example", previewPath: "output/example/index.html", manifestPath: "output/example/release.json",
  }
}

test("step 14 reads exactly the step 13 report, closes its archive and prepares before sending", async (t) => {
  const log = t.mock.method(console, "log", () => {})
  const calls = []
  const report = { asOf: "2026-10-01T09:00:00Z", coins: [] }
  const expected = previewResult()
  const delivery = { status: "sent", messageId: 77 }
  const result = await runTelegramStep({
    readJson: async (name) => {
      calls.push(["receipt", name])
      return { id: "step-13-report-id", asOf: report.asOf }
    },
    createStore: async () => {
      calls.push(["open"])
      return {
        read: async (id) => {
          calls.push(["read", id])
          return report
        },
        list: async () => assert.fail("must not select the latest archive"),
        close: async () => {
          await Promise.resolve()
          calls.push(["close"])
        },
      }
    },
    createPreview: async (input, options) => {
      assert.equal(input, report)
      calls.push(["preview", options])
      return expected
    },
    sendRelease: async (release, options) => {
      assert.equal(release, expected)
      calls.push(["send", options])
      return delivery
    },
  })
  assert.deepEqual(result, { ...expected, delivery })
  const output = log.mock.calls.map(call => call.arguments.join(" ")).join("\n")
  assert.match(output, /Telegram post sent \(message ID: 77\)/)
  assert.doesNotMatch(output, /[а-яё]/i)
  assert.deepEqual(calls, [
    ["receipt", "step13-report.json"],
    ["open"],
    ["read", "step-13-report-id"],
    ["close"],
    ["preview", { source: "reports/step-13-report-id" }],
    ["send", { reportId: "step-13-report-id" }],
  ])
})

for (const failure of [
  Object.assign(new Error("Missing receipt"), { code: "ENOENT" }),
  new SyntaxError("Invalid receipt JSON"),
]) {
  test(`${failure.message} fails without opening an archive or creating output`, async () => {
    await assert.rejects(runTelegramStep({
      readJson: async () => {
        throw failure
      },
      createStore: async () => assert.fail("must not open an archive without the receipt"),
      createPreview: async () => assert.fail("must not build without the receipt"),
    }), error => error === failure)
  })
}

test("invalid step 13 IDs fail without opening an archive or creating output", async () => {
  for (const saved of [undefined, null, {}, { id: "" }, { id: " " }, { id: 123 }]) {
    await assert.rejects(runTelegramStep({
      readJson: async () => saved,
      createStore: async () => assert.fail("must not open an archive without an exact ID"),
      createPreview: async () => assert.fail("must not build without an exact ID"),
    }), /Step 13 output is missing a report ID/)
  }
})

for (const failure of [null, new Error("Cannot read saved report")]) {
  test(`${failure ? "archive read errors" : "missing archived reports"} close the store without choosing another report`, async () => {
    let closed = 0
    await assert.rejects(runTelegramStep({
      readJson: async () => ({ id: "saved-report" }),
      createStore: async () => ({
        read: async (id) => {
          assert.equal(id, "saved-report")
          if (failure) {
            throw failure
          }
          return null
        },
        list: async () => assert.fail("must not select the latest archive"),
        close: async () => {
          closed += 1
        },
      }),
      createPreview: async () => assert.fail("must not build without the saved report"),
    }), error => failure ? error === failure : error.message === "Step 13 report saved-report was not found in the archive")
    assert.equal(closed, 1)
  })
}

test("preview failures propagate after the store has closed", async () => {
  const failure = new Error("Cannot write PNG")
  let closed = 0
  await assert.rejects(runTelegramStep({
    readJson: async () => ({ id: "saved-report" }),
    createStore: async () => ({
      read: async () => ({ coins: [] }),
      close: async () => {
        closed += 1
      },
    }),
    createPreview: async () => {
      assert.equal(closed, 1)
      throw failure
    },
  }), error => error === failure)
  assert.equal(closed, 1)
})

test("step 14 reports an already-sent post without claiming a new send", async (t) => {
  const log = t.mock.method(console, "log", () => {})
  const delivery = { status: "already_sent", messageId: 77 }
  const result = await runTelegramStep({
    readJson: async () => ({ id: "saved-report" }),
    createStore: async () => ({ read: async () => ({ coins: [] }), close: async () => {} }),
    createPreview: async () => previewResult(),
    sendRelease: async () => delivery,
  })
  assert.equal(result.delivery, delivery)
  assert.match(log.mock.calls.at(-1).arguments[0], /already sent.*No duplicate was sent/)
})

test("delivery failures propagate without a misleading success log", async (t) => {
  const log = t.mock.method(console, "log", () => {})
  const failure = new Error("Telegram delivery was not confirmed")
  await assert.rejects(runTelegramStep({
    readJson: async () => ({ id: "saved-report" }),
    createStore: async () => ({ read: async () => ({ coins: [] }), close: async () => {} }),
    createPreview: async () => previewResult(),
    sendRelease: async () => {
      throw failure
    },
  }), error => error === failure)
  assert.doesNotMatch(log.mock.calls.flatMap(call => call.arguments).join("\n"), /post sent|already sent|Nothing was sent/)
})

test("the numbered CLI fails without step 13 input and creates no files", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "step14-cli-failure-"))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  await assert.rejects(promisify(execFile)(process.execPath, [
    new URL("../src/step14-telegram.js", import.meta.url).pathname,
  ], { cwd: directory, timeout: 10_000 }), (error) => {
    assert.equal(error.code, 1)
    assert.match(error.stderr, /step14-telegram\.js/)
    assert.match(error.stderr, /ENOENT.*step13-report\.json/)
    assert.doesNotMatch(error.stderr, /--report|--html|--demo/)
    return true
  })
  assert.deepEqual(await fs.readdir(directory), [])
})

test("there is no separate package script for the Telegram step", async () => {
  const data = JSON.parse(await fs.readFile(new URL("../package.json", import.meta.url), "utf8"))
  assert.equal(Object.hasOwn(data.scripts, "report:telegram"), false)
  assert.equal(data.scripts.all, "node src/index.js")
})
