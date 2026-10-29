# Приведение Modal dark / Modal light в соответствие

Актуализировано: 2026-10-29, Europe/Moscow. Статус: **ТЕКУЩАЯ СТРУКТУРА НЕ ПОДДЕРЖАНА NATIVE API**. После проверки executionOrder выполнена последняя recovery3/3. Точная ошибка: `Cannot set component property references on slot sublayer` при BOOLEAN Optional label внутри Title SLOT. Последний rollback restored:true относительно непосредственного baseline; light schema{},Title/content FRAME. Исходное приведение не завершено; cap не повышать/receipt не сбрасывать/новым ID не обходить. Read-only inventory65dark+7light выполнен, предложение иной структуры в2026-10-29-modal-api-compatible-structure.md. Структурные изменения обоих master/миграция пока не согласованы; новых nativewrites нет.

## Проверенный источник

Активный файл `SD Enterprice`, страница `UI kit` (`933:24166`). Выделены COMPONENT:

- Эталон: `2046:48406`, `Modal dark`, key `9886a38e657fea3a80287e4791a9cfb884e9654a`.
- Цель: `4745:44256`, `Modal light`, key `e35c53030e90c25ea0b5cfbc8daeeeb5c55c93ec`.

Оба master — 464×216, x72/y118 в разных родителях. Прочитаны полные деревья depth8/limit100 и PNG-превью. Обрезанных потомков нет; VECTOR warnings относятся к SVG-экспорту.

Пользователь поручил привести выбранные родители в соответствие по тёмному эталону. Затем сам удалил непривязанное свойство `content_1#12414:0` и поручил его пропустить. Повторное живое чтение подтвердило удаление: у тёмного два SLOT и три BOOLEAN. Светлый по-прежнему имеет пустую схему.

## Актуальная область после уточнения пользователя

`content_1` исключён. Не добавлять это свойство обратно и не превращать панели кнопок в SLOT. Тёмный master остаётся эталоном без изменений. Светлому добавить два действующих SLOT (Title/content), три BOOLEAN и ранее перечисленные правки layout/типографики/подписей.

Пользовательское «пропусти и продолжай» относится к уже показанным правкам за исключением content_1. Не просить заново согласовать то же назначение/тот же scope. Новые изменения за этими границами требуют отдельной инспекции и согласования. Последующая пауза снята явной командой «продолжай».

## Точные правки светлого master

| Назначение | Тёмный эталон | Светлая цель | Правка |
|---|---|---|---|
| Header | `2418:60886` | `4745:44236` | paddingRight 48 → 56 |
| Title-контейнер | `2046:48403` SLOT | `4745:44237` FRAME | SLOT Title; sizingHorizontal FIXED, layoutGrow0, ширина392 → 384 |
| Optional label | `2046:48404` | `4745:44238` | visible → BOOLEAN Optional label; layoutAlign INHERIT, sizing HUG, textAutoResize WIDTH_AND_HEIGHT |
| Заголовок | `2046:48405` | `4745:44239` | `modal title` → `Modal title` |
| Body-контейнер | `2043:48379` SLOT | `4745:44241` FRAME | SLOT content; visible → BOOLEAN body copy |
| Body-текст | `2043:48383` | `4745:44242` | PT Root UI Regular16/18, paragraphSpacing10, textWrapStyle AUTO, OpenType эталона; сохранить светлый PaintStyle |
| Панель кнопок | `2043:48397` FRAME | `4745:44243` FRAME | Светлый visible → BOOLEAN button bar; оба контейнера остаются FRAME |
| Вторичная кнопка | `2043:48387` | `4936:44979` | Сохранить светлый main `4391:92073`; label → `отменить` |
| Основная кнопка | `2043:48392` | `4936:45014` | Сохранить светлый main `4391:92046`; label → `сохранить` |

Мастера/наборы светлых кнопок не редактировать. Их HUG-размеры пересчитываются по подписям; ожидаемые при одинаковой типографике — 133×32 и142×32. Дополнительная скрытая иконка основной светлой кнопки остаётся частью её существующего master.

## Схема светлого master

Добавить BOOLEAN с defaultValue=true: `Optional label`, `button bar`, `body copy`, соответствующие полным source IDs `Optional label#2046:0`, `button bar#2046:2`, `body copy#2674:0`.

Добавить SLOT с описаниями/preferredValues/slotSettings по тёмному источнику:

- `Title ` ← `Title #12705:1`, привязка `4745:44237`;
- `content ` ← `content #12416:0`, привязка `4745:44241`;

Новые полные property IDs генерирует Figma; сохранить фактическую карту sourcePropertyId → targetPropertyId, не угадывать суффиксы `#`.

## Применение и ограничения

- Сохранить COMPONENT IDs/keys, светлые цвета/PaintStyle/тень и существующие светлые кнопки. Новые masters/варианты и detach не требуются.
- Официальный API позволяет сделать существующий FRAME слотом через `addComponentProperty(name, 'SLOT', '', options)` и `componentPropertyReferences.slotContentId`. Существующие refs видимости сохраняются; контейнеры/дети не пересоздаются. Источник: https://developers.figma.com/docs/plugins/working-with-component-properties/.
- Реализована отдельная ограниченная команда `align_component_schema` / `component.schema.align`, добавляющая BOOLEAN/SLOT и штатные slotContentId-привязки существующим слоям. `update_node` и generic node-properties для этих правок не используются. Preview/apply проверяют snapshots и влияние на экземпляры; произвольного JS нет. Для вызова новая версия плагина/MCP должна быть загружена.
- До применения прочитать связанные экземпляры обоих master через `getInstancesAsync`, проверить содержимое/overrides и влияние на них. Изменение master распространяется на экземпляры.
- После точного подтверждения и появления команды: preview → повторная проверка активного файла → apply неизменного запроса → readback схем/refs/types/геометрии/IDs/стилей/экземпляров → повторный план совместимости. Визуальное принятие — за пользователем.
- Перевод конкретного окна и дальнейшие тематические замены не входят в это приведение схем.

## Точка остановки

- Текущая выборка: только светлый COMPONENT `4745:44256`, файл `SD Enterprice`, страница UI kit. При возобновлении заново проверить активный файл, selection и оба master по ID.
- Недостающая команда схемы ещё не реализована. Начата подготовка интерфейса `align_component_schema` / `component.schema.align`: exact source/target, bindings по полным sourcePropertyId → targetNodeIds, ограниченные копируемые поля из sourceNodeId → targetNodeId, preview/apply, expectedState, durable receipt и анализ target.getInstancesAsync.
- Предложенные модули `src/shared/component-alignment.ts`, `src/plugin/component-alignment.ts` и тесты `tests/component-alignment*.ts` **не созданы** на момент паузы; Git status/проверка путей это подтвердили. Протокол/MCP под эту команду пока не менялись. Делегированная работа прервана.
- Последняя завершённая версия остаётся прежней: 231 тест / 28 файлов, typecheck/build/MCP smoke и transfer-проверка пройдены на предыдущем этапе. После этого менялись только план/лог; новые проверки реализации не заявляются.
- После явного возобновления: реализовать ограниченную команду через TDD, подключить протокол/MCP, проверить воздействие на связанные экземпляры, сборку и transfer. Затем загрузить новую команду в плагин, выполнить fresh preview и согласованное применение, прочитать фактические свойства/refs/IDs/стили/экземпляры и повторить проверку совместимости.
- Commit/push/merge не выполнять без отдельной прямой команды. «Зафиксируй прогресс» означает этот checkpoint и дневной лог.

## Продолжение после паузы

- Повторно проверены активный файл `SD Enterprice` и полные деревья обоих master. Dark — три BOOLEAN и два SLOT, Light — пустая схема. content_1 отсутствует. Текущая выборка изменена пользователем на dark-кнопку `2043:48392`; задача остаётся привязанной к согласованным master IDs, эта кнопка не стала новым самостоятельным источником.
- Рабочее дерево перед началом продолжения чистое; ветка `feat/figma-mcp-bridge`, после fetch отставание/опережение origin — `0 0`.
- Реализуется ограниченная команда `align_component_schema` / `component.schema.align`, без произвольного JS. Отдельный reviewable запрос: `2026-10-28-modal-light-alignment.request.json`; не включает content_1 и не изменяет dark.
- Сначала red-тесты протокола/MCP/dispatch, затем реализация. Live apply возможен после сборки и загрузки новой версии плагина/MCP; прежнее согласование точных правок сохраняется.

## Реализация после возобновления

- [x] `componentAlignmentSchema` и `alignComponent`, exact source/target/bindings/field pairs. Пять нативных свойств, сохранение IDs/children/key/светлых paints/main links, реальная FRAME→SLOT-конверсия без пересоздания узлов.
- [x] Протокол, очереди записи plugin/MCP, pin активного файла до ожидания, endpoint с `destructiveHint:true` для готового master. Инструкция и скилл описывают явное согласование; прежняя точная авторизация действует.
- [x] Проверка live instance impact и наследования, сохранение custom overrides/text/slots. Fonts до первого изменения. Полные snapshots/keys/metadata, async main links и ограниченные изменения native geometry.
- [x] Durable receipts/chunks/replay/conflicts, ограничения pluginData до записи, ownership-safe rollback и точный отчёт невосстановленных экземпляров. Native inverse не объявляется гарантированно атомарным.
- [x] Регрессии native SLOT без defaultValue, hanging typography, font loading для textAutoResize, matrix translations, autoRename, наследование SLOT/refs/типографики и новые overrides запрошенных подпись-кнопок.
- [x] Полный тестовый набор после live-исправления variant schema: 253 теста / 31 файл. Typecheck пройден. Предыдущие review замечания исправлены; live-применение не выполнено.
- [x] Build и MCP smoke пройдены, скилл установлен. Transfer проверен: 17 файлов, SHA-256/точный состав, пять совпадающих файлов скилла в source/global/bundle, отсутствие персональных файлов и сохранение корневого manifest ID/путей.
- [x] Загрузить endpoint в MCP и проверить связь с плагином после пользовательского перезапуска.
- [x] Пользователь перезапустил Figma-плагин после исправления variant schema. Повторный preview выполнен; остановлен до записи на недоступном локальном master скрытой иконки.
- [ ] Применить уже согласованный запрос без content_1, прочитать новый propertyMap/схемы/refs/превью и проверить совместимость. Master в живой Figma пока не изменён.

## Актуальная пауза после живой проверки

Историческая пауза снята следующей прямой командой пользователя. Текущий ремонт согласован: см. `2026-10-28-icon-reference-repair.md` и соответствующий JSON запроса. Ниже сохранены исходные наблюдения блокера.

Endpoint и исправленный плагин загружены. Согласованный JSON с operationId `modal-light-align-20261028-v1` пока запускался только с dryRun:true; expectedState не получен, apply не вызывался, Figma не изменялась.

Новый точный блокер: `PRESERVATION_UNSUPPORTED`, nodeId `I4936:45014;9552:17590`, reason `Main component unavailable`. Это скрытый INSTANCE `icon wrapper 01` внутри primary light button `4936:45014`. Живое чтение: main `9552:17581`, parent set `9552:17580`; набор доступен по ID, removed:false, но parent:null, вне дерева документа. Его вложенная иконка в экземпляре переопределена на add. Это не отсутствие endpoint и не ошибка чтения variant schema.

Не удалять скрытый слой, не менять его main/кнопочный master и не обходить проверку сохранности: прежний scope требует сохранить существующие светлые кнопки и скрытую иконку. Ремонт этой связи отдельно не согласован. После прямого возобновления — перепроверить live состояние; если блокер сохраняется, показать точный вариант ремонта и влияние, получить согласование расширения scope до каких-либо правок. Затем свежий preview того же запроса/operationId, complete instanceImpact, apply с фактическим expectedState только в согласованном scope, readback/совместимость/PNG.

Последние проверки кода: 253 tests/31 files, typecheck/build/MCP smoke — успешно. Transfer 17 файлов: SHA-256, точный состав, project skills и отсутствие приватных путей проверены; root manifest ID сохранён. После этого менялись только checkpoint/дневной лог. Commit/push/merge не выполнялись.
