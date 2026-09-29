import { isArray, isFinite, isInt, isString } from "../helpers/utils.typed.js"

function mean (values) {
  return values.length && values.every(isFinite)
    ? values.reduce((total, value) => total + value / values.length, 0)
    : null
}

function quantile (values, fraction) {
  if (!values.length || !values.every(isFinite)) {
    return null
  }
  const sorted = [...values].sort((first, second) => first - second)
  const position = (sorted.length - 1) * fraction
  const lower = Math.floor(position)
  return sorted[lower] + (sorted[Math.ceil(position)] - sorted[lower]) * (position - lower)
}

function ratio (numerator, denominator) {
  if (!isFinite(numerator) || numerator < 0 || !isFinite(denominator) || denominator <= 0) {
    return null
  }
  const value = numerator / denominator
  return isFinite(value) ? value : null
}

function validMetric (value) {
  return isFinite(value) && value >= 0
}

function matchesWindow (window, startTime, endTime) {
  return window?.startTime === startTime && window.endTime === endTime
    && window.days === (endTime - startTime) / 86400
    && window.bars === (endTime - startTime) / 900
}

function validateAlignment (profile, reference, windowDays) {
  const coverage = profile.coverage
  const analysisDays = reference.coverage.analysisDays
  if (profile.timeframe !== "15m" || profile.startTime !== reference.startTime || profile.endTime !== reference.endTime
    || coverage?.analysisDays !== analysisDays || coverage.analysisBars !== analysisDays * 96
    || coverage.intervalSeconds !== 900 || coverage.missingBars !== 0
    || coverage.warmupBars !== 97 || coverage.totalBars !== analysisDays * 96 + 97
    || !isInt(coverage.requestedDays) || coverage.requestedDays < analysisDays || coverage.requestedDays > 90) {
    throw new Error(`${profile.baseCurrencyId}: нужны одинаковые полные периоды native 15m, покрытие и прогрев`)
  }
  if (!isArray(profile.windows) || profile.windows.length !== windowDays.length
    || !windowDays.every(days => matchesWindow(
      profile.windows.find(window => window?.days === days), reference.endTime - days * 86400, reference.endTime,
    ))) {
    throw new Error(`${profile.baseCurrencyId}: неполные, повторяющиеся или несовпадающие окна ${windowDays.join("/")} дней`)
  }
  const weekEnds = Array.from({ length: Math.ceil(analysisDays / 7) }, (_, index) => reference.endTime - index * 7 * 86400)
  if (!isArray(profile.weeks) || profile.weeks.length !== weekEnds.length
    || !weekEnds.every(endTime => matchesWindow(
      profile.weeks.find(week => week?.endTime === endTime), Math.max(reference.startTime, endTime - 7 * 86400), endTime,
    ))) {
    throw new Error(`${profile.baseCurrencyId}: недели должны полностью покрывать период без пропусков и пересечений`)
  }
}

function describeProfile (profile, windowDays) {
  const windows = windowDays.map(days => profile.windows.find(window => window.days === days))
  const month = windows.find(window => window.days === 30)
  const weeks = profile.weeks.filter(week => week.days === 7)
  const weeklySpikes = weeks.map(week => week.spikeRatePct)
  const weeklyRanges = weeks.map(week => week.medianRangePct)
  const weeklyMedian = weeklyRanges.every(validMetric) ? quantile(weeklyRanges, 0.5) : null
  const weeklySpikeP90Pct = weeklySpikes.every(validMetric) ? quantile(weeklySpikes, 0.9) : null
  const weeklyRangeVariation = weeklyMedian > 0
    ? ratio(quantile(weeklyRanges, 0.75) - quantile(weeklyRanges, 0.25), weeklyMedian)
    : null
  const features = [
    ...windows.flatMap(window => Object.entries({
      bursts: ["spikeRatePct", "rangeTailRatio", "top1PctMovementSharePct"],
      pace: ["rangeIqrOverMedian"],
      wicks: ["longWickRatePct"],
      path: ["efficiency4hMedian", "efficiency12hMedian"],
      amplitude: ["medianRangePct", "medianAbsReturnPct"],
    }).flatMap(([group, metrics]) => metrics.map(metric => ({ group, days: window.days, metric, value: window[metric] })))),
    ...Object.entries({ weeklySpikeP90Pct, weeklyRangeVariation }).map(([metric, value]) => ({
      group: "stability", days: null, metric, value,
    })),
  ]
  const exclusions = [
    ...features.filter(feature => !validMetric(feature.value)).map(feature => (
      `${feature.days === null ? "Полные недели" : `Окно ${feature.days} дней`}: ${feature.metric} отсутствует или некорректна; нужна конечная неотрицательная метрика.`
    )),
    ...windows.flatMap(window => [
      window.spikeEvaluatedBars !== window.bars
        ? `Окно ${window.days} дней: baseline доступен не для всех свечей (spikeEvaluatedBars != bars).`
        : null,
      !isFinite(window.medianRangePct) || window.medianRangePct <= 0
        ? `Окно ${window.days} дней: нормировщик medianRangePct должен быть больше нуля.`
        : null,
    ]),
    ...weeks.flatMap(week => [
      week.spikeEvaluatedBars !== week.bars
        ? `Неделя ${week.startTime}: baseline доступен не для всех свечей (spikeEvaluatedBars != bars).`
        : null,
      ...["spikeRatePct", "medianRangePct"].filter(metric => !validMetric(week[metric])).map(metric => (
        `Неделя ${week.startTime}: ${metric} отсутствует или некорректна; нужна конечная неотрицательная метрика.`
      )),
    ]),
    ...["medianDailyTurnoverUsdt", "zeroReturnRatePct", "flatBarRatePct"].filter(metric => !validMetric(month[metric])).map(metric => (
      `Окно 30 дней: ${metric} отсутствует или некорректна; нужна конечная неотрицательная метрика.`
    )),
    weeklyMedian > 0 ? null : "Нормировщик недельной вариации — медиана medianRangePct полных недель — должен быть больше нуля.",
  ].filter(Boolean)
  return { profile, features, exclusions, weeklySpikeP90Pct, weeklyRangeVariation }
}

function percentile (value, cohort) {
  return (cohort.filter(other => other < value).length + cohort.filter(other => other === value).length / 2) / cohort.length
}

function compareEntries (first, second, metric) {
  if (first[metric] !== second[metric]) {
    if (first[metric] === null) {
      return 1
    }
    if (second[metric] === null) {
      return -1
    }
    return first[metric] - second[metric]
  }
  if (first.baseCurrencyId === second.baseCurrencyId) {
    return 0
  }
  return first.baseCurrencyId < second.baseCurrencyId ? -1 : 1
}

export function comparePriceCharacters ({ reference, profiles, universeGeneratedAt, universeCount, rejected = [], pending = [] }) {
  if (!isArray(profiles) || !isArray(rejected) || !isArray(pending)) {
    throw new Error("profiles, rejected и pending должны быть массивами")
  }
  const ids = [reference, ...profiles, ...rejected.map(item => item?.coin), ...pending].map(coin => coin?.baseCurrencyId)
  if (ids.some(id => !isString(id) || !id.trim())) {
    throw new Error("Каждой монете нужен непустой baseCurrencyId")
  }
  if (new Set(ids).size !== ids.length) {
    throw new Error("Дубликаты baseCurrencyId между эталоном, profiles, rejected или pending недопустимы")
  }
  if (!isInt(universeCount) || universeCount < ids.length) {
    throw new Error("universeCount должен быть целым и не меньше числа учтённых монет")
  }
  const analysisDays = reference.coverage?.analysisDays
  if (!isInt(analysisDays) || analysisDays < 30 || analysisDays > 90
    || !isInt(reference.startTime) || !isInt(reference.endTime)
    || reference.startTime % 900 !== 0 || reference.endTime % 900 !== 0
    || reference.endTime - reference.startTime !== analysisDays * 86400) {
    throw new Error("Эталону нужны 30–90 полных дней на сетке 15m с согласованными startTime/endTime")
  }
  const windowDays = [...new Set([7, 30, analysisDays])]
  const reports = [reference, ...profiles]
  reports.forEach(profile => validateAlignment(profile, reference, windowDays))
  const described = reports.map(profile => describeProfile(profile, windowDays))
  const referenceMonth = reference.windows.find(window => window.days === 30)
  const referenceFull = reference.windows.find(window => window.days === analysisDays)
  if (referenceMonth.medianDailyTurnoverUsdt === 0) {
    described[0].exclusions.push("Эталон: нормировщик medianDailyTurnoverUsdt за 30 дней должен быть больше нуля.")
  }

  // Activity gates must not change the percentile cohort.
  const cohort = described.filter(item => !item.exclusions.length)
  const normalized = described.map(item => item.exclusions.length || described[0].exclusions.length
    ? null
    : item.features.map((feature, index) => percentile(feature.value, cohort.map(other => other.features[index].value))))
  const entries = described.map((item, index) => {
    const { profile, features, weeklySpikeP90Pct, weeklyRangeVariation } = item
    const { baseCurrencyId, symbol, name, marketSymbol, rank } = profile
    const month = profile.windows.find(window => window.days === 30)
    const full = profile.windows.find(window => window.days === analysisDays)
    const amplitudeRatio30d = ratio(month.medianRangePct, referenceMonth.medianRangePct)
    const turnoverRatio30d = ratio(month.medianDailyTurnoverUsdt, referenceMonth.medianDailyTurnoverUsdt)
    const exclusions = [
      ...item.exclusions,
      index > 0 && described[0].exclusions.length ? "Метрики эталона неполны: сравнение и допуск недоступны." : null,
      amplitudeRatio30d === null || amplitudeRatio30d < 0.5 || amplitudeRatio30d > 2
        ? "Амплитуда за 30 дней: medianRangePct должна быть в пределах 0.5–2 от эталона; отношение недоступно или вне границ."
        : null,
      turnoverRatio30d === null || turnoverRatio30d < 0.5
        ? "Оборот за 30 дней: medianDailyTurnoverUsdt должен быть не ниже 0.5 от эталона; отношение недоступно или ниже порога."
        : null,
      isFinite(month.zeroReturnRatePct) && month.zeroReturnRatePct > 20 ? "Окно 30 дней: zeroReturnRatePct превышает 20%." : null,
      isFinite(month.flatBarRatePct) && month.flatBarRatePct > 1 ? "Окно 30 дней: flatBarRatePct превышает 1%." : null,
    ].filter(Boolean)
    const eligible = exclusions.length === 0
    const groups = [...new Set(features.map(feature => feature.group))]
    const percentiles = normalized[index]
    const differences = percentiles?.map((value, featureIndex) => 100 * Math.abs(value - normalized[0][featureIndex])) ?? null
    const componentDistances = Object.fromEntries(groups.map(group => [
      group, differences ? mean(differences.filter((_, featureIndex) => features[featureIndex].group === group)) : null,
    ]))
    const distanceByWindow = Object.fromEntries(windowDays.map(days => [
      days, differences
        ? mean(groups.filter(group => group !== "stability").map(group => mean(
            differences.filter((_, featureIndex) => features[featureIndex].group === group && features[featureIndex].days === days),
          )))
        : null,
    ]))
    const calmScore = percentiles
      ? 100 * mean([
        ...windowDays.map(days => mean(percentiles.filter((_, featureIndex) => (
          features[featureIndex].group === "bursts" && features[featureIndex].days === days
        )))),
        percentiles[features.findIndex(feature => feature.metric === "weeklySpikeP90Pct")],
      ])
      : null
    return {
      baseCurrencyId, symbol, name, marketSymbol, rank, profile, eligible, exclusions,
      distance: index === 0 ? 0 : differences ? mean(Object.values(componentDistances)) : null,
      distanceByWindow, componentDistances, calmScore,
      weeklySpikeP90Pct, weeklyRangeVariation, amplitudeRatio30d, turnoverRatio30d,
      calmerThanReference: index > 0 && eligible
        && ["spikeRatePct", "rangeTailRatio", "top1PctMovementSharePct"].every(metric => month[metric] < referenceMonth[metric])
        && full.spikeRatePct <= referenceFull.spikeRatePct && weeklySpikeP90Pct <= described[0].weeklySpikeP90Pct,
    }
  })
  const candidates = entries.slice(1).sort((first, second) => compareEntries(first, second, "distance"))
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    universeGeneratedAt,
    timeframe: "15m",
    analysisDays,
    startTime: reference.startTime,
    endTime: reference.endTime,
    coverage: {
      total: universeCount, loaded: profiles.length + 1, failed: rejected.length, pending: pending.length,
      eligible: candidates.filter(entry => entry.eligible).length,
    },
    reference: entries[0],
    candidates,
    closest: candidates.filter(entry => entry.eligible).slice(0, 10).map(entry => entry.baseCurrencyId),
    calmer: candidates.filter(entry => entry.calmerThanReference)
      .sort((first, second) => compareEntries(first, second, "calmScore")).slice(0, 5).map(entry => entry.baseCurrencyId),
    rejected,
    pending,
    warnings: [
      ...(reference.warnings ?? []),
      analysisDays < reference.coverage.requestedDays
        ? `Ограничение исходной истории эталона унаследовано: ${analysisDays} дней из запрошенных ${reference.coverage.requestedDays}; более длинные окна не достраиваем.`
        : null,
      profiles.length + 1 < universeCount ? `Неполное покрытие: загружено ${profiles.length + 1} из ${universeCount} монет.` : null,
      pending.length ? `Ожидают загрузки ${pending.length} монет: ранги предварительные, состав когорты и оценки могут измениться.` : null,
      rejected.length ? `Не загружено ${rejected.length} монет: они не сравнивались; причины сохранены в rejected.` : null,
      ids.length < universeCount ? `Для ${universeCount - ids.length} монет нет профиля или статуса загрузки; ранги предварительные.` : null,
      described[0].exclusions.length ? "Эталон содержит неполные или некорректные метрики: ранжирование недоступно." : null,
    ].filter(Boolean),
    methodology: [
      "Только native 15m, одинаковые startTime/endTime и 30–90 полных дней; уникальные окна 7/30/весь период равновесны. Пропуски и несовпадающие окна не заполняем.",
      "Для каждого скаляра каждого окна отдельно: p = (less + equal/2) / N по всем полным метрическим профилям и эталону ДО порогов активности. Неполные профили исключены из всей когорты; null не заменяем нулём.",
      "bursts: spikeRatePct, rangeTailRatio, top1PctMovementSharePct; pace: rangeIqrOverMedian; wicks: longWickRatePct; path: efficiency4hMedian, efficiency12hMedian; amplitude: medianRangePct, medianAbsReturnPct.",
      "weeklySpikeP90Pct = линейный q90 частот вспышек полных 7-дневных недель; weeklyRangeVariation = (q75 − q25) / median их medianRangePct. Неполную раннюю неделю не используем. Оба скаляра отдельно нормируем в stability.",
      "d_group = 100 × mean(|p − p_ref|) по метрикам и окнам группы; distance = mean(6 групп); distanceByWindow = mean(5 ненедельных групп окна). Это расстояние 0–100, не вероятность.",
      "Допуск: baseline всех свечей (spikeEvaluatedBars == bars), конечные сравниваемые метрики и ненулевые нормировщики; за 30 дней medianRangePct ∈ [0.5, 2] × эталон, medianDailyTurnoverUsdt ≥ 0.5 × эталон, zeroReturnRatePct ≤ 20%, flatBarRatePct ≤ 1%.",
      "calmer: допуск И все три bursts за 30 дней строго ниже эталона И spikeRatePct всего периода ≤ эталон И weeklySpikeP90Pct ≤ эталон. На 7 днях может быть хуже — это видно в profile; меньше выбросов не гарантирует плавность или предсказуемость.",
      "calmScore = 100 × mean([mean(p трёх bursts) для каждого окна, p(weeklySpikeP90Pct)]); ниже лучше. closest: до 10 допущенных по distance; calmer: до 5 прошедших условия по calmScore; при равенстве — baseCurrencyId. Пустые списки не дополняем неподходящими монетами.",
      "Группы уменьшают повторный вес связанных признаков. Окна перекрываются; оценки эвристические, не статистическая уверенность. Пороги заданы заранее, не подстроены по результатам и не откалиброваны.",
      "Доходность, направление, уровень цены и корреляция не входят в метрики сравнения. Процентильные расстояния не зависят от масштаба скаляров; приблизительный оборот USDT — не ликвидность стакана.",
    ],
  }
}
