# Figma Codex MCP Bridge

For requests involving this bridge, read `skills/figma-bridge/SKILL.md` and follow its file and selection rules. The currently active Figma file is the default target. An ambiguous reference such as "this icon" requires a live selection or an explicitly identified source.

Always ask for explicit confirmation before modifying finished Figma components, sets, variants, instances, or their sublayers. Present the exact target IDs and changes after inspecting the live file. Existing confirmation remains valid only for those same objects and changes; do not ask twice.

This is a compiled distribution. Installation instructions are in `README.md`. Do not run build commands here: changes to the plugin or bridge should be made in the source repository and delivered as a new bundle.

For `create_component_variants`, inspect the existing set, source components, exact descendant IDs and PaintStyle IDs first. Use dryRun=true, present exact properties, placements, styles and optional componentSetSize/newVariantValues, then apply the same request with dryRun=false and expectedState. New values require existing axes and must actually be used. Resize preserves original child geometry. Existing approval covers only unchanged scope. Retry timeouts with the same operationId. For incomplete rollback, report remainingNodeIds, componentSetSizeRestored/currentSize and cause; never overwrite manual dimensions. The tool changes new clones and explicitly requested set dimensions only; it does not infer a Cartesian product.
