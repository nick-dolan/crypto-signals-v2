/* global document, LightweightCharts */

(() => {
  const report = JSON.parse(document.getElementById("report-data").textContent)
  const coinsBySymbol = new Map(report.coins.map(coin => [coin.symbol, coin]))
  const topCandidates = report.coins.filter(coin => coin.topRank != null)
    .sort((first, second) => first.topRank - second.topRank)
  let selectedSymbol = topCandidates[0]?.symbol ?? report.coins[0]?.symbol ?? null
  let selectedDays = 3
  let chart = null

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

  function time (timestamp) {
    return new Intl.DateTimeFormat("ru-RU", {
      timeZone: "UTC",
      year: "numeric",
      month: "short",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(timestamp))
  }

  function direction (value) {
    return {
      up: { label: "↑ Уклон вверх", short: "↑ Вверх", className: "positive" },
      down: { label: "↓ Уклон вниз", short: "↓ Вниз", className: "negative" },
      unclear: { label: "↔ Направление неясно", short: "↔ Неясно", className: "neutral" },
    }[value] ?? { label: "Нет оценки направления", short: "—", className: "neutral" }
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
      fresh_quiet_breakout: "Свежий пробой тихой базы",
      late_pump: "Поздний памп",
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
        return key === "flags" ? value.map(flagLabel).join(", ") || "Нет активных" : String(value)
    }
  }

  function renderSummary () {
    byId("as-of").dateTime = report.asOf
    byId("as-of").textContent = time(report.asOf)
    byId("coverage").textContent = `${report.candidateCount} оценено / ${report.universeCoinCount} монет во вселенной`
    byId("candidate-count").textContent = report.candidateCount
    byId("objective").textContent = `Цель анализа: ${report.objective}`
    byId("candle-time-note").textContent = `Время на графике — UTC, по открытию свечи. Последняя свеча среза закрыта ${time(Date.parse(report.asOf) + 3_600_000)} UTC.`

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

  function renderTopCandidates () {
    byId("top-candidates").replaceChildren(...topCandidates.map((coin) => {
      const bias = direction(coin.directionBias)
      const card = element("button", "top-card")
      card.type = "button"
      card.dataset.symbol = coin.symbol
      card.setAttribute("aria-pressed", String(coin.symbol === selectedSymbol))
      const heading = element("span", "top-card-heading")
      heading.append(element("span", "top-card-rank", `0${coin.topRank}`), element("span", "top-card-symbol", coin.symbol))
      const estimate = element("span", "top-card-probability")
      estimate.append(element("strong", "", probability(coin.movementProbability)), element("span", "muted", "P движения"))
      const track = element("span", "probability-track")
      const fill = element("span", "probability-fill")
      fill.style.width = `${coin.movementProbability * 100}%`
      track.setAttribute("aria-hidden", "true")
      track.append(fill)
      const footer = element("span", "top-card-footer")
      footer.append(element("span", bias.className, bias.short), element("span", "muted", `Уверенность: ${confidence(coin.estimateConfidence)}`))
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
        if (sort === "symbol") {
          return first.symbol.localeCompare(second.symbol)
        }
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
      button.append(element("small", "", coin.name))
      cell.append(button)
      const bias = direction(coin.directionBias)
      row.append(cell, element("td", "", probability(coin.movementProbability)), element("td", bias.className, bias.short))
      return row
    }))

    if (!coins.length) {
      const row = element("tr")
      const cell = element("td", "empty-state", "Ничего не найдено")
      cell.colSpan = 3
      row.append(cell)
      byId("candidate-rows").append(row)
    }
    byId("search-results").textContent = `Показано ${coins.length} из ${report.candidateCount}`
  }

  function renderSignals (id, signals) {
    byId(id).replaceChildren(...(signals ?? []).map((signal) => {
      const item = element("li")
      const separator = signal.indexOf(": ")
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

  function hourlyGrid (series) {
    const byTime = new Map(series.map(point => [point.time, point]))
    return Array.from({ length: 168 }, (_, index) => {
      const timestamp = Date.parse(report.asOf) / 1_000 - (167 - index) * 3_600
      return byTime.get(timestamp) ?? { time: timestamp }
    })
  }

  function applyRange () {
    if (chart) {
      const to = Date.parse(report.asOf) / 1_000
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
    const { history } = coin
    const lastCandle = history.candles.at(-1)
    byId("history-warning").textContent = history.warning ?? ""
    byId("history-warning").hidden = !history.warning
    byId("chart").hidden = !lastCandle
    byId("chart-empty").hidden = Boolean(lastCandle)
    byId("chart-legend").replaceChildren()
    byId("last-price").textContent = "—"
    if (!lastCandle) {
      return
    }

    const precision = Math.max(2, 4 - Math.floor(Math.log10(Math.min(...history.candles.map(candle => candle.low)))))
    byId("last-price").textContent = number(lastCandle.close, precision)
    const showLatest = () => renderLegend(lastCandle.time, lastCandle, history.volume.at(-1), history.openInterest.at(-1), precision)
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
      candles.setData(hourlyGrid(history.candles))
      const candlesByTime = new Map(history.candles.map(candle => [candle.time, candle]))
      volume.setData(hourlyGrid(history.volume).map((point) => {
        const candle = candlesByTime.get(point.time)
        return point.value == null ? point : { ...point, color: candle.close >= candle.open ? "#368b70" : "#9a5362" }
      }))
      const oiByTime = new Map(history.openInterest.map(point => [point.time, point]))
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
    byId("top-rank").textContent = `ТОП ${coin.topRank}`
    byId("top-rank").hidden = coin.topRank == null
    const bias = direction(coin.directionBias)
    byId("coin-badges").replaceChildren(
      element("span", "badge", `P движения ${probability(coin.movementProbability)}`),
      element("span", `badge ${bias.className}`, bias.label),
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

  byId("top-candidates").addEventListener("click", handleCoinClick)
  byId("candidate-rows").addEventListener("click", handleCoinClick)
  byId("search").addEventListener("input", renderCandidates)
  byId("sort").addEventListener("change", renderCandidates)
  document.querySelectorAll("[data-days]").forEach((button) => {
    button.addEventListener("click", () => {
      selectedDays = Number(button.dataset.days)
      applyRange()
    })
  })
  renderSummary()
  renderTopCandidates()
  renderCandidates()
  byId("no-candidates").hidden = Boolean(selectedSymbol)
  if (selectedSymbol) {
    selectCoin(selectedSymbol)
  }
})()
