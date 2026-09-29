import { isFinite } from "../helpers/utils.typed.js"
import { readWebAsset } from "../web/read-web-asset.js"

function escapeHtml (value) {
  return String(value).replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" })[char])
}

function escapeMarkdown (value) {
  return escapeHtml(value).replace(/[\\|`*_[\]]/g, "\\$&").replace(/[\r\n\u2028\u2029]+/g, " ")
}

function number (value, digits = 2) {
  return isFinite(value) ? value.toLocaleString("ru-RU", { maximumFractionDigits: digits }) : "—"
}

function utc (time) {
  return new Date(isFinite(time) ? time * 1000 : time).toISOString().slice(0, 16).replace("T", " ")
}

function period (summary) {
  return `${utc(summary.startTime)} → ${utc(summary.endTime)}`
}

function values (summary, keys, digits = 2) {
  return keys.map(key => number(summary[key], digits)).join(" / ")
}

function introduction (report) {
  const analysisDays = report.coverage.analysisDays ?? report.windows.at(-1).days
  return [
    `${report.marketSymbol} · источник: ${report.source} · ${report.timeframe}. Период UTC: [${period(report)}). Создан: ${utc(report.generatedAt)} UTC.`,
    `История: запрошено ${number(report.coverage.requestedDays ?? analysisDays, 0)} дней; доступно для анализа ${number(analysisDays, 0)} полных дней.`,
    ...report.warnings.map(text => `Предупреждение: ${text}`),
    `Свечей анализа: ${number(report.coverage.analysisBars, 0)}; прогрев: ${number(report.coverage.warmupBars, 0)}; всего: ${number(report.coverage.totalBars, 0)}; пропусков: ${number(report.coverage.missingBars, 0)}; шаг: ${number(report.coverage.intervalSeconds, 0)} с.`,
    "Исследование, не скоринг и не прогноз. Все пороги исследовательские, не откалиброваны. Все времена UTC; начало включено, конец не включён. Прочерк — нет данных, 0 — нулевое значение.",
  ]
}

function methodology (report) {
  return [
    "TR% = max(high − low, |high − previousClose|, |low − previousClose|) / previousClose × 100. Медиана, p99 и максимум TR учитывают разрывы цены, не только high − low. Проценты показаны без повторного умножения на 100.",
    "TR: p99 / медиана — размер хвоста; IQR / медиана — разброс центральной половины значений. Это безразмерные отношения, не оценки качества.",
    "Вспышка: TR% ≥ 4 × медиана TR% предыдущих 96 свечей; текущая свеча не входит в фон. Частота вспышек — от spikeEvaluatedBars (число оценённых свечей). События упорядочены по TR / фон, а не по доходности.",
    "Длинная тень: одна тень ≥ 60% high − low и (high − low) / previousClose × 100 ≥ предыдущей медианы TR%. Частота — также от spikeEvaluatedBars. Тень в событиях — доля большей тени в high − low.",
    "Efficiency = abs(sum logreturns) / sum abs(logreturns), скользящие 4ч / 12ч; показаны медианы в диапазоне 0–1. Это направленность движения, она не обещает предсказуемость.",
    "Топ-1% — доля суммарного abs logreturn, приходящаяся на крупнейший 1% свечей по abs logreturn. Оборот ≈ volume × HLC3 в USDT; показана медиана дневного оборота, не ликвидность стакана.",
    ...report.methodology,
  ]
}

function sections (report) {
  return [
    {
      title: `Окна: ${report.windows.map(window => number(window.days, 0)).join(" / ")} дней`,
      headers: ["Показатель", ...report.windows.map(window => window.label)],
      rows: [
        ["Период UTC [начало, конец)", period],
        ["Дней / свечей", window => values(window, ["days", "bars"], 0)],
        ["Изменение цены, %", window => number(window.netReturnPct)],
        ["TR: медиана / p99 / макс., %", window => values(window, ["medianRangePct", "p99RangePct", "maxRangePct"])],
        ["TR: p99 / медиана; IQR / медиана", window => values(window, ["rangeTailRatio", "rangeIqrOverMedian"])],
        ["Модуль доходности: медиана / p99, %", window => values(window, ["medianAbsReturnPct", "p99AbsReturnPct"])],
        ["Вспышек / оценено свечей", window => values(window, ["spikeCount", "spikeEvaluatedBars"], 0)],
        ["Частота вспышек, %", window => number(window.spikeRatePct)],
        ["TR > 3% / модуль доходности > 3%, %", window => values(window, ["rangeOver3PctRatePct", "returnOver3PctRatePct"])],
        ["Длинная тень, %", window => number(window.longWickRatePct)],
        ["Efficiency 4ч / 12ч (0–1)", window => values(window, ["efficiency4hMedian", "efficiency12hMedian"], 3)],
        ["Доля движения топ-1%, %", window => number(window.top1PctMovementSharePct)],
        ["Дневной оборот: медиана, ≈ USDT", window => number(window.medianDailyTurnoverUsdt, 0)],
        ["Нулевая доходность / плоские свечи, %", window => values(window, ["zeroReturnRatePct", "flatBarRatePct"])],
      ].map(([label, value]) => [label, ...report.windows.map(value)]),
    },
    {
      title: "Недели по времени",
      headers: ["Неделя · UTC [начало, конец)", "Дней / свечей", "Δ цены, %", "TR мед. / p99, %", "Вспышек / оценено", "Вспышки, %", "Eff. 4ч / 12ч", "Топ-1%, %"],
      rows: report.weeks.map(week => [
        `${week.label} · ${period(week)}`, values(week, ["days", "bars"], 0), number(week.netReturnPct),
        values(week, ["medianRangePct", "p99RangePct"]), values(week, ["spikeCount", "spikeEvaluatedBars"], 0),
        number(week.spikeRatePct), values(week, ["efficiency4hMedian", "efficiency12hMedian"], 3), number(week.top1PctMovementSharePct),
      ]),
    },
    {
      title: "Крупнейшие вспышки",
      headers: ["Время UTC", "Доходность, %", "TR, %", "Фон TR, %", "TR / фон", "Тень, %"],
      times: report.spikes.map(spike => spike.time),
      rows: report.spikes.map(spike => [
        utc(spike.time), ...["returnPct", "rangePct", "baselineRangePct", "rangeMultiple", "longestWickPct"].map(key => number(spike[key])),
      ]),
    },
  ]
}

export function renderPriceCharacterMarkdown (report) {
  const tableRow = cells => `| ${cells.map(escapeMarkdown).join(" | ")} |`
  return [
    `# ${escapeMarkdown(report.symbol)} · характер цены · ${escapeMarkdown(report.timeframe)}`,
    ...introduction(report).map(escapeMarkdown),
    ...sections(report).map(section => `## ${section.title}\n\n${section.rows.length
      ? [tableRow(section.headers), tableRow(section.headers.map(() => "---")), ...section.rows.map(tableRow)].join("\n")
      : "Нет событий / данных."}`),
    `## Как читать\n\n${methodology(report).map(text => `- ${escapeMarkdown(text)}`).join("\n")}`,
  ].join("\n\n") + "\n"
}

function htmlTable (section) {
  const rows = section.rows.map((cells, row) => `<tr>${cells.map((cell, column) => {
    const text = escapeHtml(cell)
    return `<td>${column === 0 && isFinite(section.times?.[row])
      ? `<button type="button" data-time="${section.times[row]}" title="Показать ±12 часов">${text}</button>`
      : text}</td>`
  }).join("")}</tr>`).join("\n")
  return `<section><h2>${escapeHtml(section.title)}</h2>${rows
    ? `<div class="table-scroll"><table><thead><tr>${section.headers.map(text => `<th scope="col">${escapeHtml(text)}</th>`).join("")}</tr></thead><tbody>${rows}</tbody></table></div>`
    : "<p>Нет событий / данных.</p>"}</section>`
}

function mountChart ({ document, LightweightCharts }, { report, candles }) {
  const chart = LightweightCharts.createChart(document.getElementById("chart"), {
    autoSize: true,
    layout: { attributionLogo: true, background: { color: "#ffffff" }, textColor: "#243044" },
    timeScale: { timeVisible: true, secondsVisible: false },
    localization: { locale: "ru-RU", timeFormatter: time => new Date(time * 1000).toISOString().slice(0, 16).replace("T", " ") + " UTC" },
  })
  chart.addSeries(LightweightCharts.CandlestickSeries, {
    upColor: "#15803d", downColor: "#dc2626", wickUpColor: "#15803d", wickDownColor: "#dc2626", borderVisible: false,
    priceFormat: { type: "price", precision: 6, minMove: 0.000001 },
  }).setData(candles.map(({ time, open, max, min, close }) => ({ time, open, high: max, low: min, close })))
  const buttons = [...document.querySelectorAll("[data-days]")]
  function showRange (start, end, days = null) {
    chart.timeScale().setVisibleRange({
      from: Math.max(report.startTime, start),
      // endTime is exclusive; the chart expects the time of the last visible candle.
      to: Math.min(report.endTime, end) - report.coverage.intervalSeconds,
    })
    buttons.forEach(button => button.setAttribute("aria-pressed", String(Number(button.dataset.days) === days)))
  }
  buttons.forEach(button => button.addEventListener("click", () => {
    const window = report.windows.find(window => window.days === Number(button.dataset.days))
    showRange(window.startTime, window.endTime, window.days)
  }))
  document.querySelectorAll("[data-time]").forEach(button => button.addEventListener("click", () => {
    const time = Number(button.dataset.time)
    showRange(time - 12 * 3600, time + 12 * 3600)
    document.getElementById("chart").scrollIntoView({ behavior: "smooth", block: "center" })
  }))
  const lastWindow = report.windows.at(-1)
  showRange(lastWindow.startTime, lastWindow.endTime, lastWindow.days)
}

export async function renderPriceCharacterHtml (report, candles) {
  const [charts, license] = await Promise.all([readWebAsset("lightweight-charts.js"), readWebAsset("chart-license.txt")])
  const data = JSON.stringify({ report, candles }).replaceAll("<", "\\u003c").replaceAll("\u2028", "\\u2028").replaceAll("\u2029", "\\u2029")
  const title = escapeHtml(`${report.symbol} · характер цены · ${report.timeframe}`)
  return `<!doctype html>
<html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'">
<title>${title}</title><style>
* { box-sizing: border-box; } body { margin: 0; background: #f4f6fa; color: #243044; font: 15px/1.55 system-ui, sans-serif; }
main { max-width: 1400px; margin: auto; padding: 24px; } h1 { font-size: 26px; } h2 { font-size: 20px; margin-top: 28px; }
p, li { overflow-wrap: anywhere; } section { margin: 24px 0; } .table-scroll { overflow-x: auto; background: white; border: 1px solid #dbe1e9; border-radius: 8px; }
table { width: 100%; border-collapse: collapse; font-variant-numeric: tabular-nums; } th, td { padding: 9px 12px; border-bottom: 1px solid #e5e9f0; text-align: right; white-space: nowrap; }
th { background: #eef2f7; } td:first-child, th:first-child { text-align: left; } tbody tr:hover { background: #f4f8ff; }
button { font: inherit; cursor: pointer; border: 1px solid #bac5d5; border-radius: 6px; background: white; color: #174e98; padding: 5px 10px; }
button[aria-pressed="true"] { background: #174e98; color: white; } button:focus-visible { outline: 2px solid #174e98; outline-offset: 2px; }
#chart { height: 500px; margin: 12px 0; } .controls { display: flex; flex-wrap: wrap; gap: 8px; } pre { white-space: pre-wrap; font-size: 12px; } a { color: #174e98; }
@media (max-width: 640px) { main { padding: 12px; } #chart { height: 360px; } }
</style></head><body><main><h1>${title}</h1>
${introduction(report).map(text => `<p>${escapeHtml(text)}</p>`).join("\n")}
<section aria-label="Свечной график"><h2>Свечи ${escapeHtml(report.timeframe)} · UTC</h2><div class="controls" aria-label="Период графика">
${report.windows.map((window, index) => `<button type="button" data-days="${escapeHtml(window.days)}" aria-pressed="${index === report.windows.length - 1}">${escapeHtml(window.label)}</button>`).join("\n")}
</div><div id="chart" aria-label="Цена, USDT"></div><p>Только анализируемые свечи, без прогрева и сетевых запросов. Кнопки меняют только график. Нажмите время вспышки в таблице, чтобы показать ±12 часов.</p>
<noscript>Для графика нужен JavaScript; таблицы доступны без него.</noscript></section>
${sections(report).map(htmlTable).join("\n")}
<section><h2>Как читать</h2><ul>${methodology(report).map(text => `<li>${escapeHtml(text)}</li>`).join("\n")}</ul></section>
<footer><p>Данные: TradingView. График: <a href="https://www.tradingview.com/" rel="noopener noreferrer">TradingView Lightweight Charts™</a>.</p>
<details><summary>Лицензия Lightweight Charts</summary><pre>${escapeHtml(license.content)}</pre></details></footer></main>
<script id="price-data" type="application/json">${data}</script>
<script>${charts.content}</script>
<script>(${mountChart.toString()})(window, JSON.parse(document.getElementById("price-data").textContent))</script>
</body></html>`
}
