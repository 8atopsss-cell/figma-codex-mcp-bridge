---
name: figma-bridge
description: Use when working with the local Figma Codex MCP Bridge, especially when several Figma files are connected or the user refers to the current file, a selected object, or "this" design.
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
