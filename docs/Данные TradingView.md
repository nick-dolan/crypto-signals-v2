# Данные TradingView

TradingView позволяет получать историю свечей и индикаторов на выбранном таймфрейме. Premium-аккаунт позволяет одновременно добавить к одному графику до 25 studies: один study может вернуть несколько plots или OHLC.

Живой тест через `@mathieuc/tradingview` подтвердил эту границу: 25 studies работают, 26-й отклоняется. Но никто не мешает запросить несколько раз по 25 если нужно!

Источники индикаторов:

- встроенные индикаторы TradingView;
- публичные Pine-индикаторы;
- наши приватные Pine-индикаторы.

Важно: таймфрейм графика и реальная частота обновления исходных данных — не одно и то же. Например, on-chain показатель можно запросить на `1h`, но если источник обновляется раз в сутки, одно дневное значение просто повторится на часовых барах.

## Что доступно

В публичном каталоге TradingView есть 123 ID встроенных crypto-specific fundamental studies:

| Группа | Количество | Обычная частота |
|---|---:|---|
| Derivatives | 21 | intraday |
| Social | 9 | преимущественно intraday |
| Network / on-chain | 76 | преимущественно `1D` |
| Ownership / ETF | 13 | преимущественно `1D` |
| Valuation / supply | 4 | `1D` |

Эти 123 ID не означают 123 независимых сигнала. Каталог содержит варианты `agg/noagg`, native/USD и ratio/%, которые частично дублируют друг друга. Таблица выше отражает нашу практическую группировку. Официальная разбивка TradingView: Derivatives — 21, Network — 76, Social — 9, Ownership — 9, Statistics — 4, Financials — 4.

Отдельно доступны стандартные технические и объёмные индикаторы, публичные Pine-индикаторы и наши private studies.

## Рыночные данные

Можно получать исторические данные:

- свечи OHLCV;
- цены и объёмы BTC и ETH;
- капитализация отдельных монет и рынка;
- TVL;
- BTC, ETH и USDT dominance;
- общая капитализация рынка и её составные части;
- отдельные spot и perpetual инструменты.

На основе этих данных самостоятельно рассчитываем корреляцию с BTC, относительную силу, рыночную ширину и распространение движения внутри категорий монет.

### Структура рынка CRYPTOCAP

Используем четыре вложенных индекса:

| Символ TradingView | Что содержит |
|---|---|
| `CRYPTOCAP:TOTAL` | капитализация top-125 криптоактивов |
| `CRYPTOCAP:TOTALES` | рынок без стейблкоинов |
| `CRYPTOCAP:TOTAL2ES` | рынок без BTC и стейблкоинов |
| `CRYPTOCAP:TOTAL3ES` | рынок без BTC, ETH и стейблкоинов |

Из них на совпадающих временных точках рассчитываем отдельные сегменты:

```text
Stablecoins = TOTAL - TOTALES
BTC         = TOTALES - TOTAL2ES
ETH         = TOTAL2ES - TOTAL3ES
Other alts  = TOTAL3ES
```

Вложенность этих четырёх индексов подтверждена живыми данными. Вычитать нужно синхронные значения одного типа, обычно `close`. Нельзя получать `high` или `low` сегмента простым вычитанием `high` или `low` двух индексов.

Для каждого сегмента рассчитываем изменение за `1h`, `4h` и `12h`, ускорение, волатильность и изменение его доли в рынке. Это даёт признаки ротации между стейблкоинами, BTC, ETH и остальными альткоинами. Для отдельных монет также сравниваем движение, относительную силу и корреляцию с `TOTAL3ES`.

Отдельный `CRYPTOCAP:BTC`, готовые показатели соотношений `TOTAL3ESBTC` и `OTHERSBTC`, а также производные показатели доминирования для этой задачи не обязательны: их значения можно рассчитать из исходных временных рядов. Изменение общей капитализации стейблкоинов используем как медленный режимный контекст, а не как основной часовой триггер.

Дополнительные кандидаты:

- `CRYPTOCAP:TOTALE50` — экспериментальный proxy аппетита к более мелким монетам;
- `CRYPTOCAP:TOTALDEFI` — контекст для DeFi narrative на более позднем этапе.

Пока не берём:

- `CRYPTOCAP:OTHERS` — состав top-10 меняется, а оставшаяся часть рынка не очищена от всех стейблкоинов;
- `CRYPTOCAP:TOTALE100` — слишком маленький и шумный хвост рынка;
- `TOTAL2` и `TOTAL3` без суффикса `ES` — в них остаются стейблкоины.

Изменение market cap не означает буквальный приток или отток денег: оно прежде всего отражает изменение цены и supply, а также может зависеть от состава индекса. Поэтому эти признаки трактуем как proxy рыночного режима и ротации.

### Метаданные и текущие котировки Quote

Через Quote в `@mathieuc/tradingview` доступны текущие снимки по `CRYPTO:<coin>USD`:

- `circulating_supply`, `total_supply` и `max_supply`;
- market cap и fully diluted valuation;
- `24h_vol_cmc`;
- `crypto_categories` и `typespecs`.

В realtime Quote также приходят `bid`, `ask`, `bid_size`, `ask_size` и `lp_time`. Исторического backfill для этих полей нет: их можно только накапливать вперёд, а размеры заявок нужно нормализовать перед сравнением монет и площадок.

### Дополнительные обычные символы

Обычные символы TradingView дают ещё несколько кандидатов:

- spot/perpetual цены разных бирж — для самостоятельного расчёта basis и межбиржевой dispersion;
- `CRYPTOCAP:USDT` и `CRYPTOCAP:USDC` — отдельный медленный контекст стейблкоинов;
- `TVC:DXY`, `TVC:US02Y`, `TVC:US10Y`, `CME_MINI:NQ1!`, `CME_MINI:ES1!`, `OANDA:XAUUSD` и один заранее выбранный источник VIX (`CBOE:VIX` или `TVC:VIX`) — cross-asset контекст;
- `CME:BTC1!`, `CME:BTC2!`, `CME:ETH1!` и `CME:ETH2!` — экспериментальный контекст срочного рынка.

USD и USDT-инструменты, а также данные разных бирж нельзя сравнивать без нормализации. Эти источники не включаем автоматически в первый MVP.

## Derivatives

### Основные метрики

- Open Interest: агрегированный по рынку и отдельный по бирже;
- Funding Rate: агрегированный по рынку и отдельный по бирже;
- Liquidations: агрегированные и отдельные по бирже, long и short;
- Long / Short Ratio Accounts;
- Long / Short Accounts %;
- Premium;
- Basis;
- Mark Price;
- Index Price;
- Top Traders Long / Short Accounts;
- Top Traders Long / Short Positions.

### Формат и покрытие

- Open Interest, Premium, Basis, Mark Price и Index Price возвращают OHLC; Liquidations — отдельные временные ряды long- и short-ликвидаций.
- OI и ликвидации могут измеряться в base asset, quote asset или contracts, поэтому межбиржевое сравнение требует нормализации.
- Premium, Basis, Mark Price, Index Price и Top Traders studies в каталоге привязаны к Binance.
- Long / Short Accounts доступны для Binance и Bybit.
- Агрегированный Funding Rate охватывает Binance, Bitget, Bybit, Coinbase, Deribit, HTX, Kraken и OKX.
- Агрегированные Liquidations охватывают Binance, Bybit, Deribit, HTX и OKX.
- Accounts ratio выводится из long/short %, а Top Traders ratios — из соответствующих процентов; отдельные дубли хранить не нужно.

Агрегированный Funding Rate взвешивается по Open Interest. Сравнение агрегированного рынка с отдельной биржей позволяет оценивать концентрацию позиций, funding и ликвидаций.

Наиболее полезные сочетания:

- цена и изменение OI;
- OI и realised volatility;
- funding и OI;
- ликвидации относительно OI;
- агрегированный рынок относительно отдельной биржи;
- обычные аккаунты относительно top traders;
- направление аккаунтов относительно размера их позиций;
- Premium относительно собственной истории.

Premium — относительное отклонение futures price от index price. Он лучше подходит для сравнения разных монет. Basis показывает абсолютную разницу цен и требует нормализации.

### Обычные символы деривативных метрик

Часть метрик доступна как обычные символы и не занимает study-слоты. Подтверждены:

- Open Interest: `BINANCE:BTCUSDT.P_OI`, `BYBIT:BTCUSDT.P_OI` и `OKX:BTCUSDT.P_OI`;
- Funding Rate: суффикс `_FR` у perpetual-инструментов Binance, Bybit, OKX, Bitget, HTX и Deribit;
- Binance Premium, Mark Price и Index Price: суффиксы `_PREMIUM`, `_MPRICE` и `_IPRICE`.

Для каждой биржи отдельно проверяем покрытие, валюту и единицы измерения.

### Ожидаемая волатильность опционов

`DERIBIT:DVOL` и `DERIBIT:ETHDVOL` дают часовые OHLC ожидаемой волатильности BTC и ETH. Это приоритетный экспериментальный признак режима, но агрегированный proxy, а не полноценная options chain.

## Направленный объём и order flow

### Volume Delta

`Volume Delta` — главный дополнительный встроенный индикатор для часового сбора. Живым запросом подтверждён ID `STD;Volume%1Delta` версии `8.0`. Он возвращает plots `plotcandle_0_ohlc_open`, `plotcandle_0_ohlc_high`, `plotcandle_0_ohlc_low` и `plotcandle_0_ohlc_close`, а также три служебных colorer-плота, которые не сохраняем. На `1h` TradingView анализирует более мелкие intrabars и возвращает для каждого часа:

- `open`, который всегда равен нулю и не является содержательной «начальной delta»;
- максимальную delta;
- минимальную delta;
- итоговую delta.

Это добавляет информацию о внутрибарном балансе объёма, которой нет в обычной часовой свече.

Для графика `1h` TradingView автоматически использует `1m` intrabars. Живой тест вернул 1 668 полных часовых баров — около 69,5 дня. Более крупный intrabar увеличивает доступную глубину истории ценой меньшей точности delta.

Запрос большего числа баров не даёт больше данных: при 5 758 барах заполненными остаются всё те же 1 668, а остальные приходят пустыми. Поэтому для Volume Delta ограничиваем range или явно разрешаем пропуски.

TradingView оценивает направление объёма по движению цены на младших барах. Это не настоящий aggressor buy/sell volume из биржевого стакана.

### Другие доступные индикаторы

- Cumulative Volume Delta;
- Up / Down Volume;
- Relative Volume at Time;
- 24-hour Volume;
- Volume Profile;
- Volume Footprint;
- TPO;
- VWAP и VWMA.

CVD можно рассчитать из Volume Delta. Up / Down Volume можно восстановить из обычного volume и delta. Relative Volume at Time, VWAP и VWMA рассчитываются из сохранённых OHLCV.

Volume Profile, Footprint и TPO содержат полезную информацию о распределении объёма по цене, но возвращают сложные профили или графические структуры, а не простой ряд значений. Их можно исследовать позже.

## Social

Историей доступны:

- AltRank;
- Galaxy Score;
- Social Dominance %;
- Sentiment %;
- Interactions;
- Active Contributors;
- Created Contributors;
- Active Posts;
- Created Posts.

Все 9 social studies вернули часовые ряды для BTC; такое же покрытие подтверждено для ETH, SOL, DOGE, SUI и `1000SATS`. В живом тесте получено не менее 5 100 последовательных часов. TradingView не закрепляет одного поставщика за всем разделом и может использовать Glassnode, CoinMetrics, LunarCrush и DefiLlama, поэтому покрытие проверяем отдельно для каждой монеты.

Для раннего предупреждения наиболее важны сырые показатели внимания:

- Social Dominance;
- Interactions;
- Contributors;
- Posts.

Полезные сочетания:

- social растёт, а цена ещё стоит;
- interactions растут быстрее contributors;
- created posts растут быстрее active posts;
- social attention ускоряется сразу у нескольких монет одной категории.

AltRank и Galaxy Score уже смешивают social и рыночные данные, поэтому их нужно оценивать отдельно от сырых social-метрик.

## Network и on-chain

### Активность сети

- Addresses with Balance;
- Active Addresses;
- Active Addresses with Contracts;
- New Funded Addresses;
- Sending и Receiving Addresses;
- Transaction Count и Transaction Rate;
- Transaction Volume;
- Average Transaction Volume;
- Large Transaction Count;
- Large Transaction Volume;
- Transaction Fees;
- Transfer Count и Transfer Rate;
- Total Value Locked.

Large Transaction Volume учитывает транзакции от `$100 000` и может отражать активность крупных участников.

### Поведение держателей и supply

- Spent Output Profit Ratio;
- Realized Market Cap;
- RVT Ratio 90 Days;
- Supply Equality Ratio;
- 1 Year Active Supply %;
- количество адресов выше заданной доли supply;
- количество токенов на крупных адресах.

### Специализированные сетевые данные

- total, mean и median gas used;
- mean и median gas price;
- mean и median gas limit;
- Ethereum staking deposits, depositors и value staked;
- UTXO created / spent и их объёмы;
- hash rate и difficulty;
- block interval, block size и blocks mined.

Большинство временных рядов on-chain-метрик в TradingView фактически обновляется раз в сутки. Для горизонта `4–12h` это дополнительный контекст, а не основной триггер.

Native/USD варианты есть не только у ETF, но и у transaction, transfer и UTXO volumes, fees, gas price и staking value. Это разные представления одного события, а не независимые сигналы. Предпочтительнее хранить native-вариант и при необходимости переводить его в USD самостоятельно.

### Низкоприоритетные метрики каталога

Дополнительно доступны Total Addresses, mean/median Transaction Fees, mean/median Transfer и UTXO metrics, а также El Salvador Government BTC balance. Они не выглядят сильными часовыми триггерами. Power-Law и Stock-to-Flow тоже не приоритизируем: это модельные оценки, а не новые наблюдаемые данные.

## ETF

Для BTC и ETH доступны:

- суммарные US spot ETF balances;
- суммарные US spot ETF flows;
- balances отдельных фондов;
- flows отдельных фондов;
- значения в native units и USD.

ETF Flow — оценка дневного изменения количества актива в фондах. Native-вариант предпочтительнее: USD-вариант дополнительно зависит от уже известного движения цены.

ETF-данные подходят как режимный контекст для BTC и ETH, но обновляются слишком редко для основного часового сигнала.

## Private и public индикаторы

### Crypto USD Liquidity Delta

Наш private study, доступный только авторизованному TradingView-аккаунту. Его можно получать в виде исторического ряда так же, как остальные индикаторы.

### Public Pine indicators

Публичные Pine-индикаторы можно использовать наравне со встроенными. Перед включением фиксируем их ID и версию, чтобы расчёт оставался воспроизводимым.

Особенно интересны public-индикаторы, которые:

- используют дополнительные ряды данных TradingView;
- объединяют несколько рынков или источников;
- дают данные, которые нельзя восстановить из наших часовых OHLCV;
- формализуют полезный сигнал понятным и проверяемым способом.

## Ограничения способа получения

В `@mathieuc/tradingview` практически подтверждены chart, studies, symbol search и Quote. Пакет не используем для полноценной выгрузки screener top values, календаря или crypto options chain. Для опционного контекста пока используем DVOL.

## Что рассчитываем самостоятельно

Не загружаем из TradingView отдельные ряды для показателей, которые полностью рассчитываются из уже сохранённых данных:

- realised volatility и её сжатие;
- ATR и Bollinger Bandwidth;
- relative volume;
- Cumulative Volume Delta;
- Up / Down Volume;
- VWAP и VWMA;
- RSI, MACD и другие обычные технические индикаторы;
- изменение, скорость и ускорение метрик;
- rolling percentile и z-score;
- корреляцию и изменение корреляции с BTC;
- residual strength;
- рыночную ширину;
- распространение narrative внутри категорий.

## Приоритет для прогноза движения через 4–12 часов

### Основной часовой слой

- OHLCV;
- Volume Delta;
- агрегированный и биржевой Open Interest;
- агрегированный и биржевой Funding Rate;
- агрегированные и биржевые Liquidations;
- Premium;
- Long / Short Ratio Accounts;
- Top Traders Long / Short Positions;
- сырые social-метрики для монет с подтверждённым покрытием;
- Crypto USD Liquidity Delta;
- рыночный контекст `TOTAL`, `TOTALES`, `TOTAL2ES` и `TOTAL3ES`.

### Экспериментальный часовой слой

- `DERIBIT:DVOL` и `DERIBIT:ETHDVOL`;
- Basis;
- Top Traders Accounts;
- spot/perpetual и межбиржевая ценовая dispersion;
- bid/ask и размеры заявок, накапливаемые вперёд;
- AltRank;
- Galaxy Score;
- Sentiment;
- `TOTALE50`;
- cross-asset символы и CME futures curve;
- подходящие public Pine-индикаторы.

### Справочный и медленный контекст

- supply, market cap, FDV и категории из Quote;
- отдельные капитализации USDT и USDC;
- 24-hour snapshot volume как контрольная метрика, а не замена нашим OHLCV.

### Дневной контекст

- Market Cap и TVL;
- Active и New Addresses;
- Transaction Count и Volume;
- Large Transactions;
- Transaction Fees;
- SOPR;
- ETF Flows;
- gas и Ethereum staking.

## Основные источники

- [Каталог встроенных fundamental studies](https://pine-facade.tradingview.com/pine-facade/list?filter=fundamental)
- [Total market cap top-125](https://www.tradingview.com/support/solutions/43000723016-total-market-cap-chart/)
- [TOTAL2ES](https://www.tradingview.com/symbols/CRYPTOCAP-TOTAL2ES/)
- [TOTAL3ES](https://www.tradingview.com/symbols/CRYPTOCAP-TOTAL3ES/)
- [Dominance by market cap](https://www.tradingview.com/support/solutions/43000723023-dominance-by-market-cap/)
- [Crypto Open Interest](https://www.tradingview.com/support/solutions/43000762388/)
- [Funding Rate](https://www.tradingview.com/support/solutions/43000762390/)
- [Liquidations](https://www.tradingview.com/support/solutions/43000762400/)
- [Long / Short Ratio Accounts](https://www.tradingview.com/support/solutions/43000762399/)
- [Premium](https://www.tradingview.com/support/solutions/43000784535-premium/)
- [Basis](https://www.tradingview.com/support/solutions/43000784536-basis/)
- [Volume Delta](https://www.tradingview.com/support/solutions/43000725057-volume-delta/)
- [Cumulative Volume Delta](https://www.tradingview.com/support/solutions/43000725058-cumulative-volume-delta/)
- [Relative Volume at Time](https://www.tradingview.com/support/solutions/43000705489-relative-volume-at-time/)
- [Large Transaction Volume](https://www.tradingview.com/support/solutions/43000773993-large-transaction-volume/)
- [Transaction Fees](https://www.tradingview.com/support/solutions/43000773997-transaction-fees/)
- [US Spot Crypto ETF Flows](https://www.tradingview.com/support/solutions/43000778589-us-spot-crypto-etf-flows/)
- [Bitcoin DVOL](https://www.tradingview.com/symbols/DERIBIT-DVOL/)
- [Ethereum DVOL](https://www.tradingview.com/symbols/DERIBIT-ETHDVOL/)
