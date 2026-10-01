---
name: figma-bridge
description: Use when working with the local Figma Codex MCP Bridge, exporting Figma components to React or Storybook, or resolving the current file, selection, tokens, themes, and component settings.
---

# Figma Bridge

Resolve the source of every Figma request from live editor state. Conversation history is context, not proof that a previously used file or object is still the target.

## Choose the file

1. Call `list_connected_files` before reading or changing a Figma design. Use the file marked `active: true` as the current file.
2. Call `get_file_overview` and verify its `fileName` matches the active file. If they disagree, refresh the file list and stop dependent work until the target is clear.
3. Do not call `select_file` merely to inspect a remembered file while another file is active. Use it only when the bridge cannot detect a foreground file and the user has identified which file to use. If the user explicitly wants a background file, ask them to bring that tab to the foreground.

## Resolve “this” and selected objects

- For “эта иконка”, “этот блок”, “выделенное”, or similar references, use `get_file_overview.selection` in the active file. Read the selected node with `get_node_tree` and inspect its preview when appearance matters.
- If selection is empty, or several selected nodes could be the source, ask the user to select or name the intended object. Do not infer it from the last edited file, a prior screenshot, or a nearby frame.
- Before exporting a design into repo assets or making a visually specific edit, record the source file name and node ID in the work notes or response. Recheck the active file before the write, since the user may switch tabs during the task.
- If the active file or selection changes mid-task, use the new live state only after resolving whether the user's instruction still refers to the same object.

The current Figma file is the default target for general commands. An explicitly named file takes precedence only after its live identity is verified.

## Ask before changing finished components

Always ask the user before modifying an existing finished Figma component, component set, variant, instance, or any of their sublayers. This includes renaming, fixing variant conflicts, changing styling, geometry, structure or property definitions, and deleting objects.

First inspect the live source. Present the exact proposed changes with file name and target node IDs, then wait for explicit confirmation. Reading and preparing a proposed change do not need approval. Creating a new standalone component does not authorize changes to existing components.

Approval applies only to the agreed objects and changes. If the user has already confirmed those exact changes in this session, carry them out without asking again. Ask again when the scope changes.

## Export designs to code

- Call `get_node_tree` with enough `depth` and `limit` to cover the entire component. Check every node's `warnings`; omitted descendants mean the export is incomplete.
- Map CSS from `properties`, not the convenience `fills` list. `properties` contains the structured Figma paints, radii, strokes, effects, opacity, transforms, layout, constraints, text style, and component properties.
- For text, use `textSegments` when style values are mixed. Do not guess missing typography or geometry.
- Read bindings from node `properties.boundVariables`, paints, text segments, and component definitions. Call `get_variables` with the referenced `variableIds` and the consuming `nodeId`; include alias dependencies in the exported token system. Preserve IDs, names, collections, and raw values for every mode instead of replacing semantic tokens with literals.
- Use `explicitVariableModes` for direct assignments and `resolvedVariableModes` for the effective inherited context. Check `nodeResolutions[].resolvedForConsumer` for Figma's native value. Mode names shared by different collections do not establish a theme mapping. Without consumer context, returned cross-collection resolutions use labelled collection defaults.
- Derive React props and Storybook Controls from `componentPropertyDefinitions`: types, defaults, `variantOptions`, and preferred instance swaps. Use `componentProperties` and `variantProperties` for the chosen instance or variant values. Retain Figma property IDs (including `#` suffixes) in the mapping; names in layer labels are not a schema. Check `componentPropertyDefinitionsSource` to know which component or set owns the schema.
- Check variable `warnings`, resolution statuses, and `pagination.nextOffset`. Missing variables, unresolved aliases, or inaccessible main components mean provenance is incomplete; do not invent replacements. Empty local variable lists do not prove a library has no remote tokens. See [variable handoff](references/variables.md) for the tool contract and examples.
- If `variantProperties` or component definitions report `Component set has existing errors`, inspect the set identified by `componentPropertyDefinitionsSource`. Compare its actual child IDs and names for duplicate variant combinations. This is a source component error: preserved visual properties do not restore a valid schema. Do not infer the missing schema from labels or rename library variants without the user's agreement on the exact changes.
- Resolve every warning before claiming visual parity. Use `get_node_svg` for vector assets; image/video/pattern fills need separate assets; unsupported paints/effects need an explicit implementation decision.
- Compare the rendered Storybook component against `get_node_preview` at the same scale. Report any remaining difference; property transfer alone does not prove visual parity.
