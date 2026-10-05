# Модели OpenAI Unofficial

Текстовые вызовы через подписку ChatGPT/Codex, без API-ключа.

## Модели

Справочник на 05.10.2026 по подключённому OpenClaw: `extensions/openai/openclaw.plugin.json` и `model-route-contract.ts`. Это не полный каталог и не подтверждение доступа твоего аккаунта; актуальный список получаем командой ниже.

После `/` — значения `reasoningEffort`, выбираем одно. `null` или отсутствие параметра — настройка модели по умолчанию, не отключение reasoning. `none` — строковое значение, доступное только у указанных моделей.

```text
gpt-5.6-luna / low, medium, high, xhigh, max
gpt-5.6-sol / low, medium, high, xhigh, max, ultra
gpt-5.6-terra / low, medium, high, xhigh, max, ultra
gpt-6-astra / low, medium, high, xhigh, max
gpt-6-luna / none, low, medium, high, xhigh, max
gpt-6-sol / none, low, medium, high, xhigh, max
gpt-6.1-sol / low, medium, high, xhigh, max
```

Не переносим названия из Copilot автоматически: по OpenClaw, `gpt-5.4` и `gpt-5.4-mini` сняты с подписочного Codex-маршрута. Передаём точный ID без префикса `openai/`; `auto` обёртка не реализует.

## Каталог своего аккаунта

Запускать из корня проекта. Первый вызов покажет ссылку и код для входа в ChatGPT. Команда выводит модели и их уровни reasoning; `—` означает использовать `null` или не передавать параметр.

```sh
pnpm exec node --input-type=module <<'JS'
import { getUnofficialOpenAISession } from "./src/api/openai-unofficial/auth.js"

const session = await getUnofficialOpenAISession()
const response = await fetch("https://chatgpt.com/backend-api/codex/models?client_version=0.160.0", {
  headers: {
    "Authorization": `Bearer ${session.token}`,
    "ChatGPT-Account-ID": session.accountId,
  },
  signal: AbortSignal.timeout(30_000),
})
if (!response.ok) {
  throw new Error(`Codex model catalog: HTTP ${response.status}`)
}
const { models } = await response.json()
for (const model of models.filter(model => (!model.visibility || model.visibility === "list") && model.show_in_picker !== false)) {
  const levels = model.supported_reasoning_levels?.map(level => level.effort ?? level)
  console.log(`${model.slug ?? model.id} / ${levels?.join(", ") || "—"}`)
}
JS
```

## Вызов модели

Выбери `model` и `reasoningEffort` из каталога своего аккаунта. Пример ниже использует `gpt-5.6-sol`, если она доступна.

```sh
pnpm exec node --input-type=module <<'JS'
import { callUnofficialOpenAI } from "./src/api/openai-unofficial/chat.js"

const text = await callUnofficialOpenAI("Отвечай кратко.", "Ответь: OK", {
  model: "gpt-5.6-sol",
  reasoningEffort: "medium",
})
console.log(text)
JS
```

Возвращает строку; tools не поддерживает. В `models-in-use.json` и `model-helper.js` пока не подключено — используем прямой вызов. Лимиты подписки сохраняются, перехода на платный API нет.
