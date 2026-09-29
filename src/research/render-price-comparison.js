import { isFinite } from "../helpers/utils.typed.js"
import { readWebAsset } from "../web/read-web-asset.js"

function escapeHtml (value) {
  return String(value ?? "—").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" })[char])
}

function escapeMarkdown (value) {
  return escapeHtml(value).replace(/[\\|`*_[\]]/g, "\\$&").replace(/[\r\n\u2028\u2029]+/g, " ")
}

function number (value, digits = 2) {
  return isFinite(value) ? value.toLocaleString("ru-RU", { maximumFractionDigits: digits }) : "—"
}

function utc (value) {
  return value == null ? "—" : new Date(isFinite(value) ? value * 1000 : value).toISOString().slice(0, 16).replace("T", " ")
}

function windows (report) {
  return [...new Set([7, 30, report.analysisDays])]
}

function shortlist (report) {
  return [...new Set([...report.closest, ...report.calmer])]
    .filter(id => id !== report.reference.baseCurrencyId)
    .map(id => report.candidates.find(entry => entry.baseCurrencyId === id)).filter(Boolean)
}

function introduction (report) {
  return [
    `Эталон: ${report.reference.symbol} · ${report.reference.marketSymbol}. Свечи ${report.timeframe}, ${number(report.analysisDays, 0)} полных дней. Период UTC: [${utc(report.startTime)} → ${utc(report.endTime)}), конец не включён.`,
    `Отчёт: ${utc(report.generatedAt)} UTC; список монет: ${utc(report.universeGeneratedAt)} UTC.`,
    `Монет в выборке: ${number(report.coverage.total, 0)}; загружено: ${number(report.coverage.loaded, 0)}; допущено: ${number(report.coverage.eligible, 0)}; отказов: ${number(report.coverage.failed, 0)}; ожидают: ${number(report.coverage.pending, 0)}.`,
    report.pending.length
      ? "Предварительный результат: есть ожидающие монеты; подборки могут измениться."
      : report.rejected.length ? "Сравнение не охватывает монеты с отказами загрузки; причины приведены ниже." : "Ожидающих монет и отказов загрузки нет.",
    ...report.warnings.map(text => `Предупреждение: ${text}`),
  ]
}

function methodology (report) {
  return [
    "Distance — расстояние 0–100: меньше означает ближе к эталону по выбранным признакам. Это не процент сходства, не вероятность и не прогноз. Подборка «меньше выбросов» — результат исследовательских условий, не обещание будущего поведения.",
    `В ячейках по окнам порядок: ${windows(report).join(" / ")} дней, все окна заканчиваются одновременно. Прочерк — нет данных, 0 — нулевое значение. Проценты уже выражены в процентах.`,
    "TR% — True Range / previousClose × 100, включая разрывы цены. Хвост TR — p99 / медиана. Топ-1% — доля суммарного abs logreturn на крупнейших свечах. Efficiency 4ч / 12ч — направленность 0–1, не предсказуемость.",
    "Недельная устойчивость: P90 частоты вспышек (%) и вариация TR по неделям. Отношения амплитуды и оборота за 30 дней даны к эталону: 1 — одинаковое значение. Оборот — приближение volume × HLC3, не ликвидность стакана.",
    ...report.methodology,
  ]
}

function metricsRow (entry, report) {
  const at = days => entry.profile.windows.find(window => window.days === days)
  const byWindow = key => windows(report).map(days => number(at(days)?.[key])).join(" / ")
  return [
    `${entry.symbol}${entry.baseCurrencyId === report.reference.baseCurrencyId ? " — эталон" : ""}`,
    number(entry.distance), windows(report).map(days => number(entry.distanceByWindow?.[days])).join(" / "),
    byWindow("spikeRatePct"), byWindow("medianRangePct"), number(at(30)?.rangeTailRatio), number(at(30)?.top1PctMovementSharePct),
    number(at(30)?.longWickRatePct), `${number(at(30)?.efficiency4hMedian, 3)} / ${number(at(30)?.efficiency12hMedian, 3)}`,
    `${number(entry.weeklySpikeP90Pct)} / ${number(entry.weeklyRangeVariation)}`,
    `${number(entry.amplitudeRatio30d)} / ${number(entry.turnoverRatio30d)}`,
  ]
}

function tables (report) {
  const order = windows(report).join(" / ")
  const headers = [
    "Монета", "Distance", `Distance · ${order}д`, `Вспышки, % · ${order}д`, `Медиана TR, % · ${order}д`,
    "Хвост TR, 30д", "Топ-1%, 30д, %", "Частота длинных теней, 30д, %", "Eff. 4ч / 12ч, 30д",
    "Недели: P90 вспышек, % / вариация TR", "30д: амплитуда / оборот к эталону",
  ]
  return [
    ...[["Ближе по характеру · до 10", report.closest], ["Меньше выбросов · до 5", report.calmer]].map(([title, ids]) => {
      const entries = ids.map(id => report.candidates.find(entry => entry.baseCurrencyId === id)).filter(Boolean)
      return { title, headers, rows: [report.reference, ...entries].map(entry => metricsRow(entry, report)), note: entries.length ? "" : "Подборка пуста: ниже только эталон, среди обработанных монет подходящие кандидаты не найдены." }
    }),
    {
      title: "Редкие сильные свечи",
      note: "Меньше относительных выбросов не исключает редкие сильные свечи. TR — диапазон с разрывами цены, не доходность между закрытиями (close-to-close). p99 не отражает максимум.",
      headers: ["Монета", "Максимум TR, 30д, %", `Максимум TR, ${number(report.analysisDays, 0)}д (весь период), %`, "Доля свечей с TR > 3%, 30д, %"],
      rows: [report.reference, ...shortlist(report)].map((entry) => {
        const month = entry.profile.windows.find(window => window.days === 30)
        const full = entry.profile.windows.find(window => window.days === report.analysisDays)
        return [
          `${entry.symbol}${entry.baseCurrencyId === report.reference.baseCurrencyId ? " — эталон" : ""}`,
          number(month?.maxRangePct), number(full?.maxRangePct), number(month?.rangeOver3PctRatePct),
        ]
      }),
    },
    {
      title: "Все результаты", collapsed: true,
      headers: ["Монета", "Рынок", "Статус", "Distance", "P90 вспышек по неделям, %", "Причины исключения"],
      rows: report.candidates.map(entry => [
        `${entry.symbol} · ${entry.name}`, entry.marketSymbol, entry.eligible ? "Допущена" : "Исключена", number(entry.distance),
        number(entry.weeklySpikeP90Pct), entry.exclusions.join("; ") || "—",
      ]),
    },
    {
      title: "Отказы загрузки", collapsed: true, headers: ["Монета", "Рынок", "Причина"],
      rows: report.rejected.map(({ coin, reason }) => [`${coin.symbol} · ${coin.name}`, coin.marketSymbol, reason]),
    },
    {
      title: "Ожидают обработки · pending", collapsed: true, headers: ["Монета", "Рынок", "Состояние"],
      rows: report.pending.map(coin => [`${coin.symbol} · ${coin.name}`, coin.marketSymbol, "Ожидает обработки; не оценена"]),
    },
  ]
}

export function renderPriceComparisonMarkdown (report) {
  const row = cells => `| ${cells.map(escapeMarkdown).join(" | ")} |`
  return [
    `# Сравнение характера цены · ${escapeMarkdown(report.reference.symbol)} · ${escapeMarkdown(report.timeframe)}`,
    ...introduction(report).map(escapeMarkdown),
    ...tables(report).map(table => [
      `## ${table.title}`, table.note,
      table.rows.length ? [row(table.headers), row(table.headers.map(() => "---")), ...table.rows.map(row)].join("\n") : "Нет записей.",
    ].filter(Boolean).join("\n\n")),
    `## Методика и ограничения\n\n${methodology(report).map(text => `- ${escapeMarkdown(text)}`).join("\n")}`,
  ].join("\n\n") + "\n"
}

function htmlTable (table) {
  const content = `${table.note ? `<p>${escapeHtml(table.note)}</p>` : ""}${table.rows.length
    ? `<div class="table-scroll"><table><thead><tr>${table.headers.map(text => `<th scope="col">${escapeHtml(text)}</th>`).join("")}</tr></thead><tbody>${table.rows.map(row => `<tr>${row.map(text => `<td>${escapeHtml(text)}</td>`).join("")}</tr>`).join("\n")}</tbody></table></div>`
    : "<p>Нет записей.</p>"}`
  return table.collapsed
    ? `<details><summary>${escapeHtml(table.title)} · ${table.rows.length}</summary>${content}</details>`
    : `<section><h2>${escapeHtml(table.title)}</h2>${content}</section>`
}

function mountComparison ({ document, LightweightCharts }, { report, charts }, isFinite) {
  const select = document.getElementById("candidate")
  const buttons = [...document.querySelectorAll("[data-days]")]
  let days = 7
  let syncing = false
  let priceRange = { minValue: -1, maxValue: 1 }
  const panels = ["reference-chart", "candidate-chart"].map((id) => {
    const element = document.getElementById(id)
    const chart = LightweightCharts.createChart(element, {
      autoSize: true,
      layout: { attributionLogo: true, background: { color: "#ffffff" }, textColor: "#243044" },
      rightPriceScale: { mode: 0, autoScale: true, scaleMargins: { top: 0.05, bottom: 0.05 }, minimumWidth: 80 },
      timeScale: { timeVisible: true, secondsVisible: false, rightOffset: 0 },
      handleScale: { axisPressedMouseMove: { time: true, price: false }, axisDoubleClickReset: { time: true, price: false } },
      localization: { locale: "ru-RU", timeFormatter: time => new Date(time * 1000).toISOString().slice(0, 16).replace("T", " ") + " UTC" },
    })
    const series = chart.addSeries(LightweightCharts.CandlestickSeries, {
      upColor: "#15803d", downColor: "#dc2626", wickUpColor: "#15803d", wickDownColor: "#dc2626", borderVisible: false,
      priceFormat: { type: "custom", minMove: 0.01, formatter: value => value.toFixed(2).replace(".", ",") + "%" },
      autoscaleInfoProvider: () => ({ priceRange }),
    })
    return { element, chart, series, data: [] }
  })

  function normalized (source) {
    if (!source) {
      return []
    }
    const start = report.endTime - days * 86400
    const index = source.candles.findIndex(candle => candle.time >= start)
    const base = index === 0 ? source.previousClose : source.candles[index - 1]?.close
    if (source.candles[index]?.time !== start || !isFinite(base) || base <= 0) {
      return []
    }
    const percent = value => 100 * (value / base - 1)
    return source.candles.slice(index).filter(candle => candle.time < report.endTime).map(candle => ({
      time: candle.time, open: percent(candle.open), high: percent(candle.max), low: percent(candle.min), close: percent(candle.close),
    }))
  }

  function redraw () {
    syncing = true
    const selected = report.candidates.find(entry => String(entry.baseCurrencyId) === select.value)
    const entries = [report.reference, selected]
    const data = entries.map(entry => normalized(charts.find(chart => entry && chart.baseCurrencyId === entry.baseCurrencyId)))
    const bounds = data.flat().reduce((range, candle) => ({
      minValue: Math.min(range.minValue, candle.low), maxValue: Math.max(range.maxValue, candle.high),
    }), { minValue: 0, maxValue: 0 })
    const padding = (bounds.maxValue - bounds.minValue) * 0.05 || 1
    priceRange = { minValue: bounds.minValue - padding, maxValue: bounds.maxValue + padding }
    panels.forEach((panel, index) => {
      panel.data = data[index]
      panel.element.hidden = !panel.data.length
      panel.series.setData(panel.data)
      if (panel.data.length) {
        panel.chart.timeScale().setVisibleLogicalRange({ from: -0.5, to: panel.data.length - 0.5 })
      }
    })
    syncing = false
    document.getElementById("candidate-title").textContent = selected ? `${selected.symbol} · ${selected.marketSymbol}` : "Кандидат не выбран"
    document.getElementById("chart-status").textContent = entries.flatMap((entry, index) => entry && !data[index].length
      ? [`${entry.symbol}: нет свечей или previousClose для выбранного окна.`]
      : []).join(" ")
    document.getElementById("chart-period").textContent = `${days} дней · UTC: [${new Date((report.endTime - days * 86400) * 1000).toISOString()} → ${new Date(report.endTime * 1000).toISOString()}), конец не включён`
    buttons.forEach(button => button.setAttribute("aria-pressed", String(Number(button.dataset.days) === days)))
  }

  panels.forEach((panel) => {
    panel.chart.timeScale().subscribeVisibleLogicalRangeChange((range) => {
      if (syncing || !range || !panel.data.length) {
        return
      }
      syncing = true
      panels.filter(other => other !== panel && other.data.length).forEach((other) => {
        const current = other.chart.timeScale().getVisibleLogicalRange()
        if (!current || current.from !== range.from || current.to !== range.to) {
          other.chart.timeScale().setVisibleLogicalRange(range)
        }
      })
      syncing = false
    })
  })
  buttons.forEach(button => button.addEventListener("click", () => {
    days = Number(button.dataset.days)
    redraw()
  }))
  select.addEventListener("change", redraw)
  redraw()
}

export async function renderPriceComparisonHtml (report, charts) {
  const entries = shortlist(report)
  const selectedCharts = [report.reference, ...entries].map(entry => charts.find(chart => chart.baseCurrencyId === entry.baseCurrencyId)).filter(Boolean)
  const [library, license] = await Promise.all([readWebAsset("lightweight-charts.js"), readWebAsset("chart-license.txt")])
  const data = JSON.stringify({ report, charts: selectedCharts }).replaceAll("<", "\\u003c").replaceAll("\u2028", "\\u2028").replaceAll("\u2029", "\\u2029")
  const title = escapeHtml(`Сравнение характера цены · ${report.reference.symbol} · ${report.timeframe}`)
  return `<!doctype html>
<html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'">
<title>${title}</title><style>
* { box-sizing: border-box; } body { margin: 0; background: #f4f6fa; color: #243044; font: 14px/1.55 system-ui, sans-serif; }
main { max-width: 1600px; margin: auto; padding: 24px; } h1 { font-size: 26px; } h2 { font-size: 20px; } h3 { font-size: 16px; }
section, details { margin: 24px 0; } p, li, h3 { overflow-wrap: anywhere; } .table-scroll { overflow-x: auto; background: white; border: 1px solid #dbe1e9; border-radius: 8px; }
table { width: 100%; border-collapse: collapse; font-variant-numeric: tabular-nums; } th, td { padding: 8px 10px; border-bottom: 1px solid #e5e9f0; text-align: right; white-space: nowrap; }
th { background: #eef2f7; } th:first-child, td:first-child { text-align: left; } tbody tr:hover { background: #f4f8ff; }
button, select { font: inherit; border: 1px solid #bac5d5; border-radius: 6px; background: white; color: #174e98; padding: 6px 10px; max-width: 100%; }
button, summary { cursor: pointer; } button[aria-pressed="true"] { background: #174e98; color: white; } :focus-visible { outline: 2px solid #174e98; outline-offset: 2px; }
.controls { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; } .charts { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; }
.chart { height: 420px; } [hidden] { display: none !important; } #chart-status { color: #92400e; } pre { white-space: pre-wrap; font-size: 12px; } a { color: #174e98; }
@media (max-width: 850px) { main { padding: 12px; } .charts { grid-template-columns: 1fr; } }
</style></head><body><main><h1>${title}</h1>
${introduction(report).map(text => `<p>${escapeHtml(text)}</p>`).join("\n")}
<section aria-label="Сравнение свечных графиков"><h2>Свечи ${escapeHtml(report.timeframe)} · одна процентная шкала</h2>
<div class="controls"><label for="candidate">Кандидат:</label><select id="candidate"${entries.length ? "" : " disabled"}>
${entries.length ? entries.map(entry => `<option value="${escapeHtml(entry.baseCurrencyId)}">${escapeHtml(`${entry.symbol} · ${entry.name}`)}</option>`).join("\n") : "<option value=\"\">Нет кандидатов в подборках</option>"}
</select>${windows(report).map(days => `<button type="button" data-days="${escapeHtml(days)}" aria-pressed="${days === 7}">${number(days, 0)} дней</button>`).join("\n")}</div>
${entries.length ? "" : "<p>Подборки пусты: можно рассмотреть только эталон. Это не означает, что другие монеты хуже.</p>"}
<p id="chart-period"></p><p id="chart-status" role="status"></p>
<div class="charts"><article><h3>${escapeHtml(`${report.reference.symbol} · эталон · ${report.reference.marketSymbol}`)}</h3><div id="reference-chart" class="chart"></div></article>
<article><h3 id="candidate-title">Выбранный кандидат</h3><div id="candidate-chart" class="chart"></div></article></div>
<p>Нормировка OHLC: 100 × (цена / previousClose начала выбранного окна − 1). Для полного окна используется переданный previousClose, для короткого — закрытие предшествующей свечи; 0% — эта базовая цена, не открытие первой свечи.</p>
<p>Вертикальная шкала общая: минимум и максимум обеих серий за выбранное окно, с запасом и включением 0%. Она фиксирована при горизонтальном зуме и меняется только при выборе окна или кандидата. Независимый автомасштаб отключён: меньшую амплитуду нельзя принимать за более ровное движение. Прокрутка и приближение по времени синхронны; базовая цена при зуме не меняется.</p>
<noscript>Для графиков нужен JavaScript; таблицы доступны без него.</noscript></section>
${tables(report).map(htmlTable).join("\n")}
<section><h2>Методика и ограничения</h2><ul>${methodology(report).map(text => `<li>${escapeHtml(text)}</li>`).join("\n")}</ul></section>
<footer><p>Графики: <a href="https://www.tradingview.com/" rel="noopener noreferrer">TradingView Lightweight Charts™</a>. Все данные встроены; сетевых запросов нет.</p>
<details><summary>Лицензия Lightweight Charts</summary><pre>${escapeHtml(license.content)}</pre></details></footer></main>
<script id="comparison-data" type="application/json">${data}</script>
<script>${library.content}</script>
<script>(${mountComparison.toString()})(window, JSON.parse(document.getElementById("comparison-data").textContent), ${isFinite.toString()})</script>
</body></html>`
}
