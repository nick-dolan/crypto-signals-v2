import { isArray, isFinite, isNaN, isNumber, isObject } from "../../helpers/utils.typed.js"

function roundNumber (value, precision = 3) {
  if (!isFinite(value)) {
    throw new Error(`Agent payload cannot format non-finite value: ${value}`)
  }

  const factor = 10 ** precision
  const rounded = Math.round(value * factor) / factor

  return Object.is(rounded, -0) ? 0 : rounded
}

function roundNullable (value) {
  return value === null ? null : roundNumber(value)
}

function roundScaledNullable (value, scale) {
  return value === null ? null : roundNumber(value * scale)
}

function normalizeToAtr (value, atr24hPct) {
  if (value === null) {
    return null
  }

  if (!isFinite(atr24hPct) || atr24hPct <= 0) {
    throw new Error(`Agent payload requires a positive atr24hPct: ${atr24hPct}`)
  }

  return roundNumber(value / atr24hPct)
}

function getActiveFlags (...groups) {
  return groups.flatMap(group => Object.entries(group)
    .filter(([, active]) => active === true)
    .map(([name]) => name))
}

function createCandidateRow (profile) {
  const { coin, context, features } = profile
  const volatility = features.volatilityCompression
  const lifecycle = features.movementLifecycle
  const volume = features.volumeOrderFlow
  const derivatives = features.derivatives
  const social = features.social
  const relative = features.relativeStrength
  const sustained = features.sustainedStrength
  const narrative = features.breadthNarrative
  const socialAvailable = context.socialStatus === "available"

  if (![
    lifecycle.distance_to_previous_high_atr,
    lifecycle.distance_to_previous_low_atr,
    lifecycle.prior_drawdown_atr_72h,
    lifecycle.max_24h_drawdown_last_7d_atr,
    derivatives.funding_rate,
    derivatives.oi_level_percentile_90d,
  ].every(isFinite)) {
    throw new Error(`${coin.symbol} is missing finite lifecycle/funding/OI-level metrics; rerun steps 4 and 5`)
  }

  if (
    !["available", "unavailable"].includes(context.socialStatus)
    || (socialAvailable && (
      !isObject(social)
      || ![
        social.social_dominance_z_30d,
        social.interactions_z_30d,
        social.interactions_acceleration_3h,
        social.interactions_per_contributor_z,
        social.created_posts_per_active_contributor,
        social.social_minus_price_z_3h,
      ].every(isFinite)
    ))
    || (!socialAvailable && social !== null)
  ) {
    throw new Error("Agent payload social features do not match their status")
  }

  return [
    coin.symbol,
    coin.name,
    coin.rank,
    roundNumber(context.atr24hPct * 100),
    roundNumber(context.marketCap / 1_000_000_000),
    roundNumber(context.volume24hUsd / 1_000_000),
    context.narrativeCategory,
    context.categoryStatus,
    roundNumber(volatility.rv_24h_over_rv_7d),
    roundNumber(volatility.bb_bandwidth_pct_30d),
    roundNumber(volatility.atr_pct_90d),
    volatility.range_compression_streak,
    volatility.squeeze_age_hours,
    roundNumber(lifecycle.prior_runup_atr_72h),
    roundNumber(lifecycle.max_24h_runup_last_7d_atr),
    roundNumber(lifecycle.prior_drawdown_atr_72h),
    roundNumber(lifecycle.max_24h_drawdown_last_7d_atr),
    roundNumber(lifecycle.range_position_7d),
    roundNumber(lifecycle.distance_to_previous_high_atr),
    roundNumber(lifecycle.distance_to_previous_low_atr),
    roundNullable(lifecycle.pre_breakout_squeeze_age),
    roundNullable(lifecycle.squeeze_ended_hours_ago),
    roundNullable(lifecycle.breakout_age_hours),
    roundNullable(lifecycle.post_breakout_extension_atr),
    roundNullable(lifecycle.extension_from_base_atr),
    roundNumber(volume.volume_z_30d),
    roundNumber(volume.volume_acceleration_3h * 100),
    roundNumber(volume.rel_volume_at_time),
    roundNumber(volume.vd_net_4h_over_volume),
    roundNumber(volume.cvd_minus_price_z_12h),
    roundNumber(derivatives.oi_change_1h * 100),
    roundNumber(derivatives.oi_change_4h * 100),
    roundNumber(derivatives.oi_change_12h * 100),
    roundNumber(derivatives.oi_acceleration_4h * 100),
    roundNumber(derivatives.oi_change_4h_z_30d),
    roundNumber(derivatives.oi_level_percentile_90d),
    derivatives.oi_up_while_rv_down,
    derivatives.funding_rate,
    roundNumber(derivatives.funding_percentile_90d),
    roundNumber(derivatives.funding_minus_oi_z_4h),
    roundNumber(derivatives.premium_z_30d),
    roundNumber(derivatives.liq_imbalance_4h),
    roundNumber(derivatives.crowd_vs_top_traders),
    context.socialStatus,
    roundNullable(social?.social_dominance_z_30d ?? null),
    roundNullable(social?.interactions_z_30d ?? null),
    roundScaledNullable(social?.interactions_acceleration_3h ?? null, 100),
    roundNullable(social?.interactions_per_contributor_z ?? null),
    roundNullable(social?.created_posts_per_active_contributor ?? null),
    roundNullable(social?.social_minus_price_z_3h ?? null),
    roundNumber(relative.beta_btc_7d),
    roundNumber(relative.corr_btc_24h),
    roundNumber(relative.corr_btc_change_24h_vs_7d),
    roundNumber(relative.residual_log_return_4h * 100),
    roundNumber(relative.residual_z_30d),
    roundNumber(relative.rs_vs_total3es_12h * 100),
    sustained?.status ?? "insufficient_data",
    roundNullable(sustained?.history_score ?? null),
    roundNullable(sustained?.current_score ?? null),
    roundNullable(sustained?.down_win_rate ?? null),
    roundNullable(sustained?.down_positive_rate ?? null),
    roundScaledNullable(sustained?.down_excess_median ?? null, 100),
    roundNullable(sustained?.up_participation_rate ?? null),
    roundScaledNullable(sustained?.excess_24h ?? null, 100),
    normalizeToAtr(narrative.category_momentum_4h, context.atr24hPct),
    roundNullable(narrative.category_breadth),
    normalizeToAtr(narrative.coin_leads_category, context.atr24hPct),
    getActiveFlags(features.divergences, {
      fresh_quiet_breakout: lifecycle.fresh_quiet_breakout,
      late_pump: lifecycle.late_pump,
      late_dump: lifecycle.late_dump,
    }),
  ]
}

function validateShortlist (shortlist) {
  if (!isObject(shortlist)) {
    throw new Error("Step 5 output must be an object")
  }

  if (!isArray(shortlist.candidates)) {
    throw new Error("Step 5 candidates must be an array")
  }

  if (shortlist.candidateCount !== shortlist.candidates.length) {
    throw new Error(
      `Step 5 declares ${shortlist.candidateCount} candidates but contains ${shortlist.candidates.length}`,
    )
  }
}

export function buildAgentPayload (shortlist) {
  validateShortlist(shortlist)

  const payload = {
    schemaVersion: 9,
    asOf: shortlist.asOf,
    timeframe: shortlist.timeframe,
    objective: "P(|движение| > 2.5 ATR в следующие 4–12 часов)",
    candidateOrder: "От наиболее приоритетного кандидата к наименее приоритетному",
    candidateCount: shortlist.candidateCount,
    marketContext: {
      breadth4h: roundNumber(shortlist.marketContext.breadth),
      altMarketBackground: shortlist.marketContext.altMarketBackground ?? null,
      btcRotation4hPct: roundNumber(
        shortlist.marketContext.segmentRotation.btc * 100,
      ),
      ethRotation4hPct: roundNumber(
        shortlist.marketContext.segmentRotation.eth * 100,
      ),
      altsRotation4hPct: roundNumber(
        shortlist.marketContext.segmentRotation.alts * 100,
      ),
      stablesRotation4hPct: roundNumber(
        shortlist.marketContext.segmentRotation.stables * 100,
      ),
      stablecap24hPct: roundNumber(shortlist.marketContext.stablecapChange * 100),
    },
    marketDefinitions: {
      breadth4h: "Доля монет вселенной с положительной доходностью за 4 часа",
      altMarketBackground: "Фон альтрынка за 4ч на asOf, рассчитанный на шаге 4: change4hPct — изменение капитализации TOTAL3ES (без BTC, ETH и стейблкоинов), %; breadth4h — доля растущих монет всей вселенной, 0–1. status: up при change4hPct > 0 и breadth4h > 0.55; down при change4hPct < 0 и breadth4h < 0.45; mixed — остальные сочетания; unavailable — недостаточно данных, причина в warning. Значения не округлены. Это эвристика среза, не прогноз и не вероятность; не считай её и исходную ширину рынка независимыми сигналами",
      btcRotation4hPct: "Изменение доли BTC в общей капитализации за 4 часа, п.п.",
      ethRotation4hPct: "Изменение доли ETH в общей капитализации за 4 часа, п.п.",
      altsRotation4hPct: "Изменение доли остальных альткоинов за 4 часа, п.п.",
      stablesRotation4hPct: "Изменение доли стейблкоинов за 4 часа, п.п.",
      stablecap24hPct: "Изменение капитализации стейблкоинов за 24 часа, %",
    },
    conventions: {
      rounding: "Числа округлены до трёх знаков после запятой; fundingRate и altMarketBackground передаются без округления",
      flags: "Флаги рассчитаны до округления. Не пересчитывай их по округлённым полям и не считай независимыми подтверждениями поверх исходных метрик",
      zScore: "Положительный z-score выше собственной нормы, отрицательный — ниже",
      percentile: "Перцентиль находится в диапазоне 0–1",
      sustainedStrength: "Контекст относительной силы, рассчитанный на шаге 4 до предварительного отбора. Peers — другие монеты всей вселенной, сама монета исключена; минимум 3 peers. Используется вся доступная OHLCV-история с непересекающимися историческими окнами. Медвежье окно 4h: строго > 55% peers падают и TOTAL3ES снижается; бычье: > 55% peers растут и TOTAL3ES растёт. sustainedStatus рассчитан до округления: не пересчитывай его по округлённым полям. Покрытие, повторяемость и остальные горизонты учтены в scores и статусе, но отдельно не передаются. Scores 0–100 — эвристики, не вероятности события",
      null: "Для category/social/altMarketBackground/sustainedStrength метрика недоступна; для event-only Lifecycle соответствующая тихая база или пробой за 7 дней не обнаружены. Это не ноль; insufficient_data у sustainedStatus не означает слабость, доступные компоненты сохраняются",
    },
    schema: [
      "symbol",
      "name",
      "rank",
      "atrPct",
      "marketCapB",
      "volume24hM",
      "category",
      "categoryStatus",
      "rvRatio",
      "bbPctile",
      "atrPctile",
      "rangeStreak",
      "squeezeAge",
      "priorRunupAtr72h",
      "max24hRunupLast7dAtr",
      "priorDrawdownAtr72h",
      "max24hDrawdownLast7dAtr",
      "rangePosition7d",
      "distanceToHigh24hAtr",
      "distanceToLow24hAtr",
      "preBreakoutSqueezeAge",
      "squeezeEndedHoursAgo",
      "breakoutAgeHours",
      "postBreakoutExtensionAtr",
      "extensionFromBaseAtr",
      "volumeZ",
      "volumeAccel3hPct",
      "relVolume",
      "vdShare4h",
      "cvdMinusPriceZ12h",
      "oiChange1hPct",
      "oiChange4hPct",
      "oiChange12hPct",
      "oiAccel4hPct",
      "oiZ",
      "oiLevelPctile",
      "quietOi",
      "fundingRate",
      "fundingPctile",
      "fundingMinusOiZ4h",
      "premiumZ",
      "liqImbalance",
      "crowdVsTop",
      "socialStatus",
      "socialDominanceZ",
      "interactionsZ",
      "socialAccel3hPct",
      "interactionsPerContributorZ",
      "postsPerContributor",
      "socialMinusPriceZ3h",
      "btcBeta7d",
      "btcCorr24h",
      "btcCorrChange",
      "residualLogReturn4hPct",
      "residualZ",
      "rsVsAlts12hPct",
      "sustainedStatus",
      "sustainedHistoryScore",
      "sustainedCurrentScore",
      "sustainedDownWinRate",
      "sustainedDownPositiveRate",
      "sustainedDownExcessMedianPct",
      "sustainedUpParticipationRate",
      "sustainedExcess24hPct",
      "categoryMoveAtr",
      "categoryBreadth",
      "coinLeadAtr",
      "flags",
    ],
    definitions: {
      symbol: "Тикер монеты",
      name: "Название монеты",
      rank: "Место по глобальной капитализации; меньше означает крупнее",
      atrPct: "Средний true range последних 24 часовых свечей в процентах от текущей цены; это средний часовой диапазон, а не диапазон суток",
      marketCapB: "Рыночная капитализация, млрд USD",
      volume24hM: "Объём Binance perpetual за 24 часа, млн USD",
      category: "Категория минимум с тремя peer-монетами, чья текущая медианная 4-часовая доходность максимальна по модулю",
      categoryStatus: "available, not_applicable без категорий или insufficient_peers без достаточного числа peer-монет",
      rvRatio: "Setup: realised volatility 24h / 7d; ниже 1 означает сжатие",
      bbPctile: "Setup: перцентиль ширины Bollinger Bands за 30 дней",
      atrPctile: "Setup: перцентиль ATR24h / close в полном скользящем окне 90 дней",
      rangeStreak: "Setup: часов подряд диапазон (high - low) / close не превышает свою 30-дневную медиану",
      squeezeAge: "Setup: часов подряд RV ratio < 0.75, Bollinger percentile <= 0.2 и ATR percentile <= 0.2",
      priorRunupAtr72h: "Lifecycle: положительный рост close за 72 часа до последних 4 часов / ATR в начале окна",
      max24hRunupLast7dAtr: "Lifecycle: максимальный положительный рост close за 24 часа среди окон последних 7 дней, завершившихся до последних 4 часов, / ATR в начале каждого окна",
      priorDrawdownAtr72h: "Lifecycle: положительная величина снижения close за 72 часа до последних 4 часов / ATR в начале окна",
      max24hDrawdownLast7dAtr: "Lifecycle: максимальная положительная величина снижения close за 24 часа среди окон последних 7 дней, завершившихся до последних 4 часов, / ATR в начале каждого окна",
      rangePosition7d: "Lifecycle: положение текущего close внутри диапазона high/low за 7 дней; 0 соответствует минимуму, 1 — максимуму",
      distanceToHigh24hAtr: "Range: (максимум high предыдущих 24 часов без текущей свечи - текущий close) / ATR24h предыдущей свечи; 0 — граница, минус — цена уже выше неё",
      distanceToLow24hAtr: "Range: (текущий close - минимум low предыдущих 24 часов без текущей свечи) / ATR24h предыдущей свечи; 0 — граница, минус — цена уже ниже неё",
      preBreakoutSqueezeAge: "Lifecycle: продолжительность сжатия непосредственно перед последним пробоем тихой базы, часы; null — подходящий пробой за 7 дней не найден",
      squeezeEndedHoursAgo: "Lifecycle: сколько часов назад закончилась последняя тихая база длительностью минимум 12 часов; null — такая база за 7 дней не найдена",
      breakoutAgeHours: "Lifecycle: сколько часов прошло с первого close за границей последних максимум 48 часов тихой базы; null — подходящий пробой за 7 дней не найден",
      postBreakoutExtensionAtr: "Lifecycle: текущая дистанция по направлению пробоя за границей последних максимум 48 часов базы / ATR перед пробоем; null — подходящий пробой за 7 дней не найден",
      extensionFromBaseAtr: "Lifecycle: абсолютная дистанция текущего close от середины последней тихой базы / её замороженный ATR; null — зрелая тихая база за 7 дней не найдена",
      volumeZ: "Trigger: z-score логарифма USD-объёма за 30 дней",
      volumeAccel3hPct: "Trigger: изменение суммы объёма последних 3 часов к предыдущим 3 часам, %",
      relVolume: "Trigger: текущий USD-объём / медиана этого же часа суток за предыдущие 30 дней",
      vdShare4h: "Trigger: итоговая Volume Delta за 4 часа / общий базовый объём; знак показывает сторону потока",
      cvdMinusPriceZ12h: "Trigger: z30d(Volume Delta / volume за 12h) минус z30d(price return за 12h); плюс означает, что поток сильнее цены",
      oiChange1hPct: "Derivatives: изменение Open Interest за 1 час, %",
      oiChange4hPct: "Derivatives: изменение Open Interest за 4 часа, %",
      oiChange12hPct: "Derivatives: изменение Open Interest за 12 часов, %",
      oiAccel4hPct: "Derivatives: ускорение 4-часового изменения Open Interest, п.п.",
      oiZ: "Derivatives: z-score изменения Open Interest за 4 часа относительно 30 дней",
      oiLevelPctile: "Setup: перцентиль текущего уровня Open Interest в полном скользящем окне 90 дней, 0–1; это уровень позиций, а не z-score их прироста и не величина плеча",
      quietOi: "Setup: Open Interest растёт за 12 часов, пока реализованная волатильность сжата",
      fundingRate: "Derivatives: текущая знаковая ставка из TradingView Funding_Rate в исходной шкале источника, без округления, масштабирования или годового пересчёта; плюс — лонги платят шортам, минус — шорты платят лонгам",
      fundingPctile: "Derivatives: перцентиль Funding Rate в полном скользящем окне 90 дней",
      fundingMinusOiZ4h: "Derivatives: z30d(изменение Funding Rate за 4h) минус z30d(изменение OI за 4h); плюс означает более сильный сдвиг funding",
      premiumZ: "Derivatives: z30d исходного Premium TradingView, уже относительного отклонения futures от index; без повторного деления на цену",
      liqImbalance: "Context: дисбаланс long и short ликвидаций от -1 до 1; плюс означает больше long. Не показывает величину или аномальность ликвидаций и сам по себе не является триггером",
      crowdVsTop: "Context: позиционирование обычных аккаунтов относительно top traders; плюс означает более long-настроенную толпу",
      socialStatus: "available при наличии всех четырёх полных social-рядов и шести рассчитанных признаков; иначе unavailable для всего Social-блока",
      socialDominanceZ: "Trigger: z-score доли внимания к монете за 30 дней",
      interactionsZ: "Trigger: z-score логарифма social-взаимодействий за 30 дней",
      socialAccel3hPct: "Trigger: изменение взаимодействий последних 3 часов к предыдущим 3 часам, %",
      interactionsPerContributorZ: "Context: z30d(log1p(interactions / max(active contributors, 1))); высокий уровень может означать концентрацию или накрутку",
      postsPerContributor: "Context: новых публикаций / max(active contributors, 1) в текущем часу",
      socialMinusPriceZ3h: "Trigger: z30d(ускорение interactions за 3h) минус z30d(abs price return за те же 3h); выше 1 означает необычно сильный social относительно одновременного движения цены",
      btcBeta7d: "Context: чувствительность часовых доходностей монеты к BTC за 7 дней",
      btcCorr24h: "Context: корреляция часовых доходностей монеты с BTC за 24 часа",
      btcCorrChange: "Context: корреляция с BTC за 24 часа минус корреляция за 7 дней; отрицательное значение означает расцепление",
      residualLogReturn4hPct: "Context: 100 × [log-return монеты за 4h - beta7d × log-return BTC за 4h]",
      residualZ: "Context: z-score 4-часовой residual log-return за 30 дней",
      rsVsAlts12hPct: "Context: доходность монеты сверх широкого альткоин-сегмента за 12 часов, п.п.",
      sustainedStatus: "Context: persistent — историческая и текущая сила с преимуществом за 7 дней; emerging — текущая сила без всех условий устойчивости; fading — историческая сила без текущей; neutral — критерии силы не выполнены. insufficient_data — любой score недоступен или блок отсутствует; имеет приоритет. Готовый статус учитывает повторяемость и все текущие горизонты на шаге 4, не восстанавливай его по сокращённому набору. Не сигнал входа и не прогноз направления",
      sustainedHistoryScore: "Context: историческая эвристика 0–100 = 100 × среднее долей побед при падении рынка, участия в росте, суточного и недельного преимущества над peers; не вероятность. Доступна при >= 28 суточных, >= 4 недельных, >= 12 медвежьих и >= 12 бычьих окон",
      sustainedCurrentScore: "Context: текущая эвристика 0–100 = 100 × средний поперечный ранг доходности среди peers за 4h, 12h, 24h и 168h; доля уступающих peers плюс половина доли равных. Не вероятность; null при недоступности любого горизонта",
      sustainedDownWinRate: "Context: доля медвежьих окон 4h, когда simple return монеты строго выше медианы peers, 0–1; может означать лишь меньшее падение, не рост",
      sustainedDownPositiveRate: "Context: доля медвежьих окон 4h с положительной simple return самой монеты, 0–1; отличает рост от меньшего падения",
      sustainedDownExcessMedianPct: "Context: медиана разницы simple return монеты и медианы peers на медвежьих окнах 4h, п.п. (исходная разница × 100)",
      sustainedUpParticipationRate: "Context: доля бычьих окон 4h, когда simple return монеты положительна и не ниже медианы peers, 0–1",
      sustainedExcess24hPct: "Context: simple return монеты минус медиана simple return peers за последние 24h, п.п. (исходная разница × 100)",
      categoryMoveAtr: "Narrative: медианная simple return peer-монет категории за 4h / ATR монеты; сама монета исключена, знак показывает направление",
      categoryBreadth: "Narrative: доля peer-монет в направлении медианы категории, чьё 4-часовое движение сильнее предыдущего непересекающегося окна",
      coinLeadAtr: "Narrative: [simple return монеты за 4h - медиана peer-монет] / ATR; отрицательное значение означает отставание",
      flags: "Только активные true-паттерны Divergence и Lifecycle; недоступность category-зависимого laggard показывает categoryStatus",
    },
    flagDefinitions: {
      coiling: "Сжатие, одновременно начинают расти Open Interest и объём",
      attention_ahead: "Эвристика: social-ускорение необычно сильнее одновременного движения цены; временное опережение напрямую не измеряется",
      unconfirmed_move: "Контрсигнал: аномально сильное движение цены за 4h не подтверждается Open Interest и объёмом",
      exhausted_hype: "Внимание высокое, но активность затухает и цена перестала реагировать",
      laggard: "Категория движется, а монета отстаёт",
      resilient: "BTC падает, а монета сохраняет относительную силу",
      squeeze_fuel: "Экстремальный Funding с подтверждённым знаком ставки, высокий Open Interest и согласованный перекос позиционирования создают возможное топливо",
      range_pressure_up: "Давление на верхнюю границу: distanceToHigh24hAtr от 0 до 0.5 включительно, relVolume >= 1.5 и vdShare4h >= 0.1; цена ещё не закрылась выше границы, пробой не подтверждён",
      range_pressure_down: "Давление на нижнюю границу: distanceToLow24hAtr от 0 до 0.5 включительно, relVolume >= 1.5 и vdShare4h <= -0.1; цена ещё не закрылась ниже границы, пробой не подтверждён",
      short_squeeze_setup: "Условия для short squeeze вверх: fundingRate < 0, fundingPctile <= 0.05, oiLevelPctile >= 0.8, oiChange4hPct > 0, vdShare4h >= 0.1; это подготовка, не факт сквиза и не измерение плеча",
      long_squeeze_setup: "Условия для long squeeze вниз: fundingRate > 0, fundingPctile >= 0.95, oiLevelPctile >= 0.8, oiChange4hPct > 0, vdShare4h <= -0.1; это подготовка, не факт сквиза и не измерение плеча",
      fresh_quiet_breakout: "Свежий выход из зрелой тихой базы, который ещё не успел далеко уйти от её границы",
      late_pump: "Цена уже сильно выросла за несколько дней и удерживается около недельного максимума",
      late_dump: "Цена уже сильно снизилась за несколько дней и удерживается около недельного минимума",
    },
    candidates: shortlist.candidates.map(createCandidateRow),
  }

  if (Object.keys(payload.definitions).length !== payload.schema.length) {
    throw new Error("Agent payload schema and definitions have different lengths")
  }

  for (const [index, row] of payload.candidates.entries()) {
    if (row.length !== payload.schema.length) {
      throw new Error(
        `Agent candidate at index ${index} has ${row.length} values for ${payload.schema.length} columns`,
      )
    }

    if (row.some(value => (isNumber(value) || isNaN(value)) && !isFinite(value))) {
      throw new Error(`Agent candidate at index ${index} contains a non-finite number`)
    }
  }

  return payload
}
