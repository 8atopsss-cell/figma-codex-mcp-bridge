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

### Комплект для передачи

[Краткая установка моста из папки](INSTALL-BRIDGE.md).

Каждая сборка автоматически обновляет `transfer/figma-codex-mcp-bridge`. Эту папку целиком можно передать другому человеку: в ней собранные плагин и мост, зависимости для установки через npm, установщики Figma и навыков, и [инструкция получателю](docs/TRANSFER-README.md). Команда `npm.cmd run package:transfer` также пересобирает комплект.

Все навыки проекта хранятся в `skills/` и автоматически включаются в комплект вместе с дополнительными файлами. Новый навык добавляйте туда. Папка передачи генерируется заново; правки в ней будут заменены следующей сборкой. Исходники упаковки и инструкции хранятся в Git, а сгенерированные файлы — локально. `bundle-info.json` в комплекте содержит дату генерации и контрольные суммы.

### Подключение Figma Desktop

1. В тестовом Design-файле откройте **Plugins → Development → New plugin → Figma design → Custom UI**. Сохраните новый шаблон в отдельную папку. Figma создаст уникальный `id` и зарегистрирует эту папку. Не используйте ID другого dev-плагина.
2. Выполните `npm.cmd run build`, затем `npm.cmd run install:figma -- "<папка нового плагина>"`. Скрипт возьмёт ID из её `manifest.json`, положит туда собранные файлы и обновит manifest. Указывайте путь, зарегистрированный в Figma. На текущем компьютере это `E:\Codex\v_2`; копия `v_2` внутри проекта Figma не используется.
3. Запустите этот плагин из меню **Plugins → Development**. Повторный импорт из другого manifest с тем же ID не нужен. После каждой правки кода повторите сборку и `install:figma`, затем перезапустите плагин.
4. При первом подключении в основном чате Codex попросите вызвать `get_pairing_code`; вставьте выданный код в окно плагина и нажмите «Подключить». Плагин запомнит код и при следующих запусках подключится сам.
5. Попросите Codex показать страницы, создать экран и изменить текст. Для `delete_node` подтвердите или отмените действие в окне Figma.

Плагин должен оставаться открытым в каждом файле, которым нужно управлять. Мост держит несколько файлов одновременно и получает их названия от Figma. Команды идут в видимую вкладку; если определить её нельзя, мост возвращает `FILE_SELECTION_REQUIRED`. Тогда попросите Codex показать `list_connected_files` и выбрать нужный файл по названию через `select_file`. Пока активная вкладка определена, `select_file` не может переключить мост на фоновый файл (`ACTIVE_FILE_ALREADY_DETECTED`). При совпадающих названиях используйте ID подключения из списка. После перезапуска Codex плагины сами восстановят связь. Код хранится в локальном хранилище Figma и в `%LOCALAPPDATA%\figma-codex-mcp-bridge\pairing-token` на Windows; в репозиторий он не попадает.

Для указаний «эта иконка», «этот блок» и «выделенное» Codex сначала проверяет активный файл и выделение. Если ничего не выделено, нужен выбор объекта в Figma; прошлый файл не считается источником. Правило сохранено в [навыке figma-bridge](skills/figma-bridge/SKILL.md).

Перед изменением готовых компонентов Figma, их наборов, вариантов, экземпляров и вложенных слоёв Codex всегда показывает точные правки и запрашивает подтверждение. Правило включает переименование и исправление конфликтов. Уже подтверждённые правки выполняются без повторного вопроса. `update_node` поддерживает переименование COMPONENT и COMPONENT_SET только отдельной правкой `name`.

Если другой сеанс Codex уже занял порт `3846`, новый MCP-процесс остаётся доступным в чате и ждёт освобождения порта. Пока он ждёт, команды возвращают `BRIDGE_PORT_BUSY`. Закройте лишний сеанс; мост поднимется сам, а плагины переподключатся. Для обновления уже запущенного MCP-процесса после сборки требуется заново открыть чат Codex.

Для отдельной живой проверки до перезапуска Codex запустите `npm.cmd run live:check`: команда покажет временный код для окна плагина и затем прочитает обзор открытого файла. После проверки соединение закроется, а код перестанет действовать. Для постоянной работы используйте код MCP-сервера, запущенного самим Codex.

### MCP-инструменты

`get_pairing_code`, `list_connected_files`, `select_file`, `get_file_overview`, `get_node_tree`, `get_node_preview`, `get_node_svg`, `get_local_styles`, `get_variables`, `create_page`, `create_screen`, `update_node`, `delete_node`.

`get_node_tree` includes code-handoff properties under `properties`: structured fills and strokes, per-corner radii, effects, opacity, transforms, auto layout, constraints, typography, and component properties. Mixed text styling is returned as `textSegments`. Read `warnings` before generating code: truncated children or assets and effects that need special handling are reported explicitly. Use `get_node_svg` to export vector layers as SVG assets. `get_local_styles` returns full paint, text, and effect style details. Use `get_node_preview` and compare it with the Storybook render; transferred values alone do not prove visual parity.

Для переноса системы токенов `get_node_tree` возвращает `properties.boundVariables`, `explicitVariableModes` и `resolvedVariableModes`. Схема настроек — `componentPropertyDefinitions` с источником `componentPropertyDefinitionsSource`; выбранные значения — `componentProperties` и `variantProperties`. У экземпляра схема читается из основного компонента или его набора вариантов, а не из названия слоя.

Ошибка отдельного свойства Figma больше не прерывает чтение всего узла: остальные значения возвращаются, а `warnings` содержит имя поля, ID источника и исходное исключение. Отсутствующее поле не заменяется догадкой. Ошибки запроса также передают исходное сообщение вместе с кодом; после обновления перезапустите мост в Codex, чтобы загрузить новый обработчик. Если Figma сообщает `Component set has existing errors`, сначала устраните конфликты вариантов в самом наборе.

`get_variables` читает переменные, коллекции, режимы, значения всех режимов и зависимости алиасов. Передайте `variableIds` из привязок и `nodeId` потребителя: получите цепочки и нативный результат Figma `resolvedForConsumer`. Без `nodeId` другие коллекции используют явно отмеченные режимы по умолчанию; одинаковые названия Light/Dark не связываются автоматически. Список локальных переменных поддерживает `offset`/`limit`; удалённые токены доступны по ID без импорта. Проверяйте `warnings` и `pagination.nextOffset`. [Контракт инструмента и правила переноса](skills/figma-bridge/references/variables.md).

Первый релиз создаёт фреймы, текст и прямоугольники; не импортирует библиотеки и не создаёт растровые изображения. Отдельные ChatGPT логин и API-ключ в Figma не нужны.

Официальные источники: [Codex MCP](https://learn.chatgpt.com/docs/extend/mcp), [Figma dev-плагины на любом тарифе](https://help.figma.com/hc/en-us/articles/360042786733-Create-a-classic-plugin-for-development), [Figma manifest](https://developers.figma.com/docs/plugins/manifest/), [Figma UI](https://developers.figma.com/docs/plugins/creating-ui/).
