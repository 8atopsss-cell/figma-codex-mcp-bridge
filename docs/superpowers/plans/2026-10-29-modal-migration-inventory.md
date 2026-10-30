# Modal: инвентаризация миграции, только чтение

Источник: root-agent capture `2026-10-29 14:11:23 UTC`, SD Enterprice, UI kit `933:24166`. Masters: dark `2046:48406`, light `4745:44256`. SHA-256 снимка: `929576aa07f8e6f05f10f5d534f59fed2a70ad8c208d99a086587362783ebd06`. Инвентаризация Figma не изменяла. Предложения типизированы, не утверждены, `executable:false`.

Native `instanceInventory.complete:true` подтверждён для обоих masters до и после чтения всех 72 экземпляров: 65 dark, 7 light. ID совпадают с прочитанными строками. Membership snapshots совпали:

| Master | Count | Membership snapshot SHA-256 |
| --- | ---: | --- |
| `2046:48406` | 65 | `d6a675aec2a580878b340baa5d1223d8d3658fe860452269bf501a84222ee561` |
| `4745:44256` | 7 | `dea7f8ae96112a25922f8aba28c64cc01fff32e643dbfc0b823203ed0f711945` |

Эти snapshots связывают owner и множество instance IDs. Они не подтверждают неизменность contents/overrides. Содержимое получено отдельными RPC; capture не атомарный. Все 72 текущих Title subtree полные; 159 TEXT. Точное сравнение с capture `13:31:12 UTC` не выявило различий общих полей обоих master trees и 72 root/header/Title. Новые поля `overrides`/`instanceInventory` — ранее недоступные доказательства, не доказательство прежней пустоты.

На всех 72 root INSTANCE прочитаны native `properties.overrides`: 651 record, 1484 вхождения полей. Каждый record сохранён целиком как `{id, overriddenFields}`. Частоты считаются по records, не по уникальным экземплярам:

| Scope record ID | Records | Доступность текущих значений |
| --- | ---: | --- |
| root INSTANCE | 71 | Root metadata прочитаны |
| header | 46 | Header metadata прочитаны |
| текущий Title subtree | 99 | Полный subtree прочитан |
| точная native Title lineage вне текущего Title subtree | 35 | Текущие значения этих ID не прочитаны |
| прочие ID | 400 | Данный отчёт не содержит полных значений этих узлов |

Частые поля: `layoutAlign` 205; `characters` и `styledTextSegments` по 199; `counterAxisSizingMode` 104; `componentProperties` 101; `fillStyleId` 86; `height` и `width` по 72. Все частоты, включая header/Title, — в JSON. Для 180 header/Title records сохранены точные индексы в массиве overrides соответствующего instance; из них 145 относятся к прочитанным текущим узлам, 35 — только к точной native lineage вне прочитанного Title. Наличие этих 35 записей не доказывает удаление узлов и не связывает их с custom children. Native overrides перечисляют поля, не значения и не полную историю содержимого. Недоступное поле никогда не считается пустым массивом.

Native Optional/Title lineage доказана у 26 dark и 7 light: точные derived IDs, main/schema owner; dark также BOOLEAN visible ref. У 39 dark роли текущих custom children остаются неразрешёнными. Имена, текст, порядок и скрытость не использованы как доказательство. Светлая схема пуста; видимость точного native Optional child: 4 false, 3 true.

JSON содержит два типа предложений:

- `NativeOptionalTitleCorrespondence`, 33 случая: Optional → обычный TEXT внешнего HeaderContent, Title → содержимое Title SLOT. Только семантическая карта; будущие derived IDs, допустимость reparent и сохранение native overrides ещё не доказаны.
- `PreserveEntireTitleSubtree`, 39 случаев: сохранить весь прежний Title subtree единым целым, включая структуру, текстовые хеши, видимость, geometry, стили и mixed ranges. Стратегия внешнего Optional — `unapproved_unresolved`, выбранное решение отсутствует. Автоматически делить или сопоставлять children нельзя.

Из 39 custom случаев `Optional=true` у пяти: `11248:25020`, `14690:39531`, `15056:66670`, `15277:117573`, `8321:115168`. Слепое добавление внешнего Optional может дублировать подпись. BOOLEAN не доказывает роль существующих children; остальные 34 также требуют решения.

15 dark Title содержат по 3 TEXT. У 8 случаев height 48 / lineHeight 24 / autoResize HEIGHT без hard newlines: кандидаты на перенос; точное число rendered lines не экспортировано. У `3178:69616` mixed paints/styles сохранены через точные textSegments. Прямые children header совпадают с native lineage у всех 72. Nested close content в per-instance capture не входит. Визуальной проверки и принятия нет.

Перед production-записью: решить внешний Optional для 39 custom случаев; проверить отдельный разрешённый scratch probe и каждый его результат; прочитать значения затрагиваемых узлов вне текущих Title; обновить membership/content/overrides; предъявить точный diff masters и каждого instance; получить explicit approval именно этих изменений. Этот отчёт не утверждает успешность scratch probe. Прежний `modal-light-align-20261028-v1` остаётся incomplete, recovery 3/3; его apply/reset/new ID не выполнялись.

Точные ID, geometry, visibility, Boolean values, paints/styles, bindings, mixed ranges, content hashes и native overrides: [JSON](2026-10-29-modal-migration-inventory.json). Dictionary compression сохранена: `*Ref` — индексы соответствующих массивов `records`, paint records адресуются хешами. `headerTitleTargetedRecords[].recordIndex` адресует `nativeOverrides` того же instance. Raw text, имена узлов и hyperlink values в отчёт не включены. Локальный полный sanitized capture: `.cache/modal-migration-input-2026-10-29-native.sanitized.json`.
