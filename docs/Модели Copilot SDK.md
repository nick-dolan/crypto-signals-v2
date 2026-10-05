# Модели Copilot SDK

Срез на 05.10.2026 для текущего аккаунта (`@github/copilot-sdk` 1.0.16).
Источник — каталог сессии SDK; `client.listModels()` возвращает неполный список.

После `/` — допустимые значения `reasoningEffort`, выбираем одно. `—` — не передавать параметр (в `models-in-use.json` — `null`); `none` — строковое значение. `auto` — автоматический выбор модели.

```text
auto / —
claude-fable-5 / low, medium, high, xhigh, max
claude-fable-5.1 / low, medium, high, xhigh, max
claude-haiku-4.5 / —
claude-opus-4.8 / low, medium, high, xhigh, max
claude-opus-4.8-fast / low, medium, high, xhigh, max
claude-opus-5 / low, medium, high, xhigh, max
claude-opus-5.5 / low, medium, high, xhigh, max
claude-sonnet-5 / low, medium, high, xhigh, max
claude-sonnet-5.5 / low, medium, high, xhigh, max
gemini-3.7-flash / low, medium, high
gemini-3.8-flash / low, medium, high
gpt-5-mini / low, medium, high
gpt-5.3-codex / low, medium, high, xhigh
gpt-5.4 / none, low, medium, high, xhigh
gpt-5.4-mini / none, low, medium, high, xhigh
gpt-5.5 / none, low, medium, high, xhigh
gpt-5.6-luna / none, low, medium, high, xhigh, max
gpt-5.6-sol / none, low, medium, high, xhigh, max
gpt-5.6-terra / none, low, medium, high, xhigh, max
gpt-6-astra / low, medium, high, xhigh, max
gpt-6-luna / none, low, medium, high, xhigh, max
gpt-6-sol / none, low, medium, high, xhigh, max
gpt-6.1-sol / none, low, medium, high, xhigh, max
grok-4.5 / low, medium, high
grok-4.6 / low, medium, high, xhigh
grok-4.7 / low, medium, high, xhigh
kimi-k3 / low, high, max
mai-code-1.1-flash / low, medium, high
```
