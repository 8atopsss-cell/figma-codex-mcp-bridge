# Чекпойнт — 30 сентября 2026

## Готово

- Иконка кнопки VPN из файла Figma `02` подготовлена в [SVG](assets/plugin-icon.svg) и [PNG 128×128](assets/plugin-icon.png). Цвета взяты из фрейма `5:2`.
- Иконка встроена в заголовок окна плагина слева от индикатора подключения. Зелёная точка остаётся индикатором связи.
- Сборка автоматически встраивает SVG в `dist/plugin/ui.html`; обновление установлено в `E:\Codex\v_2`.

## Проверено

`npm.cmd run typecheck`, `npm.cmd test` (28 тестов), `npm.cmd run build` и `git diff --check` прошли. PNG просмотрен; размер 128×128.

## Следующий шаг

После перезапуска плагина проверить новый значок внутри окна Figma. Системный значок `< />` в верхней полосе dev-плагина через `manifest.json` не меняется: у [манифеста Figma](https://developers.figma.com/docs/plugins/manifest/) нет поля для иконки. [Иконка публикации](https://help.figma.com/hc/en-us/articles/360042293394-Publish-classic-plugins-to-the-Figma-Community) задаётся при публикации плагина в Community; для неё готов `assets/plugin-icon.png`. Публикацию не запускали: она сделает плагин общедоступным.
