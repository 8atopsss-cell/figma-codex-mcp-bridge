# Project maintenance

For Figma operations, use the project skill at `skills/figma-bridge/SKILL.md`.

Keep reusable skills created for this plugin in `skills/<name>/SKILL.md`, including their supporting resources. This folder is the source for skills included in the transfer bundle. When updating an installed global copy, update the project copy as well.

After changes to the plugin, bridge, dependencies, assets, installation instructions, or project skills, run `npm.cmd run build`. The build regenerates `transfer/figma-codex-mcp-bridge`; verify it before handing it to users. Do not edit generated bundle files directly. The bundle must include all project skills and must exclude pairing tokens, personal manifests, account settings, and node_modules.
