import { isFunction, isSafeInteger } from "./utils.typed.js"

export function createConcurrencyLimiter (concurrency = 10) {
  if (!isSafeInteger(concurrency) || concurrency < 1) {
    throw new Error("Concurrency must be a positive integer")
  }

  const queue = []
  const waiters = []
  let active = 0
  let cancelled = false
  let cancellationError

  function notifyIdle () {
    if (active === 0 && queue.length === 0) {
      waiters.splice(0).forEach(resolve => resolve())
    }
  }

  function startQueued () {
    while (!cancelled && active < concurrency && queue.length > 0) {
      const { callback, resolve, reject } = queue.shift()
      active += 1
      Promise.resolve().then(() => {
        if (cancelled) {
          throw cancellationError
        }
        return callback()
      }).then(resolve, reject).finally(() => {
        active -= 1
        startQueued()
        notifyIdle()
      })
    }
  }

  return {
    run (callback) {
      if (!isFunction(callback)) {
        return Promise.reject(new Error("Limited callback must be a function"))
      }
      if (cancelled) {
        return Promise.reject(cancellationError)
      }
      return new Promise((resolve, reject) => {
        queue.push({ callback, resolve, reject })
        startQueued()
      })
    },
    cancel (error) {
      if (!cancelled) {
        cancelled = true
        cancellationError = error
        queue.splice(0).forEach(({ reject }) => reject(error))
        notifyIdle()
      }
    },
    async drain () {
      if (active > 0 || queue.length > 0) {
        await new Promise(resolve => waiters.push(resolve))
      }
    },
  }
}
