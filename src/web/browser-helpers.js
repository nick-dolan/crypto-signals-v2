/* global document, webTypes */

(() => {
  const { isString } = webTypes

  function byId (id) {
    return document.getElementById(id)
  }

  function element (tag, className = "", text = "") {
    const node = document.createElement(tag)
    node.className = className
    node.textContent = text
    return node
  }

  function isReportId (value) {
    return isString(value) && /^[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}$/i.test(value)
  }

  async function requestJson (url) {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 15_000)

    try {
      const response = await fetch(url, {
        method: "GET", credentials: "same-origin", cache: "no-store", signal: controller.signal,
        headers: { Accept: "application/json" },
      })
      if (!response.ok) {
        const error = new Error(`Сервер вернул ошибку (HTTP ${response.status}).`)
        error.status = response.status
        throw error
      }
      try {
        return await response.json()
      } catch {
        throw new Error("Сервер вернул некорректный JSON.")
      }
    } catch (error) {
      if (controller.signal.aborted) {
        throw new Error("Сервер не ответил за 15 секунд. Повторите загрузку.", { cause: error })
      }
      throw error
    } finally {
      clearTimeout(timeout)
    }
  }

  globalThis.webHelpers = { ...webTypes, byId, element, isReportId, requestJson }
})()
