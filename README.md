# Figma Codex MCP Bridge

Личный плагин Figma для управления открытым макетом из основного чата Codex через локальный MCP-мост. [План реализации](IMPLEMENTATION_PLAN.md).

## Статус

Создан каркас: MCP-сервер по stdio, один инструмент `get_file_overview`, окно статуса плагина и сборка. Инструмент пока возвращает `NOT_CONNECTED`; связь с Figma и изменения макета будут добавлены следующими шагами.

Проверенная среда: Windows, Node.js 24.16.0, npm 11.13.0, Codex CLI 0.141.0, Figma Desktop 126.9.10. Codex CLI уже авторизован через ChatGPT.

## Проверка каркаса

```powershell
npm.cmd ci
npm.cmd run typecheck
npm.cmd test
npm.cmd run build
npm.cmd run smoke:mcp
```

Сборка создаёт `dist/plugin/main.js`, `dist/plugin/ui.html`, `dist/bridge/index.js`. `manifest.example.json` — образец: настоящий `manifest.json` создаётся после получения личного ID через Figma → Plugins → Development → New plugin.

Для запуска MCP после сборки: `npm.cmd start`. Процесс работает по stdio, ждёт подключения MCP-клиента и не выводит протокол в терминал. Настройка подключения Codex появится после реализации моста.

Официальные источники: [Codex MCP](https://learn.chatgpt.com/docs/extend/mcp), [Figma manifest](https://developers.figma.com/docs/plugins/manifest/), [Figma UI](https://developers.figma.com/docs/plugins/creating-ui/).
