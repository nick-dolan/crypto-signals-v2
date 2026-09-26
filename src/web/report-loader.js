/* global location, webHelpers */

(() => {
  const { byId, isArray, isFinite, isObject, isReportId, isString, requestJson } = webHelpers
  const id = /^\/reports\/([^/]+)\/?$/.exec(location.pathname)?.[1]
  let loading = false

  async function loadReport () {
    if (loading) {
      return
    }
    loading = true
    byId("report-shell").hidden = true
    byId("report-load-state").hidden = false
    byId("report-load-state").setAttribute("aria-busy", "true")
    byId("report-load-message").textContent = "Загружаем отчёт…"
    byId("report-retry").hidden = true
    byId("report-download").hidden = true

    try {
      if (!isReportId(id)) {
        byId("report-load-message").textContent = "Отчёт не найден: некорректный адрес."
        return
      }
      const report = await requestJson(`/api/reports/${id}`)
      if (!isObject(report) || !isArray(report.coins) || !isString(report.asOf) || !isFinite(Date.parse(report.asOf))) {
        throw new Error("Сервер вернул некорректные данные отчёта.")
      }
      byId("report-data").textContent = JSON.stringify(report)
      // Charts need a visible container when measuring the initial layout.
      byId("report-shell").hidden = false
      globalThis.renderReport()
      byId("report-download").href = `/api/reports/${id}/download`
      byId("report-download").hidden = false
      byId("report-load-state").hidden = true
    } catch (error) {
      byId("report-shell").hidden = true
      byId("report-load-message").textContent = error.status === 404
        ? "Отчёт не найден. Возможно, он был удалён."
        : "Не удалось загрузить отчёт. Проверьте соединение и повторите загрузку."
      byId("report-retry").hidden = error.status === 404
    } finally {
      loading = false
      byId("report-load-state").setAttribute("aria-busy", "false")
    }
  }

  byId("report-retry").addEventListener("click", loadReport)
  loadReport()
})()
