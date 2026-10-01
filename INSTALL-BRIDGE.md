# Установка моста из папки — Windows

Нужны Node.js 24+ и установленный Codex CLI с вашим входом.

1. Сохраните папку `figma-codex-mcp-bridge` в постоянное место. В проекте готовый комплект находится в `transfer/figma-codex-mcp-bridge`. Откройте PowerShell **внутри папки комплекта**, где лежат `package.json` и `dist`.

2. Установите зависимости и навыки:

```powershell
npm.cmd ci --omit=dev
npm.cmd run install:skills
```

3. Подключите мост к Codex:

```powershell
$bridgePath = (Resolve-Path 'dist\bridge\index.js').Path
codex.cmd mcp add figma-codex-local -- node "$bridgePath"
codex.cmd mcp get figma-codex-local
```

4. Перезапустите Codex. Мост будет запускаться автоматически. Папку комплекта после настройки не перемещайте; при переносе повторите шаг 3 с новым путём.

5. Запустите установленный плагин Figma. В чате Codex напишите «Дай код подключения Figma» и вставьте код в плагин. Зелёная точка означает подключение. Дальше код вводить обычно не требуется.

Если `codex.cmd` или `npm.cmd` не найдены, установите Codex CLI или Node.js соответственно и заново откройте PowerShell. Если порт `3846` занят, закройте лишний сеанс Codex.

Полная установка плагина Figma описана в `README.md` внутри комплекта. Команда подключения MCP сверена с [OpenAI Docs](https://learn.chatgpt.com/docs/extend/mcp?surface=cli).
