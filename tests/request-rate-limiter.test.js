import assert from "node:assert/strict"
import test from "node:test"

import { createRequestRateLimiter, RequestCooldownError } from "../src/helpers/request-rate-limiter.js"

function flush () {
  return new Promise(resolve => setImmediate(resolve))
}

async function tick (context, ms) {
  context.mock.timers.tick(ms)
  await flush()
}

function setup (context) {
  context.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 0 })
  context.mock.method(performance, "now", () => Date.now())
  return createRequestRateLimiter()
}

function assertPaced (starts) {
  starts.forEach((time, index) => {
    if (index > 0) {
      assert.ok(time - starts[index - 1] >= 100)
    }
    assert.ok(starts.filter(start => start > time - 1_000 && start <= time).length <= 10)
  })
}

test("FIFO starts from two producers are paced at 100ms without waiting for HTTP completion", async (context) => {
  const limiter = setup(context)
  const gates = Array.from({ length: 24 }, () => Promise.withResolvers())
  const starts = []
  let active = 0
  let maximum = 0
  const pending = gates.map((gate, index) => limiter.run(async () => {
    starts.push({ producer: index % 2, index, time: Date.now() })
    active += 1
    maximum = Math.max(maximum, active)
    await gate.promise
    active -= 1
    return index
  }))
  const results = Promise.all(pending)

  await flush()
  assert.equal(starts.length, 1)
  for (let index = 1; index < gates.length; index += 1) {
    await tick(context, 99)
    assert.equal(starts.length, index)
    await tick(context, 1)
    assert.equal(starts.length, index + 1)
  }
  assert.deepEqual(starts, gates.map((gate, index) => ({ producer: index % 2, index, time: index * 100 })))
  assert.equal(maximum, 24)
  assertPaced(starts.map(({ time }) => time))
  gates.toReversed().forEach(gate => gate.resolve())
  assert.deepEqual(await results, gates.map((gate, index) => index))
  assert.equal(active, 0)
})

test("staggered producers retain FIFO and rolling 10/s without catch-up bursts after stalls or idle", async (context) => {
  const limiter = setup(context)
  const starts = []
  const pending = []
  const enqueue = label => pending.push(limiter.run(() => {
    starts.push({ label, time: Date.now() })
    return label
  }))

  enqueue("A0")
  await flush()
  await tick(context, 35)
  enqueue("B0")
  await flush()
  assert.equal(starts.length, 1)
  await tick(context, 65)
  await tick(context, 35)
  for (const label of ["A1", "B1", "A2", "B2"]) {
    enqueue(label)
  }
  await tick(context, 65)
  await tick(context, 2_500)
  assert.equal(starts.length, 4)
  await tick(context, 99)
  assert.equal(starts.length, 4)
  await tick(context, 1)
  await tick(context, 100)
  await Promise.all(pending)

  await tick(context, 5_000)
  for (const label of ["A3", "B3", "A4", "B4"]) {
    enqueue(label)
  }
  await flush()
  assert.equal(starts.length, 7)
  for (let index = 0; index < 3; index += 1) {
    await tick(context, 100)
  }
  assert.deepEqual(starts.map(({ time }) => time), [0, 100, 200, 2_700, 2_800, 2_900, 7_900, 8_000, 8_100, 8_200])
  assert.deepEqual(await Promise.all(pending), ["A0", "B0", "A1", "B1", "A2", "B2", "A3", "B3", "A4", "B4"])
  assertPaced(starts.map(({ time }) => time))
})

test("a synchronous event-loop stall does not admit several queued starts at once", async (context) => {
  const limiter = setup(context)
  const starts = []
  const pending = [limiter.run(() => {
    starts.push(Date.now())
    context.mock.timers.setTime(5_000)
  }), ...Array.from({ length: 3 }, () => limiter.run(() => starts.push(Date.now())))]

  await flush()
  assert.deepEqual(starts, [0, 5_000])
  await tick(context, 100)
  await tick(context, 100)
  await Promise.all(pending)
  assert.deepEqual(starts, [0, 5_000, 5_100, 5_200])
  assertPaced(starts)
})

test("shared cooldown wakes and rechecks a waiting gate on extension without shortening or bursting", async (context) => {
  const limiter = setup(context)
  const starts = []
  const pending = Array.from({ length: 4 }, () => limiter.run(() => starts.push(Date.now())))
  const cleared = context.mock.method(globalThis, "clearTimeout")

  await flush()
  await tick(context, 50)
  limiter.pause(1_000)
  await flush()
  assert.equal(cleared.mock.callCount(), 1)
  await tick(context, 50)
  assert.deepEqual(starts, [0])
  await tick(context, 900)
  limiter.pause(2_000)
  await flush()
  limiter.pause(100)
  await tick(context, 50)
  assert.deepEqual(starts, [0])
  await tick(context, 1_949)
  assert.deepEqual(starts, [0])
  await tick(context, 1)
  await tick(context, 100)
  await tick(context, 100)
  await Promise.all(pending)
  assert.deepEqual(starts, [0, 3_000, 3_100, 3_200])
  assertPaced(starts)
})

test("sync, async and invalid-callback rejections do not poison the admission queue", async (context) => {
  const limiter = setup(context)
  const syncError = new Error("Sync failure")
  const asyncError = new Error("Async failure")
  const starts = []
  const settled = Promise.allSettled([
    limiter.run(null),
    limiter.run(() => {
      starts.push(Date.now())
      throw syncError
    }),
    limiter.run(async () => {
      starts.push(Date.now())
      throw asyncError
    }),
    limiter.run(() => {
      starts.push(Date.now())
      return "next"
    }),
  ])

  await flush()
  await tick(context, 100)
  await tick(context, 100)
  const results = await settled
  assert.match(results[0].reason.message, /must be a function/)
  assert.equal(results[1].reason, syncError)
  assert.equal(results[2].reason, asyncError)
  assert.deepEqual(results[3], { status: "fulfilled", value: "next" })
  const next = limiter.run(() => {
    starts.push(Date.now())
    return "recovered"
  })
  await tick(context, 100)
  assert.equal(await next, "recovered")
  assert.deepEqual(starts, [0, 100, 200, 300])
})

test("oversized cooldown rejects queued work promptly, preserves the deadline and later recovers", async (context) => {
  const limiter = setup(context)
  const starts = []
  await limiter.run(() => starts.push(Date.now()))
  const waiting = limiter.run(() => assert.fail("Must not start during cooldown"))
  const settled = Promise.allSettled([waiting])
  await flush()
  limiter.pause(60_001)
  const future = assert.rejects(limiter.run(() => assert.fail("Must not start during cooldown")), RequestCooldownError)
  await flush()
  assert.equal((await settled)[0].reason instanceof RequestCooldownError, true)
  await future
  assert.deepEqual(starts, [0])

  await tick(context, 60_000)
  const recovered = limiter.run(() => starts.push(Date.now()))
  await flush()
  assert.deepEqual(starts, [0])
  await tick(context, 1)
  await recovered
  assert.deepEqual(starts, [0, 60_001])
})
