# Figma Codex MCP Bridge

Личный плагин Figma для управления открытым макетом из основного чата Codex через локальный MCP-мост. [План реализации](IMPLEMENTATION_PLAN.md).

## Статус

Реализованы локальное подключение, код сопряжения и инструменты чтения: `get_file_overview`, `get_node_tree`, `get_node_preview`, `get_local_styles`. Без запущенного плагина инструменты чтения возвращают `NOT_CONNECTED`. Создание и изменение экранов — следующий шаг.

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

Для запуска MCP после сборки: `npm.cmd start`. MCP идёт по stdio; WebSocket для Figma слушает только `127.0.0.1:3846`. В основном чате Codex инструмент `get_pairing_code` выдаёт код, который нужно вставить в окно плагина. Настройка подключения Codex и живая проверка Figma будут добавлены после реализации записей.

Официальные источники: [Codex MCP](https://learn.chatgpt.com/docs/extend/mcp), [Figma manifest](https://developers.figma.com/docs/plugins/manifest/), [Figma UI](https://developers.figma.com/docs/plugins/creating-ui/).
