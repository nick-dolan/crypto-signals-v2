import { isFunction } from "./utils.typed.js"

export class RequestCooldownError extends Error {
}

export function createRequestRateLimiter () {
  let queue = Promise.resolve()
  let nextStartAt = 0
  let cooldownUntil = 0
  let wake

  return {
    run (callback) {
      if (!isFunction(callback)) {
        return Promise.reject(new Error("Limited callback must be a function"))
      }

      return new Promise((resolve, reject) => {
        queue = queue.then(async () => {
          try {
            for (;;) {
              const now = performance.now()
              if (cooldownUntil - now > 60_000) {
                throw new RequestCooldownError("Request cooldown exceeds 60 seconds")
              }
              const delayMs = Math.max(nextStartAt, cooldownUntil) - now
              if (delayMs <= 0) {
                break
              }

              let timer
              await new Promise((resolve) => {
                wake = resolve
                timer = setTimeout(resolve, delayMs)
              })
              clearTimeout(timer)
              wake = undefined
            }

            nextStartAt = performance.now() + 100
            resolve(callback())
          } catch (error) {
            reject(error)
          }
        })
      })
    },
    pause (delayMs) {
      const until = performance.now() + delayMs
      if (until > cooldownUntil) {
        cooldownUntil = until
        wake?.()
      }
    },
  }
}
