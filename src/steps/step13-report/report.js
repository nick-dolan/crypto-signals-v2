/* global document, LightweightCharts, updateChartHistory */

(() => {
  const report = JSON.parse(document.getElementById("report-data").textContent)
  const coinsBySymbol = new Map(report.coins.map(coin => [coin.symbol, coin]))
  const coinDescriptions = new Map(Object.entries(report.coinDescriptions ?? {}))
  const chartStates = new Map(report.coins.map(coin => [coin.symbol, { data: null, pending: false, error: null, requested: false }]))
  const topCandidates = report.coins.filter(coin => coin.topRank != null)
    .sort((first, second) => first.topRank - second.topRank)
  let selectedSymbol = topCandidates[0]?.symbol ?? report.coins[0]?.symbol ?? null
  let selectedDays = 7
  let chart = null
  let peerDays = 1
  const peerCards = []

  function element (tag, className = "", text = "") {
    const node = document.createElement(tag)
    node.className = className
    node.textContent = text
    return node
  }

  function byId (id) {
    return document.getElementById(id)
  }

  function number (value, digits = 2, signDisplay = "auto") {
    if (value == null) {
      return "—"
    }
    if (digits > 16) {
      return new Intl.NumberFormat("ru-RU", {
        notation: "scientific", maximumSignificantDigits: 6, signDisplay,
      }).format(value)
    }
    return new Intl.NumberFormat("ru-RU", {
      maximumFractionDigits: digits,
      signDisplay,
    }).format(value)
  }

  function probability (value) {
    return value == null ? "—" : `${number(value * 100, 0)}%`
  }

  function time (timestamp, seconds = false) {
    return new Intl.DateTimeFormat("ru-RU", {
      timeZone: "UTC",
      year: "numeric",
      month: "short",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: seconds ? "2-digit" : undefined,
    }).format(new Date(timestamp))
  }

  function confidence (value) {
    return { high: "высокая", medium: "средняя", low: "низкая" }[value] ?? "нет оценки"
  }

  function flagLabel (value) {
    return {
      coiling: "Накопление в сжатии",
      attention_ahead: "Внимание сильнее цены",
      unconfirmed_move: "Движение без подтверждения",
      exhausted_hype: "Затухание внимания",
      laggard: "Отстаёт от категории",
      resilient: "Устойчивость к BTC",
      squeeze_fuel: "Топливо для сквиза",
      range_pressure_up: "Давление на верхнюю границу",
      range_pressure_down: "Давление на нижнюю границу",
      short_squeeze_setup: "Условия для short squeeze ↑",
      long_squeeze_setup: "Условия для long squeeze ↓",
      fresh_quiet_breakout: "Свежий пробой тихой базы",
      late_pump: "Поздний памп",
      late_dump: "Позднее падение",
    }[value] ?? value
  }

  function featureValue (key, value) {
    switch (value) {
      case null:
      case undefined:
        return "Нет данных / события"
      case true:
        return "Да"
      case false:
        return "Нет"
      default:
        if (key === "coingeckoTrendingCategories") {
          return value.length ? value.join(", ") : "Нет пересечений с трендовыми категориями"
        }
        if (key === "peerLeaders") {
          return JSON.stringify(value)
        }
        return key === "flags" ? value.map(flagLabel).join(", ") || "Нет активных" : String(value)
    }
  }

  function renderAltMarketBackground () {
    const background = report.altMarketBackground ?? {
      status: "unavailable", change4hPct: null, breadth4h: null,
      warning: "В этом отчёте фон альтрынка не рассчитан. Выполните шаги 4–6 и пересоздайте HTML для того же среза.",
    }
    const status = ["up", "down", "mixed"].includes(background.status) ? background.status : "unavailable"
    const [label, icon] = {
      up: ["Преобладает рост", "↑"],
      down: ["Преобладает снижение", "↓"],
      mixed: ["Смешанный фон", "↔"],
      unavailable: ["Недостаточно данных", "—"],
    }[status]

    byId("alt-market-background").dataset.status = status
    byId("alt-market-status").textContent = label
    byId("alt-market-icon").textContent = icon
    byId("alt-market-change").textContent = background.change4hPct == null
      ? "Нет данных"
      : `${number(background.change4hPct, 3, "exceptZero")}%`
    byId("alt-market-breadth").textContent = background.breadth4h == null
      ? "Нет данных"
      : `${number(background.breadth4h * 100, 2)}%`
    byId("alt-market-as-of").textContent = `Срез ${time(report.asOf)} UTC · фон не меняется при Update chart`
    byId("alt-market-warning").textContent = background.warning ?? ""
    byId("alt-market-warning").hidden = !background.warning
  }

  function renderSummary () {
    byId("as-of").dateTime = report.asOf
    byId("as-of").textContent = time(report.asOf)
    byId("coverage").textContent = `${report.candidateCount} оценено / ${report.universeCoinCount} монет во вселенной`
    byId("candidate-count").textContent = report.candidateCount
    byId("objective").textContent = `Цель анализа: ${report.objective}`
    byId("candle-time-note").textContent = `Время на графике — UTC, по открытию свечи. Последняя свеча среза закрыта ${time(Date.parse(report.asOf) + 3_600_000)} UTC.`

    renderAltMarketBackground()
    byId("market-summary").replaceChildren(...[
      ["breadth4h", "Растущие монеты · 4h", 100, "%"],
      ["btcRotation4hPct", "Доля BTC · 4h", 1, " п.п."],
      ["ethRotation4hPct", "Доля ETH · 4h", 1, " п.п."],
      ["altsRotation4hPct", "Доля альткоинов · 4h", 1, " п.п."],
      ["stablesRotation4hPct", "Доля стейблкоинов · 4h", 1, " п.п."],
      ["stablecap24hPct", "Капитализация стейблов · 24h", 1, "%"],
    ].map(([key, label, multiplier, suffix]) => {
      const card = element("div", "market-card")
      const value = report.marketContext?.[key]
      card.title = report.marketDefinitions?.[key] ?? ""
      card.append(
        element("span", "metric-label", label),
        element("strong", "metric-value", value == null ? "Нет данных" : `${number(value * multiplier, 3, key === "breadth4h" ? "auto" : "exceptZero")}${suffix}`),
      )
      return card
    }))
  }

  function createCoinGeckoBadge () {
    const badge = element("span", "badge coingecko-badge", "CoinGecko Trending")
    badge.title = "Поисковое внимание CoinGecko, не сигнал роста"
    return badge
  }

  function renderTopCandidates () {
    byId("top-candidates").replaceChildren(...topCandidates.map((coin) => {
      const card = element("button", "top-card")
      card.type = "button"
      card.dataset.symbol = coin.symbol
      card.setAttribute("aria-pressed", String(coin.symbol === selectedSymbol))
      const heading = element("span", "top-card-heading")
      heading.append(element("span", "top-card-rank", `0${coin.topRank}`), element("span", "top-card-symbol", coin.symbol))
      if (coin.features.coingeckoTrending === true) {
        heading.append(createCoinGeckoBadge())
      }
      const estimate = element("span", "top-card-probability")
      estimate.append(element("strong", "", probability(coin.movementProbability)), element("span", "muted", "P движения"))
      const track = element("span", "probability-track")
      const fill = element("span", "probability-fill")
      fill.style.width = `${coin.movementProbability * 100}%`
      track.setAttribute("aria-hidden", "true")
      track.append(fill)
      const footer = element("span", "top-card-footer muted", `Уверенность: ${confidence(coin.estimateConfidence)}`)
      card.append(heading, element("span", "top-card-name", coin.name), estimate, track, footer)
      return card
    }))

    if (!topCandidates.length) {
      byId("top-candidates").append(element("p", "muted", "Агент не выделил лучших кандидатов в этом срезе."))
    }
  }

  function renderCandidates () {
    const query = byId("search").value.trim().toLocaleLowerCase()
    const sort = byId("sort").value
    const coins = report.coins
      .filter(coin => `${coin.symbol} ${coin.name}`.toLocaleLowerCase().includes(query))
      .sort((first, second) => {
        if (sort === "top" && first.topRank !== second.topRank) {
          return (first.topRank ?? Infinity) - (second.topRank ?? Infinity)
        }
        if (sort === "confidence" && first.estimateConfidence !== second.estimateConfidence) {
          return ["high", "medium", "low"].indexOf(first.estimateConfidence)
            - ["high", "medium", "low"].indexOf(second.estimateConfidence)
        }
        return second.movementProbability - first.movementProbability || first.symbol.localeCompare(second.symbol)
      })

    byId("candidate-rows").replaceChildren(...coins.map((coin) => {
      const row = element("tr", coin.symbol === selectedSymbol ? "selected" : "")
      row.dataset.symbol = coin.symbol
      const cell = element("td")
      const button = element("button", "coin-button")
      button.type = "button"
      button.setAttribute("aria-pressed", String(coin.symbol === selectedSymbol))
      button.append(element("strong", "", coin.symbol))
      if (coin.topRank != null) {
        button.append(element("span", "top-star", `★ ${coin.topRank}`))
      }
      if (coin.features.coingeckoTrending === true) {
        button.append(createCoinGeckoBadge())
      }
      button.append(element("small", "", coin.name))
      cell.append(button)
      row.append(cell, element("td", "", probability(coin.movementProbability)))
      return row
    }))

    if (!coins.length) {
      const row = element("tr")
      const cell = element("td", "empty-state", "Ничего не найдено")
      cell.colSpan = 2
      row.append(cell)
      byId("candidate-rows").append(row)
    }
    byId("search-results").textContent = `Показано ${coins.length} из ${report.candidateCount}`
  }

  function renderSignals (id, signals) {
    byId(id).replaceChildren(...(signals ?? []).map((signal) => {
      const item = element("li")
      // Skip separators inside JSON evidence strings, including escaped quotes.
      const separator = [...signal.matchAll(/"(?:\\.|[^"\\])*"|: /g)].find(([match]) => match === ": ")?.index ?? -1
      if (separator > 0 && signal.slice(0, separator).includes("=")) {
        item.append(element("span", "", signal.slice(separator + 2)), element("span", "signal-values", signal.slice(0, separator)))
      } else {
        item.textContent = signal
      }
      return item
    }))
    if (!signals?.length) {
      byId(id).append(element("li", "muted", "Агент не указал."))
    }
  }

  function sourceLink (label, href) {
    try {
      const url = new URL(href)
      if (["https:", "http:"].includes(url.protocol)) {
        const link = element("a", "", label)
        link.href = url.href
        link.target = "_blank"
        link.rel = "noopener noreferrer"
        return link
      }
    } catch {
      // A missing or unsafe URL is shown as text, never as an executable link.
    }
    return element("span", "", label)
  }

  function publicationTime (timestamp) {
    if (timestamp != null) {
      try {
        return `${time(timestamp)} UTC`
      } catch {
        // A malformed publication date should not hide the saved text.
      }
    }
    return "Время не указано"
  }

  function coinDescription (coin) {
    const info = coinDescriptions.get(coin.baseCurrencyId)
    const section = element("section", "coin-description")
    section.setAttribute("aria-label", `О монете ${coin.symbol}`)
    section.append(element(
      "p", info ? "coin-description-text" : "coin-description-text muted",
      info?.description || "Описание пока не добавлено",
    ))
    const links = (info?.sources ?? []).flatMap((source) => {
      const link = sourceLink("", source.url)
      if (link.tagName !== "A") {
        return []
      }
      const { hostname } = new URL(link.href)
      link.textContent = hostname === "api.coingecko.com" ? "CoinGecko" : hostname.replace(/^www\./, "")
      if (source.checkedAt) {
        link.title = `Проверено: ${publicationTime(source.checkedAt)}`
      }
      return [link]
    })
    if (links.length) {
      const sources = element("div", "coin-description-sources")
      sources.append(element("span", "muted", "Источники:"), ...links)
      section.append(sources)
    }
    return section
  }

  function peerMetrics (entries) {
    const metrics = element("dl", "peer-metrics")
    metrics.append(...entries.map(([label, value, unit, signed = false]) => {
      const item = element("div")
      item.append(
        element("dt", "metric-label", label),
        element("dd", "", value == null ? "Нет данных" : `${number(value, 2, signed ? "exceptZero" : "auto")}${unit}`),
      )
      return item
    }))
    return metrics
  }

  function peerMarketLink (label, marketSymbol) {
    if (!marketSymbol) {
      return element("span", "", label)
    }
    const url = new URL("https://www.tradingview.com/chart/")
    url.searchParams.set("symbol", marketSymbol)
    return sourceLink(label, url.href)
  }

  function peerLeader (leader, coin, snapshotClosedAt) {
    const article = element("article", "peer-leader")
    const relation = leader.type === "competitor" ? "Конкурент" : "Смежный сосед"
    const freshness = leader.status === "fresh" ? "Свежий импульс (fresh)" : "Затухающий импульс (fading)"
    const reaction = leader.coinReaction === "flat"
      ? "Слабая (flat)"
      : leader.coinReaction === "rising" ? "Рост (rising)" : "Снижение (falling)"
    const heading = element("h3")
    heading.append(
      peerMarketLink(leader.symbol, report.peerRadar.histories?.[leader.baseCurrencyId]?.marketSymbol),
      element("span", "", ` · ${relation}`),
    )
    article.append(
      heading,
      element("p", "peer-radar-meta", `${freshness} · Возраст с обнаружения: ${number(leader.ageHours)} ч · Обнаружен: ${publicationTime(leader.detectedAt)}`),
      element("p", "peer-radar-text", `Связь по справочнику: ${leader.basis}`),
      element("p", "peer-radar-note", `Оговорка связи: ${leader.caveat}`),
      element("p", "peer-current-window", `Текущий интервал: ${publicationTime(leader.windowStartedAt)} → ${publicationTime(snapshotClosedAt)}`),
      element("p", "peer-reaction", `Реакция ${coin.symbol} на этом интервале: ${reaction}`),
      peerMetrics([
        [`Лидер ${leader.symbol} · изменение цены`, leader.returnSinceStartPct, "%", true],
        [`Кандидат ${coin.symbol} · изменение цены`, leader.coinReturnSinceStartPct, "%", true],
        ["Лидер · движение в своём ATR", leader.moveSinceStartAtr, " ATR", true],
        ["Кандидат · движение в своём ATR", leader.coinMoveSinceStartAtr, " ATR", true],
        ["Разрыв · лидер минус кандидат в своих ATR", leader.gapAtr, " ATR"],
        ["Удержание движения от пика", leader.retainedPct, "%"],
        ["Кандидат / лидер · отношение в своих ATR", leader.responseRatio, "×"],
      ]),
    )
    const original = element("details", "peer-original")
    original.append(
      element("summary", "", "Исходный импульс · 4ч (зафиксирован)"),
      element("p", "peer-radar-meta", `Окно обнаружения: ${publicationTime(leader.windowStartedAt)} → ${publicationTime(leader.detectedAt)}. Это исходные значения, не текущая доходность.`),
      peerMetrics([
        ["Лидер · исходное изменение цены за 4ч", leader.return4hPct, "%", true],
        ["Лидер · исходное движение за 4ч", leader.move4hAtr, " ATR", true],
        ["Превышение над рынком за 4ч", leader.marketExcess4hAtr, " ATR", true],
        ["Объём за 4ч / сезонная норма", leader.relativeVolume4h, "×"],
      ]),
    )
    article.append(original)
    return article
  }

  function peerObservation (observation, snapshotClosedAt) {
    const { coin } = observation
    const card = element("article", "peer-observation")
    const verdict = observation.verdict === "watch" ? "watch" : "limited"
    card.dataset.verdict = verdict
    const heading = element("header", "peer-observation-heading")
    const title = element("h3", "peer-symbol", coin.symbol)
    title.id = `peer-observation-${peerCards.length}`
    card.setAttribute("aria-labelledby", title.id)
    heading.append(
      title,
      element("span", "peer-name", coin.name),
      element("span", "peer-verdict", verdict === "watch" ? "Обратить внимание" : "Ограниченная интерпретация"),
      element("span", "peer-radar-meta", `Лидеров: ${observation.leaders.length}`),
    )
    heading.append(peerMarketLink("Открыть в TradingView ↗", coin.marketSymbol))
    const comparison = element("div", "peer-comparison")
    const timestamp = element("p", "peer-chart-time")
    const legend = element("div", "peer-chart-legend")
    legend.setAttribute("role", "list")
    legend.setAttribute("aria-label", "Легенда: изменение цены закрытия, %")
    const container = element("div", "peer-chart")
    container.setAttribute("role", "img")
    container.setAttribute("aria-label", `${coin.symbol} и все прямые лидеры: изменение цены закрытия в процентах`)
    const warning = element("p", "warning")
    warning.setAttribute("role", "status")
    warning.hidden = true
    const empty = element("p", "empty-state")
    empty.hidden = true
    comparison.append(timestamp, legend, container, warning, empty)
    peerCards.push({ observation, container, timestamp, legend, warning, empty, chart: null })
    const facts = element("details", "peer-observation-facts")
    const body = element("div", "peer-observation-body")
    body.append(
      element("p", "peer-radar-text", observation.explanation),
      element("p", "peer-radar-meta", `${observation.peerStatus === "partial" ? "Частичное покрытие" : "Полное покрытие"} · Соседи с данными: ${number(observation.availablePeerCount, 0)} / ${number(observation.peerCount, 0)} · Монет для сравнения с рынком: ${number(observation.benchmarkCoinCount, 0)}`),
    )
    if (observation.caveats.length) {
      const caveats = element("ul", "peer-caveats")
      caveats.append(...observation.caveats.map(caveat => element("li", "", caveat)))
      body.append(element("h3", "", "Оговорки"), caveats)
    }
    body.append(...observation.leaders.map(leader => peerLeader(leader, coin, snapshotClosedAt)))
    facts.append(element("summary", "", "Факты и объяснение агента · ATR"), body)
    card.append(heading, coinDescription(coin), comparison, facts)
    return card
  }

  function peerLine (member, index, from, to) {
    const history = report.peerRadar.histories?.[member.baseCurrencyId]
    const closes = new Map((history?.points ?? []).map(point => [point.time, point.value]))
    const anchor = closes.get(from)
    const disabled = !isFinite(anchor) || anchor <= 0
    const warnings = history?.warning ? [history.warning] : []
    const points = disabled
      ? []
      : Array.from({ length: (to - from) / 3_600 + 1 }, (_, hour) => {
          const time = from + hour * 3_600
          const close = closes.get(time)
          const value = (close / anchor - 1) * 100
          return isFinite(close) && close > 0 && isFinite(value) ? { time, value } : { time }
        })
    if (disabled) {
      warnings.push(`Нет цены закрытия на общей базе ${time(from * 1_000)} UTC — линия отключена, другая точка не подставляется.`)
    } else {
      const missing = points.filter(point => point.value == null).length
      if (missing) {
        warnings.push(`Нет ${missing} из ${points.length} часовых закрытий; пропуски не соединяются.`)
      }
    }
    return {
      symbol: member.symbol,
      marketSymbol: history?.marketSymbol,
      role: index === 0 ? "Кандидат" : "Лидер",
      color: index === 0 ? "#f2c56d" : ["#83b8ff", "#b09dff", "#52d3a1", "#ed7e8a", "#6cdbec"][(index - 1) % 5],
      disabled,
      points,
      byTime: new Map(points.map(point => [point.time, point.value])),
      warning: warnings.join(" "),
    }
  }

  function renderPeerLegend (state, lines, timestamp) {
    state.timestamp.textContent = `Закрытие: ${time(timestamp * 1_000)} UTC · изменение цены, % (не ATR)`
    state.legend.replaceChildren(...lines.map((line) => {
      const item = element("span")
      item.setAttribute("role", "listitem")
      item.dataset.disabled = String(line.disabled)
      const swatch = element("i", "peer-line-swatch")
      swatch.style.backgroundColor = line.color
      swatch.setAttribute("aria-hidden", "true")
      const value = line.byTime.get(timestamp)
      item.append(
        swatch,
        element("span", "", `${line.role} `),
        peerMarketLink(line.symbol, line.marketSymbol),
        element("strong", "", ` · ${line.disabled ? "Линия отключена: нет общей базы" : value == null ? "Нет закрытия" : `${number(value, 2, "exceptZero")}%`}`),
      )
      return item
    }))
  }

  function disposePeerCharts () {
    for (const state of peerCards) {
      state.chart?.remove()
      state.chart = null
    }
  }

  function renderPeerCharts () {
    if (byId("peer-radar").hidden || !peerCards.length) {
      return
    }
    disposePeerCharts()
    const to = Date.parse(report.peerRadar.data.snapshotClosedAt) / 1_000
    const from = to - peerDays * 86_400
    byId("peer-radar-range-note").textContent = `Общая база (0%): ${time(from * 1_000)} UTC → срез: ${time(to * 1_000)} UTC`
    for (const state of peerCards) {
      const lines = [state.observation.coin, ...state.observation.leaders].map((member, index) => peerLine(member, index, from, to))
      const warnings = lines.filter(line => line.warning).map(line => `${line.symbol}: ${line.warning}`)
      state.warning.textContent = warnings.join("\n")
      state.warning.hidden = !warnings.length
      state.container.hidden = lines.every(line => line.disabled)
      state.empty.hidden = !state.container.hidden
      state.empty.textContent = "Нет линий с ценой закрытия на общей базе. Факты и объяснение агента доступны ниже."
      renderPeerLegend(state, lines, to)
      if (state.container.hidden) {
        continue
      }
      try {
        state.chart = LightweightCharts.createChart(state.container, {
          autoSize: true,
          layout: {
            background: { type: LightweightCharts.ColorType.Solid, color: "#131d2a" },
            textColor: "#8f9daf", fontSize: 11, attributionLogo: true,
          },
          grid: { vertLines: { color: "#192332" }, horzLines: { color: "#25303f" } },
          rightPriceScale: { borderColor: "#25303f" },
          timeScale: { timeVisible: true, secondsVisible: false, borderColor: "#25303f", lockVisibleTimeRangeOnResize: true },
          localization: { locale: "ru-RU", timeFormatter: timestamp => `${time(timestamp * 1_000)} UTC · закрытие` },
        })
        for (const line of lines.filter(line => !line.disabled)) {
          // Whitespace alone does not stop LineSeries bridging a missing hour.
          for (const section of openInterestSections(line.points)) {
            const points = new Map(section.map(point => [point.time, point]))
            const series = state.chart.addSeries(LightweightCharts.LineSeries, {
              title: `${line.role} ${line.symbol}`,
              color: line.color,
              lineWidth: line.role === "Кандидат" ? 3 : 2,
              priceFormat: { type: "percent", precision: 2, minMove: 0.01 },
              priceLineVisible: false,
              lastValueVisible: section.at(-1).time === to,
              pointMarkersVisible: section.length === 1,
            })
            // Keep the complete hourly time axis, including missing end candles.
            series.setData(line.points.map(point => points.get(point.time) ?? { time: point.time }))
          }
        }
        state.chart.timeScale().setVisibleRange({ from, to })
        state.chart.subscribeCrosshairMove(event => renderPeerLegend(state, lines, isFinite(event.time) ? event.time : to))
      } catch (error) {
        state.chart?.remove()
        state.chart = null
        state.container.hidden = true
        state.empty.hidden = false
        state.empty.textContent = "График недоступен. Факты и объяснение агента доступны ниже."
        state.warning.hidden = false
        state.warning.textContent = [...warnings, `Не удалось построить график: ${error.message}`].join("\n")
      }
    }
  }

  function selectReportTab (tab) {
    const panel = byId(tab.dataset.reportTab)
    if (!panel.hidden) {
      return
    }
    document.querySelectorAll("[data-report-tab]").forEach((button) => {
      const active = button === tab
      button.setAttribute("aria-selected", String(active))
      button.tabIndex = active ? 0 : -1
      byId(button.dataset.reportTab).hidden = !active
    })
    byId("candle-time-note").hidden = !byId("peer-radar").hidden
    if (byId("peer-radar").hidden) {
      disposePeerCharts()
    } else {
      renderPeerCharts()
    }
  }

  function renderPeerRadar () {
    const radar = report.peerRadar
    const data = radar?.status === "available" ? radar.data : null
    byId("peer-radar").dataset.status = data ? "available" : "unavailable"
    byId("peer-radar-content").hidden = !data
    byId("peer-radar-warning").textContent = radar?.warning || (data ? "" : "Результат шага 12 не добавлен.")
    byId("peer-radar-warning").hidden = !byId("peer-radar-warning").textContent
    if (!data) {
      byId("peer-radar-status").textContent = "Радар недоступен"
      return
    }
    byId("peer-radar-status").textContent = data.observations.length
      ? "Наблюдения для ручной проверки"
      : data.analysisStatus === "skipped_no_candidates"
        ? "Наблюдений нет: скан шага 11 не нашёл кандидатов; анализ шага 12 пропущен."
        : "Анализ завершён: наблюдений нет."
    byId("peer-radar-counts").replaceChildren(...[
      ["Наблюдений", data.observationCount],
      ["Обратить внимание", data.watchCount],
      ["Ограниченная интерпретация", data.observationCount - data.watchCount],
    ].map(([label, count]) => element("span", "badge", `${label}: ${number(count, 0)}`)))
    byId("peer-radar-time").textContent = `Срез закрыт: ${publicationTime(data.snapshotClosedAt)} · Анализ выпущен: ${time(data.generatedAt, true)} UTC`
    byId("peer-radar-coverage").textContent = `Загружено ${number(data.loadedCoinCount, 0)} / ${number(data.universeCoinCount, 0)} монет · Частичное покрытие: ${number(data.coverage.partial, 0)} · Неизвестные связи: ${number(data.coverage.not_covered + data.coverage.unreviewed + data.coverage.unavailable, 0)} · Без соседей: ${number(data.coverage.no_peers, 0)} (не ошибка)`
    byId("peer-radar-coverage-counts").replaceChildren(...[
      ["available", "Полное покрытие"], ["partial", "Частичное покрытие"], ["no_peers", "Без соседей"],
      ["insufficient_data", "Недостаточно данных"], ["not_covered", "Вне справочника"],
      ["unreviewed", "Не проверено"], ["unavailable", "Справочник недоступен"],
    ].map(([key, label]) => element("span", "badge", `${label}: ${number(data.coverage[key], 0)}`)))
    byId("peer-radar-provenance").textContent = `Метка свечи asOf (открытие): ${publicationTime(data.asOf)} · Таймфрейм: ${data.timeframe} · Скан шага 11 выпущен: ${publicationTime(data.scanGeneratedAt)} · Справочник: ${data.registryGeneratedAt == null ? "время выпуска не указано" : publicationTime(data.registryGeneratedAt)}`
    byId("peer-radar-analysis").textContent = `Кандидатов скана: ${number(data.candidateCount, 0)} · Источник анализа: ${data.analysis.source ?? "—"} · Модель: ${data.analysis.model ?? "—"} · Усилие рассуждения: ${data.analysis.reasoningEffort ?? "—"} · Вызовов: ${number(data.analysis.callCount, 0)}`
    byId("peer-radar-criteria").replaceChildren(...[
      ["impulse", "Импульс"], ["lag", "Отставание"], ["reaction", "Реакция"],
    ].map(([key, label]) => {
      const item = element("div")
      item.append(element("dt", "", label), element("dd", "peer-radar-text", data.criteria[key]))
      return item
    }))
    byId("peer-radar-toolbar").hidden = !data.observations.length
    const observations = [...data.observations].sort((first, second) => Number(second.verdict === "watch") - Number(first.verdict === "watch"))
    byId("peer-radar-observations").replaceChildren(...observations.map(observation => peerObservation(observation, data.snapshotClosedAt)))
  }

  function newsItem (item) {
    const article = element("article", "source-item")
    const heading = element("h3", "source-title")
    heading.append(sourceLink(item.title || "Новость без заголовка", item.externalUrl || item.tradingViewUrl))
    article.append(heading, element("p", "source-meta", `${item.provider?.name ?? "Источник не указан"} · ${publicationTime(item.publishedAt ?? (item.published == null ? null : item.published * 1_000))}`))
    if (item.shortDescription) {
      article.append(element("p", "source-text", item.shortDescription))
    }
    if (item.content) {
      const content = element("details", "article-content")
      content.append(element("summary", "", "Сохранённый текст новости"), element("p", "source-text", item.content))
      article.append(content)
    } else {
      article.append(element("p", "source-meta", item.paywall ? "Полный текст недоступен: ограниченный доступ." : "Полный текст не получен."))
    }
    if (item.tradingViewUrl) {
      const footer = element("div", "source-footer")
      footer.append(sourceLink("Новость в TradingView ↗", item.tradingViewUrl))
      article.append(footer)
    }
    return article
  }

  function tweetItem (tweet) {
    const article = element("article", "source-item")
    const heading = element("h3", "source-title", tweet.authorUsername ? `@${tweet.authorUsername}` : "Автор не указан")
    article.append(heading, element("p", "source-meta", publicationTime(tweet.createdAt)), element("p", "source-text", tweet.text))
    const footer = element("div", "source-footer")
    footer.append(...[
      ["Лайки", tweet.likeCount],
      ["Репосты", tweet.retweetCount],
      ["Просмотры", tweet.viewCount],
      ["Подписчики", tweet.authorFollowers],
    ].map(([label, value]) => element("span", "", `${label}: ${number(value, 0)}`)))
    if (/^\d+$/.test(tweet.id ?? "")) {
      footer.append(sourceLink("Открыть в X ↗", `https://x.com/i/status/${tweet.id}`))
    }
    article.append(footer)
    return article
  }

  function renderSource (key, source, items, renderItem) {
    const window = report.informationSources[key]
    byId(`${key}-window`).textContent = `Окно публикаций: ${time(window.from)} — ${time(window.asOf)} UTC.`
    byId(`${key}-count`).textContent = source.status === "failed" ? "ошибка" : String(items.length)
    const status = byId(`${key}-status`)
    status.hidden = source.status !== "failed" && items.length > 0
    status.className = source.status === "failed" ? "source-status failed" : "source-status"
    status.textContent = source.status === "failed"
      ? `Ошибка загрузки: ${source.error || "источник недоступен"}`
      : "За сохранённое окно публикаций ничего не найдено."
    byId(`${key}-items`).replaceChildren(...items.map(renderItem))
  }

  function renderInformation (coin) {
    for (const key of ["news", "twitter"]) {
      byId(`${key}-details`).open = false
      byId(`${key}-items`).replaceChildren()
      byId(`${key}-count`).textContent = ""
      byId(`${key}-window`).textContent = ""
      byId(`${key}-status`).textContent = ""
      byId(`${key}-status`).hidden = true
    }
    byId("context-generated").textContent = ""
    byId("information-panel").hidden = coin.topRank == null || !coin.information
    byId("analysis-source").textContent = byId("information-panel").hidden ? "Анализ шага 7" : "Объяснение дополнено на шаге 10"
    if (byId("information-panel").hidden) {
      return
    }
    byId("context-generated").textContent = `Объяснение дополнено ${time(report.informationSources.contextGeneratedAt)} UTC. Вероятности и аргументы шага 7 не пересчитывались.`
    renderSource("news", coin.information.news, coin.information.news.items, newsItem)
    renderSource("twitter", coin.information.twitter, coin.information.twitter.tweets, tweetItem)
  }

  function renderCoinGecko (coin) {
    const trending = coin.features.coingeckoTrending === true
    const categories = trending ? coin.features.coingeckoTrendingCategories : null
    const status = !trending
      ? ""
      : categories == null
        ? "Нет данных о категориях"
        : categories.length ? "" : "Нет пересечений с трендовыми категориями"

    byId("coingecko-badge").hidden = !trending
    byId("coingecko-badge").replaceChildren(...(trending ? [createCoinGeckoBadge()] : []))
    byId("coingecko-context").hidden = !trending
    byId("coingecko-categories").replaceChildren(...(categories ?? []).map(category => (
      element("span", "badge", category)
    )))
    byId("coingecko-category-status").textContent = status
    byId("coingecko-category-status").hidden = !status
  }

  function renderSustainedStrength (coin) {
    const status = ["persistent", "emerging", "fading", "neutral"].includes(coin.features.sustainedStatus)
      ? coin.features.sustainedStatus
      : "insufficient_data"

    byId("sustained-strength").dataset.status = status
    byId("sustained-strength-status").textContent = {
      persistent: "Устойчиво сильная",
      emerging: "Сила появляется",
      fading: "Сила ослабевает",
      neutral: "Не выделяется",
      insufficient_data: "Недостаточно данных",
    }[status]
    byId("sustained-strength-status").title = report.definitions?.sustainedStatus ?? ""

    for (const [id, field] of [
      ["sustained-strength-history", "sustainedHistoryScore"],
      ["sustained-strength-current", "sustainedCurrentScore"],
    ]) {
      const value = coin.features[field]
      byId(id).textContent = value == null ? "Нет данных" : `${number(value, 1)} / 100`
      byId(id).title = report.definitions?.[field] ?? ""
    }
  }

  function renderFeatures (coin) {
    byId("feature-highlights").replaceChildren(...[
      ["rvRatio", "Сжатие волатильности", "×"],
      ["relVolume", "Объём к норме", "×"],
      ["oiChange4hPct", "Open Interest · 4h", "%"],
      ["socialAccel3hPct", "Внимание · 3h", "%"],
      ["btcCorr24h", "Корреляция с BTC", ""],
      ["breakoutAgeHours", "Возраст пробоя", " ч"],
    ].map(([key, label, suffix]) => {
      const card = element("div", "feature-card")
      const value = coin.features[key]
      card.title = report.definitions?.[key] ?? ""
      card.append(
        element("span", "metric-label", label),
        element("strong", "metric-value", value == null ? (key === "breakoutAgeHours" ? "Не найден" : "Нет данных") : `${number(value, 3)}${suffix}`),
      )
      return card
    }))

    byId("flags").replaceChildren(...(coin.features.flags ?? []).map((flag) => {
      const badge = element("span", "badge", flagLabel(flag))
      badge.title = report.flagDefinitions?.[flag] ?? ""
      return badge
    }))
    byId("feature-rows").replaceChildren(...Object.entries(coin.features).map(([key, value]) => {
      const row = element("tr")
      row.append(element("td", "", key), element("td", "", featureValue(key, value)), element("td", "", report.definitions?.[key] ?? ""))
      return row
    }))
  }

  function chartHistory (coin) {
    return chartStates.get(coin.symbol).data?.history ?? coin.history
  }

  function historyEnd (history) {
    return Math.max(Date.parse(report.asOf) / 1_000, ...[
      history.candles, history.volume, history.openInterest,
    ].map(series => series.at(-1)?.time ?? 0))
  }

  function hourlyGrid (series, to) {
    const from = Date.parse(report.asOf) / 1_000 - 167 * 3_600
    const byTime = new Map(series.map(point => [point.time, point]))
    return Array.from({ length: (to - from) / 3_600 + 1 }, (_, index) => {
      const timestamp = from + index * 3_600
      return byTime.get(timestamp) ?? { time: timestamp }
    })
  }

  function reportMarkerTime (history) {
    const hour = Date.parse(report.asOf) / 1_000
    // Never let the library snap a marker across a missing candle to the wrong hour.
    return history.candles.some(candle => candle.time === hour) ? hour : null
  }

  function renderUpdateState (coin) {
    const state = chartStates.get(coin.symbol)
    const button = byId("update-chart")
    button.disabled = state.pending
    button.textContent = state.pending ? "Обновление…" : "Update chart"
    button.setAttribute("aria-busy", String(state.pending))
    byId("chart-update-error").textContent = state.error ?? ""
    byId("chart-update-error").hidden = !state.error
    byId("chart-update-status").textContent = state.pending
      ? "Загружаем свечи, объём и OI выбранной монеты с Binance…"
      : state.data
        ? `Обновлено ${time(state.data.updatedAt, true)} UTC. ${state.data.formingTime == null ? "Текущая свеча недоступна." : "Последняя свеча и её объём ещё формируются."} ${state.data.currentOiAt ? `Текущий OI: снимок ${time(state.data.currentOiAt, true)} UTC, не закрытие часа.` : "Текущий OI недоступен."}`
        : "Сохранённый срез. Обновление — только по кнопке, без пересчёта анализа."
    byId("chart-source").textContent = state.data
      ? `Свечи и объём: TradingView → Binance с ${time(state.data.sourceFrom * 1_000)} UTC. ${state.data.oiSourceFrom == null ? "Продолжение OI пока недоступно." : `OI: TradingView → Binance с ${time(state.data.oiSourceFrom * 1_000)} UTC.`} OI в базовом активе; небольшие различия источников возможны.`
      : "Источник графика: сохранённые данные TradingView."
    byId("report-time-note").textContent = [
      `Срез отчёта: ${time(report.asOf)} UTC — время открытия последней закрытой свечи.`,
      reportMarkerTime(chartHistory(coin)) == null
        ? "Свеча среза недоступна — отметка не подменяется другим временем."
        : "Отметка «Отчёт» при обновлении привязана к этой свече, а не ко времени создания HTML.",
    ].join(" ")
  }

  async function refreshSelectedChart () {
    const coin = coinsBySymbol.get(selectedSymbol)
    if (!coin) {
      return
    }
    const state = chartStates.get(coin.symbol)
    if (state.pending) {
      return
    }
    state.pending = true
    state.requested = true
    state.error = null
    renderUpdateState(coin)
    try {
      state.data = await updateChartHistory(coin, report.asOf, state.data)
      if (selectedSymbol === coin.symbol) {
        renderChart(coin)
      }
    } catch (error) {
      state.error = `${error.message}. График не изменён; можно повторить обновление.`
    } finally {
      state.pending = false
      if (selectedSymbol === coin.symbol) {
        renderUpdateState(coin)
      }
    }
  }

  function applyRange () {
    if (chart) {
      const to = historyEnd(chartHistory(coinsBySymbol.get(selectedSymbol)))
      chart.timeScale().setVisibleRange({ from: to - (selectedDays * 24 - 1) * 3_600, to })
    }
    document.querySelectorAll("[data-days]").forEach((button) => {
      button.setAttribute("aria-pressed", String(Number(button.dataset.days) === selectedDays))
    })
  }

  function renderLegend (timestamp, candle, volume, openInterest, precision) {
    byId("chart-legend").replaceChildren(...[
      ["", `${time(timestamp * 1_000)} UTC`],
      ["O", number(candle?.open, precision)],
      ["H", number(candle?.high, precision)],
      ["L", number(candle?.low, precision)],
      ["C", number(candle?.close, precision)],
      ["Объём", number(volume?.value, 0)],
      ["OI", number(openInterest?.value, 0)],
    ].map(([label, value]) => {
      const item = element("span", "", label ? `${label} ` : "")
      item.append(element("strong", "", value))
      return item
    }))
  }

  function openInterestSections (points) {
    const sections = []
    for (const point of points) {
      if (point.value == null) {
        continue
      }
      const previous = sections.at(-1)
      if (previous?.at(-1).time === point.time - 3_600) {
        previous.push(point)
      } else {
        sections.push([point])
      }
    }
    return sections.length ? sections : [[]]
  }

  function renderChart (coin) {
    chart?.remove()
    chart = null
    const history = chartHistory(coin)
    const state = chartStates.get(coin.symbol)
    const lastCandle = history.candles.at(-1)
    byId("history-warning").textContent = history.warning ?? ""
    byId("history-warning").hidden = !history.warning
    byId("chart").hidden = !lastCandle
    byId("chart-empty").hidden = Boolean(lastCandle)
    byId("chart-legend").replaceChildren()
    byId("last-price").textContent = "—"
    byId("last-price-label").textContent = state.data?.formingTime != null
      ? "USDT · незакрытая свеча"
      : "USDT · последняя закрытая свеча"
    renderUpdateState(coin)
    if (!lastCandle) {
      return
    }

    const precision = Math.max(2, 4 - Math.floor(Math.log10(Math.min(...history.candles.map(candle => candle.low)))))
    byId("last-price").textContent = number(lastCandle.close, precision)
    const volumeByTime = new Map(history.volume.map(point => [point.time, point]))
    const oiByTime = new Map(history.openInterest.map(point => [point.time, point]))
    const showLatest = () => renderLegend(lastCandle.time, lastCandle, volumeByTime.get(lastCandle.time), oiByTime.get(lastCandle.time), precision)
    showLatest()

    try {
      chart = LightweightCharts.createChart(byId("chart"), {
        autoSize: true,
        layout: {
          background: { type: LightweightCharts.ColorType.Solid, color: "#101722" },
          textColor: "#8f9daf",
          fontSize: 11,
          attributionLogo: true,
          panes: { separatorColor: "#25303f", separatorHoverColor: "#49627f", enableResize: true },
        },
        grid: { vertLines: { color: "#192332" }, horzLines: { color: "#192332" } },
        crosshair: {
          mode: LightweightCharts.CrosshairMode.Normal,
          vertLine: { color: "#7288a4", labelBackgroundColor: "#2a405e" },
          horzLine: { color: "#7288a4", labelBackgroundColor: "#2a405e" },
        },
        rightPriceScale: { borderColor: "#25303f", minimumWidth: 78, scaleMargins: { top: 0.12, bottom: 0.12 } },
        timeScale: { timeVisible: true, secondsVisible: false, borderColor: "#25303f", lockVisibleTimeRangeOnResize: true },
        localization: { locale: "ru-RU", timeFormatter: timestamp => `${time(timestamp * 1_000)} UTC` },
      })
      const candles = chart.addSeries(LightweightCharts.CandlestickSeries, {
        upColor: "#52d3a1",
        downColor: "#ed7e8a",
        wickUpColor: "#52d3a1",
        wickDownColor: "#ed7e8a",
        borderVisible: false,
        priceFormat: precision > 16
          ? { type: "custom", minMove: 10 ** -precision, formatter: value => number(value, precision) }
          : { type: "price", precision, minMove: 10 ** -precision },
      }, 0)
      const volume = chart.addSeries(LightweightCharts.HistogramSeries, {
        title: "Объём",
        priceFormat: { type: "volume" },
        priceLineVisible: false,
        lastValueVisible: false,
      }, 1)
      // Lightweight Charts connects LineSeries across whitespace, so split actual gaps.
      for (const section of openInterestSections(history.openInterest)) {
        const series = chart.addSeries(LightweightCharts.LineSeries, {
          title: "OI",
          color: "#b09dff",
          lineWidth: 2,
          priceLineVisible: false,
          lastValueVisible: section.at(-1)?.time === lastCandle.time,
          pointMarkersVisible: section.length === 1,
          priceFormat: { type: "volume" },
        }, 2)
        series.setData(section)
      }
      const to = historyEnd(history)
      candles.setData(hourlyGrid(history.candles, to))
      const markerTime = reportMarkerTime(history)
      if (state.requested && markerTime != null) {
        LightweightCharts.createSeriesMarkers(candles, [{
          time: markerTime, position: "aboveBar", shape: "arrowDown", color: "#f2c56d", text: "Отчёт",
        }])
      }
      const candlesByTime = new Map(history.candles.map(candle => [candle.time, candle]))
      volume.setData(hourlyGrid(history.volume, to).map((point) => {
        const candle = candlesByTime.get(point.time)
        return point.value == null || !candle ? { time: point.time } : { ...point, color: candle.close >= candle.open ? "#368b70" : "#9a5362" }
      }))
      volume.priceScale().applyOptions({ scaleMargins: { top: 0.2, bottom: 0 } })
      chart.panes().forEach((pane, index) => pane.setStretchFactor([0.64, 0.16, 0.2][index]))
      chart.subscribeCrosshairMove((event) => {
        if (event.time == null) {
          showLatest()
        } else {
          renderLegend(event.time, event.seriesData.get(candles), event.seriesData.get(volume), oiByTime.get(event.time), precision)
        }
      })
      applyRange()
    } catch (error) {
      chart?.remove()
      chart = null
      byId("chart").hidden = true
      byId("chart-empty").hidden = false
      byId("history-warning").hidden = false
      byId("history-warning").textContent = [history.warning, `Не удалось построить график: ${error.message}`].filter(Boolean).join(". ")
    }
  }

  function selectCoin (symbol) {
    const coin = coinsBySymbol.get(symbol)
    if (!coin) {
      return
    }
    selectedSymbol = symbol
    byId("coin-detail").hidden = false
    byId("coin-symbol").textContent = coin.symbol
    byId("coin-name").textContent = `${coin.name} · ${coin.marketSymbol}`
    byId("coin-description").replaceChildren(coinDescription(coin))
    byId("top-rank").textContent = `ТОП ${coin.topRank}`
    byId("top-rank").hidden = coin.topRank == null
    byId("coin-badges").replaceChildren(
      element("span", "badge", `P движения ${probability(coin.movementProbability)}`),
      element("span", "badge neutral", `Уверенность: ${confidence(coin.estimateConfidence)}`),
    )
    if (coin.features.socialStatus === "unavailable") {
      byId("coin-badges").append(element("span", "badge neutral", "Social: нет данных"))
    }
    const tradingViewUrl = new URL("https://www.tradingview.com/chart/")
    tradingViewUrl.searchParams.set("symbol", coin.marketSymbol)
    byId("tradingview-link").href = tradingViewUrl.href
    byId("explanation").textContent = coin.explanation
    byId("explanation").hidden = !coin.explanation
    renderSignals("drivers", coin.drivers)
    renderSignals("counter-signals", coin.counterSignals)
    renderInformation(coin)
    renderCoinGecko(coin)
    renderSustainedStrength(coin)
    renderFeatures(coin)
    renderChart(coin)
    renderCandidates()
    document.querySelectorAll(".top-card").forEach((button) => {
      button.setAttribute("aria-pressed", String(button.dataset.symbol === selectedSymbol))
    })
  }

  function handleCoinClick (event) {
    const target = event.target.closest("[data-symbol]")
    if (target) {
      selectCoin(target.dataset.symbol)
    }
  }

  document.querySelectorAll("[data-report-tab]").forEach((tab, index, tabs) => {
    tab.addEventListener("click", () => selectReportTab(tab))
    tab.addEventListener("keydown", (event) => {
      const next = { ArrowRight: (index + 1) % tabs.length, ArrowLeft: (index + tabs.length - 1) % tabs.length, Home: 0, End: tabs.length - 1 }[event.key]
      if (next != null) {
        event.preventDefault()
        tabs[next].focus()
        selectReportTab(tabs[next])
      }
    })
  })
  document.querySelectorAll("[data-peer-days]").forEach((button) => {
    button.addEventListener("click", () => {
      const days = Number(button.dataset.peerDays)
      if (peerDays === days) {
        return
      }
      peerDays = days
      document.querySelectorAll("[data-peer-days]").forEach(item => item.setAttribute("aria-pressed", String(Number(item.dataset.peerDays) === peerDays)))
      renderPeerCharts()
    })
  })
  byId("top-candidates").addEventListener("click", handleCoinClick)
  byId("candidate-rows").addEventListener("click", handleCoinClick)
  byId("search").addEventListener("input", renderCandidates)
  byId("sort").addEventListener("change", renderCandidates)
  byId("update-chart").addEventListener("click", refreshSelectedChart)
  document.querySelectorAll("[data-days]").forEach((button) => {
    button.addEventListener("click", () => {
      selectedDays = Number(button.dataset.days)
      applyRange()
    })
  })
  renderSummary()
  renderPeerRadar()
  renderTopCandidates()
  renderCandidates()
  byId("no-candidates").hidden = Boolean(selectedSymbol)
  if (selectedSymbol) {
    selectCoin(selectedSymbol)
  }
})()
