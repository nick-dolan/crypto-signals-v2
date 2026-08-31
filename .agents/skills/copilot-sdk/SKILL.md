---
name: copilot-sdk
description: Используй при реализации, ревью, отладке или обновлении официальной интеграции @github/copilot-sdk в crypto-signals-v2, особенно обёртки src/api/copilot/chat.js, сессий, моделей, промптов, разрешений и авторизации.
---

# GitHub Copilot SDK

Работай только с официальным пакетом `@github/copilot-sdk`. Не возвращай внутренние HTTP API Copilot, сторонний OAuth Client ID или собственный обмен токенов.

## Контекст проекта

- Проект использует JavaScript ESM без TypeScript и пакетный менеджер pnpm.
- Сначала сверяй установленную версию в `package.json`; текущий baseline — `@github/copilot-sdk@^1.0.11`.
- Основная точка интеграции — `src/api/copilot/chat.js`.
- Сохраняй интерфейс `callCopilot(systemPrompt, userMessage, { model, reasoningEffort })`, если пользователь явно не попросил изменить его.
- Сценарий проекта — stateless text analysis: строковый промпт на входе, непустая строка на выходе, без агентских инструментов и изменений файлов.

## Источники истины

1. Прочитай `package.json` и текущую обёртку перед изменениями.
2. Проверяй API установленной версии по `node_modules/@github/copilot-sdk/dist/*.d.ts`. Локальные типы важнее старых примеров и статей.
3. При обновлении SDK сверяйся с актуальным репозиторием `https://github.com/github/copilot-sdk` и затем снова проверяй локальные типы.
4. Не копируй устаревшие примеры с `cliUrl`, `cliPath`, `autoStart` или `getModels()` без подтверждения в установленной версии. В `1.0.11` модели запрашиваются через `client.listModels()`, а подключение задаётся через `connection` при необходимости.

## Безопасный baseline

Сохраняй следующие свойства текущей обёртки:

- `CopilotClient({ mode: "empty" })` с явным `baseDirectory` из `COPILOT_HOME` или `~/.copilot`;
- `availableTools: []` и отклонение каждого `onPermissionRequest`;
- выключенные `memory`, `infiniteSessions` и session store;
- отсутствие MCP, custom tools, skills, plugins, config discovery и filesystem access;
- `systemMessage.mode: "customize"` с удалением только нерелевантных agent-секций; не переходи на `replace` без отдельного анализа guardrails;
- ограниченный timeout у `sendAndWait()`;
- `client.stop()` в `finally`;
- проверка, что ответ существует, является строкой и не пуст.

Никогда не используй `approveAll` в этом проекте. Не включай tools, память, хранение сессий или ambient CLI-возможности без явного нового сценария и согласования пользователя.

## Авторизация и секреты

- Авторизацию выполняет официальный Copilot runtime через учётные данные пользователя.
- Не сохраняй GitHub/Copilot-токены в репозитории и не создавай `.github-token.json` или `.copilot-token.json`.
- Не логируй токены, заголовки авторизации или содержимое локального auth-хранилища.
- Учитывай, что `COPILOT_HOME` может указывать на отдельный каталог авторизации Copilot.

## Модели и reasoning

- Перед использованием новых возможностей проверяй их наличие в типах установленной версии.
- Передавай `reasoningEffort` только поддерживающей его модели.
- Если требуется динамическая проверка моделей, используй `client.listModels()` и поле capabilities, а не хардкод предположений.
- Не добавляй параметры OpenAI/Anthropic напрямую, если их нет в конфигурации SDK.

## Проверка изменений

Запускай сначала узкие проверки, затем тесты проекта:

```sh
./node_modules/.bin/eslint src/api/copilot
node --test
```

Не выполняй реальный Copilot-запрос без отдельного согласия пользователя: он требует авторизации и сети и может расходовать лимит Copilot.
