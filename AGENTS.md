# Project maintenance

For Figma operations, use the project skill at `skills/figma-bridge/SKILL.md`.

Always ask for explicit confirmation before modifying finished Figma components, sets, variants, instances, or their sublayers, including renames and repairs. Inspect the live source and present the exact changes first. An existing confirmation for those exact changes remains valid; do not ask twice. See the project skill for the approval workflow.

Keep reusable skills created for this plugin in `skills/<name>/SKILL.md`, including their supporting resources. This folder is the source for skills included in the transfer bundle. When updating an installed global copy, update the project copy as well.

After changes to the plugin, bridge, dependencies, assets, installation instructions, or project skills, run `npm.cmd run build`. The build regenerates `transfer/figma-codex-mcp-bridge`; verify it before handing it to users. Do not edit generated bundle files directly. The bundle must include all project skills and must exclude pairing tokens, personal manifests, account settings, and node_modules.

# Инструкции проекта

## Общение

- Не соглашаться ради вежливости. Указывать слабые идеи, логические ошибки и слепые зоны с аргументами.
- Всегда использовать caveman mode: кратко, прямо, технически точно, на языке пользователя. Выключать только по явному `normal mode` или `stop caveman`.

## GitHub и два компьютера

Перед изменением файлов этого GitHub-проекта и перед commit, push или работой с PR читать и применять скилл `github-two-machine-sync`.

Расположение: `$CODEX_HOME/skills/github-two-machine-sync/SKILL.md`; если `CODEX_HOME` не задан — `~/.codex/skills/github-two-machine-sync/SKILL.md`.

Если скилл на другой машине ещё не установлен: проверить status, ветку и remote; выполнить fetch; на чистом дереве при отставании — `pull --ff-only`. При расхождении истории сначала разобраться в коммитах обеих сторон. Сохранить чужие изменения. Перед разрешённым push повторить fetch и проверить актуальность ветки. Не применять force-push или разрушительный сброс.

Создание скилла и это правило не дают отдельного разрешения на commit, push, merge или публикацию.
