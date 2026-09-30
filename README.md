# Figma Codex MCP Bridge

Личный плагин Figma для управления открытым макетом из основного чата Codex через локальный MCP-мост. [План реализации](IMPLEMENTATION_PLAN.md).

## Статус

Реализованы локальное подключение, чтение файла, создание и изменение редактируемых экранов. Удаление узла требует подтверждения в окне Figma. В Figma Desktop проверены подключение, чтение файла `Untitled`, создание экрана, изменение текста на «Привет» и удаление двух вспомогательных фреймов после подтверждения. Автоматические проверки прошли. Точное размещение новых экранов с текстом ещё требует проверки.

Проверенная среда: Windows, Node.js 24.16.0, npm 11.13.0, Codex CLI 0.141.0, Figma Desktop 126.9.10. Codex CLI уже авторизован через ChatGPT.

## Установка и проверка

```powershell
npm.cmd ci
npm.cmd run typecheck
npm.cmd test
npm.cmd run build
npm.cmd run smoke:mcp
```

Сборка создаёт `dist/plugin/main.js`, `dist/plugin/ui.html`, `dist/bridge/index.js`. Для локального Codex MCP-сервер уже зарегистрирован как `figma-codex-local`. В другой копии проекта добавьте его командой, указав абсолютный путь к собранному файлу:

```powershell
codex.cmd mcp add figma-codex-local -- node "E:\Codex\figma mcp plugin\dist\bridge\index.js"
codex.cmd mcp get figma-codex-local
```

После настройки перезапустите Codex. Мост запускается им автоматически, говорит с Codex по stdio и слушает Figma только на `127.0.0.1:3846`.

### Подключение Figma Desktop

1. В тестовом Design-файле откройте **Plugins → Development → New plugin → Figma design → Custom UI**. Сохраните новый шаблон в отдельную папку. Figma создаст уникальный `id` и зарегистрирует эту папку. Не используйте ID другого dev-плагина.
2. Выполните `npm.cmd run build`, затем `npm.cmd run install:figma -- "<папка нового плагина>"`. Скрипт возьмёт ID из её `manifest.json`, положит туда собранные файлы и обновит manifest. Указывайте путь, зарегистрированный в Figma. На текущем компьютере это `E:\Codex\v_2`; копия `v_2` внутри проекта Figma не используется.
3. Запустите этот плагин из меню **Plugins → Development**. Повторный импорт из другого manifest с тем же ID не нужен. После каждой правки кода повторите сборку и `install:figma`, затем перезапустите плагин.
4. При первом подключении в основном чате Codex попросите вызвать `get_pairing_code`; вставьте выданный код в окно плагина и нажмите «Подключить». Плагин запомнит код и при следующих запусках подключится сам.
5. Попросите Codex показать страницы, создать экран и изменить текст. Для `delete_node` подтвердите или отмените действие в окне Figma.

Плагин должен оставаться открытым в каждом файле, которым нужно управлять. Мост держит несколько файлов одновременно и получает их названия от Figma. Команды идут в видимую вкладку; если определить её нельзя, мост возвращает `FILE_SELECTION_REQUIRED`. Тогда попросите Codex показать `list_connected_files` и выбрать нужный файл по названию через `select_file`. При совпадающих названиях используйте ID подключения из списка. После перезапуска Codex плагины сами восстановят связь. Код хранится в локальном хранилище Figma и в `%LOCALAPPDATA%\figma-codex-mcp-bridge\pairing-token` на Windows; в репозиторий он не попадает.

Если плагин пишет «Ожидание Codex», а инструменты `figma-codex-local` отсутствуют в чате, проверьте, не запущен ли мост в другом сеансе Codex. Только один процесс может слушать порт `3846`; при занятом порте второй получит `EADDRINUSE`. Закройте лишний сеанс и заново откройте нужный чат.

Для отдельной живой проверки до перезапуска Codex запустите `npm.cmd run live:check`: команда покажет временный код для окна плагина и затем прочитает обзор открытого файла. После проверки соединение закроется, а код перестанет действовать. Для постоянной работы используйте код MCP-сервера, запущенного самим Codex.

### MCP-инструменты

`get_pairing_code`, `list_connected_files`, `select_file`, `get_file_overview`, `get_node_tree`, `get_node_preview`, `get_local_styles`, `create_page`, `create_screen`, `update_node`, `delete_node`.

Первый релиз создаёт фреймы, текст и прямоугольники; не импортирует библиотеки и не создаёт растровые изображения. Отдельные ChatGPT логин и API-ключ в Figma не нужны.

Официальные источники: [Codex MCP](https://learn.chatgpt.com/docs/extend/mcp), [Figma dev-плагины на любом тарифе](https://help.figma.com/hc/en-us/articles/360042786733-Create-a-classic-plugin-for-development), [Figma manifest](https://developers.figma.com/docs/plugins/manifest/), [Figma UI](https://developers.figma.com/docs/plugins/creating-ui/).
