/* global webHelpers */

(() => {
  const { byId, element, isArray, isFinite, isObject, isReportId, isSafeInteger, isString, requestJson } = webHelpers
  let group = "week"
  let pages = []
  let pageIndex = -1
  let requestId = 0
  let loading = false
  let failedPage = 0

  function validTimestamp (value) {
    return isString(value) && isFinite(Date.parse(value))
  }

  function validPage (page) {
    return isObject(page) && isArray(page.groups) && isSafeInteger(page.total) && page.total >= 0
      && (page.nextCursor === null || (isString(page.nextCursor) && page.nextCursor.length > 0))
      && page.groups.every(item => isObject(item) && isString(item.key) && isString(item.label)
        && isArray(item.reports) && item.reports.every(report => isObject(report) && isReportId(report.id)
          && validTimestamp(report.reportCreatedAt) && validTimestamp(report.asOf)
          && isSafeInteger(report.candidateCount) && report.candidateCount >= 0
          && isSafeInteger(report.universeCoinCount) && report.universeCoinCount >= 0))
  }

  function time (value) {
    const node = element("time", "", new Intl.DateTimeFormat("ru-RU", {
      timeZone: "Etc/GMT-3", year: "numeric", month: "short", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    }).format(new Date(value)))
    node.dateTime = value
    return node
  }

  function reportRow (report) {
    const row = element("li", "report-row")
    const main = element("div", "report-row-main")
    const link = element("a", "report-open")
    link.href = `/reports/${encodeURIComponent(report.id)}`
    link.append(time(report.reportCreatedAt))
    const snapshot = element("span", "muted", "Срез: ")
    snapshot.append(time(report.asOf))
    main.append(link, snapshot)
    const counts = element("div", "report-counts")
    counts.append(
      element("span", "", `Кандидатов: ${report.candidateCount}`),
      element("span", "muted", `Монет во вселенной: ${report.universeCoinCount}`),
    )
    const download = element("a", "report-download", "Скачать HTML")
    download.href = `/api/reports/${encodeURIComponent(report.id)}/download`
    download.download = ""
    row.append(main, counts, download)
    return row
  }

  function reportCount (page) {
    return page.groups.reduce((count, item) => count + item.reports.length, 0)
  }

  function updateControls () {
    byId("reports-previous").disabled = loading || pageIndex <= 0
    byId("reports-next").disabled = loading || !pages[pageIndex]?.nextCursor
    byId("report-groups").setAttribute("aria-busy", String(loading))
    byId("reports-page").textContent = `Страница ${Math.max(0, pageIndex) + 1}`
    for (const value of ["week", "month"]) {
      byId(`group-${value}`).setAttribute("aria-pressed", String(group === value))
    }
  }

  function renderPage () {
    const page = pages[pageIndex]
    const count = reportCount(page)
    const offset = pages.slice(0, pageIndex).reduce((total, item) => total + reportCount(item), 0)
    const previousGroups = new Set(pages.slice(0, pageIndex).flatMap(item => item.groups.map(item => item.key)))
    byId("report-groups").replaceChildren(...page.groups.map((item) => {
      const section = element("section", "report-group panel")
      const heading = element("div", "section-heading")
      heading.append(
        element("h2", "", item.label),
        element("span", "muted", previousGroups.has(item.key) ? "Продолжение" : ""),
      )
      const list = element("ul", "report-list")
      list.append(...item.reports.map(reportRow))
      section.append(heading, list)
      return section
    }))
    byId("reports-summary").textContent = count
      ? `Всего: ${page.total} · показано ${offset + 1}–${offset + count} · UTC+3`
      : `Всего: ${page.total}`
    byId("reports-state").hidden = count > 0
    byId("reports-message").textContent = page.total === 0
      ? "Сохранённых отчётов пока нет. Они появятся здесь после создания."
      : "В этой части списка нет отчётов. Вернитесь на предыдущую страницу или обновите список."
    byId("reports-retry").hidden = true
    updateControls()
  }

  async function loadPage (index) {
    const currentRequest = ++requestId
    failedPage = index
    if (pages[index]) {
      loading = false
      renderPageAt(index)
      return
    }
    loading = true
    byId("reports-state").hidden = false
    byId("reports-message").textContent = "Загружаем отчёты…"
    byId("reports-retry").hidden = true
    updateControls()
    const params = new URLSearchParams({ group, limit: "30" })
    if (index > 0) {
      params.set("cursor", pages[index - 1].nextCursor)
    }
    try {
      const page = await requestJson(`/api/reports?${params}`)
      if (currentRequest !== requestId) {
        return
      }
      if (!validPage(page)) {
        throw new Error("Некорректный список отчётов")
      }
      pages[index] = page
      renderPageAt(index)
    } catch {
      if (currentRequest !== requestId) {
        return
      }
      byId("reports-message").textContent = "Не удалось загрузить список отчётов. Проверьте соединение и повторите загрузку."
      byId("reports-retry").hidden = false
    } finally {
      if (currentRequest === requestId) {
        loading = false
        updateControls()
      }
    }
  }

  function renderPageAt (index) {
    pageIndex = index
    renderPage()
  }

  function reset () {
    pages = []
    pageIndex = -1
    byId("report-groups").replaceChildren()
    byId("reports-summary").textContent = ""
    return loadPage(0)
  }

  for (const value of ["week", "month"]) {
    byId(`group-${value}`).addEventListener("click", () => {
      if (group !== value) {
        group = value
        return reset()
      }
    })
  }
  byId("reports-refresh").addEventListener("click", reset)
  byId("reports-retry").addEventListener("click", () => !loading && loadPage(failedPage))
  byId("reports-previous").addEventListener("click", () => {
    if (!loading && pageIndex > 0) {
      return loadPage(pageIndex - 1)
    }
  })
  byId("reports-next").addEventListener("click", () => {
    if (!loading && pages[pageIndex]?.nextCursor) {
      return loadPage(pageIndex + 1)
    }
  })
  reset()
})()
