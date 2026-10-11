import assert from "node:assert/strict"
import test from "node:test"

import { createConcurrencyLimiter } from "../src/helpers/concurrency-limiter.js"

for (const concurrency of [undefined, 9]) {
  test(`FIFO limiter bounds both producers to ${concurrency ?? 10} active calls and drains the queue`, async () => {
    const limiter = createConcurrencyLimiter(concurrency)
    const ceiling = concurrency ?? 10
    const gates = Array.from({ length: 24 }, () => Promise.withResolvers())
    const started = []
    const firstBatch = Promise.withResolvers()
    const nextStarted = Promise.withResolvers()
    let active = 0
    let maximum = 0
    const pending = gates.map((gate, index) => limiter.run(async () => {
      started.push(index)
      active += 1
      maximum = Math.max(maximum, active)
      if (started.length === ceiling) {
        firstBatch.resolve()
      }
      if (index === ceiling) {
        nextStarted.resolve()
      }
      await gate.promise
      active -= 1
      return index
    }))
    const results = Promise.all(pending)
    let drained = false
    const drain = limiter.drain().then(() => {
      drained = true
    })

    try {
      await firstBatch.promise
      assert.deepEqual(started, Array.from({ length: ceiling }, (_, index) => index))
      assert.equal(drained, false)
      gates[0].resolve()
      await nextStarted.promise
      assert.equal(started.at(-1), ceiling)
      assert.equal(maximum, ceiling)
    } finally {
      gates.forEach(gate => gate.resolve())
    }
    assert.deepEqual(await results, Array.from({ length: 24 }, (_, index) => index))
    await drain
    assert.equal(drained, true)
    assert.equal(active, 0)
    assert.deepEqual(started, Array.from({ length: 24 }, (_, index) => index))
    await limiter.drain()
  })
}

test("cancellation rejects queued and future calls with the original error but drains active work", async () => {
  const limiter = createConcurrencyLimiter(1)
  const gate = Promise.withResolvers()
  const started = Promise.withResolvers()
  const expected = new Error("Mandatory branch failed")
  const pending = [limiter.run(async () => {
    started.resolve()
    await gate.promise
    return "finished"
  }), limiter.run(() => assert.fail("Queued callback must not start"))]
  const settled = Promise.allSettled(pending)
  await started.promise
  limiter.cancel(expected)
  limiter.cancel(new Error("Must not replace the first error"))
  await assert.rejects(limiter.run(() => assert.fail("Cancelled limiter must stay closed")), error => error === expected)
  let drained = false
  const drain = limiter.drain().then(() => {
    drained = true
  })
  assert.equal(drained, false)
  gate.resolve()
  const result = await settled
  await drain
  assert.deepEqual(result[0], { status: "fulfilled", value: "finished" })
  assert.equal(result[1].reason, expected)
  assert.equal(drained, true)
})

test("sync and async failures release slots without cancelling ordinary subsequent work", async () => {
  const limiter = createConcurrencyLimiter(1)
  const syncError = new Error("Sync failure")
  const asyncError = new Error("Async failure")
  const result = await Promise.allSettled([
    limiter.run(() => {
      throw syncError
    }),
    limiter.run(async () => {
      throw asyncError
    }),
    limiter.run(() => "next"),
  ])
  await limiter.drain()
  assert.equal(result[0].reason, syncError)
  assert.equal(result[1].reason, asyncError)
  assert.deepEqual(result[2], { status: "fulfilled", value: "next" })
})

test("rejects invalid limits and callbacks without scheduling work", async () => {
  for (const concurrency of [0, -1, 1.5, "9", null, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => createConcurrencyLimiter(concurrency), /positive integer/)
  }
  const limiter = createConcurrencyLimiter(1)
  await assert.rejects(limiter.run(null), /must be a function/)
  await limiter.drain()
  limiter.cancel(new Error("Idle cancellation"))
  await limiter.drain()
})

test("cancellation before the start microtask prevents even an already-admitted callback from running", async () => {
  const limiter = createConcurrencyLimiter(1)
  const expected = new Error("Cancelled before start")
  const pending = limiter.run(() => assert.fail("Admitted but not started call must not run"))
  limiter.cancel(expected)
  await assert.rejects(pending, error => error === expected)
  await limiter.drain()
})
