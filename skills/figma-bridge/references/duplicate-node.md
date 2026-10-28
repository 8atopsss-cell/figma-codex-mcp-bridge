# duplicate_node quick contract

Input: `sourceNodeId`, ASCII `operationId` (1-80 letters/digits/_/-), `name`, `position:{x,y}`, optional `layerStyles:[{sourceNodeId,fillStyleId?,strokeStyleId?}]` and `dryRun` (default true). Apply additionally requires `expectedState` from preview. All requested style IDs must reference existing accessible PAINT styles, and every source layer must be inside the root. No theme guessing.

Roots: FRAME or INSTANCE. Parent: PAGE or FRAME with layoutMode NONE; no COMPONENT, COMPONENT_SET or INSTANCE ancestor. Native cloning retains slots and component links. No detach or swaps. The source is unchanged; only new copies receive paint overrides. Private document-level operation metadata and chunked copy receipts provide retry protection.

Preview returns source/parent IDs, name, position, styles and expectedState without writes. Apply returns nodeId and a source-to-copy nodeMap. At most 200 style overrides, 2,000 source nodes, depth 16 and 256 KiB preview state. Copy receipt entries stay below the Figma 100 kB per-entry limit.

Preview, agree on exact changes, apply the same request. Existing confirmation remains valid only for unchanged scope. After TIMEOUT retry the same operationId; `replayed` returns the same verified copy. Changed scope with the same ID: OPERATION_CONFLICT. Edited/moved/deleted copy: OPERATION_RESULT_CHANGED. Interrupted pending operation: OPERATION_INCOMPLETE. Incomplete cleanup: ROLLBACK_INCOMPLETE with remainingNodeIds, cleanup errors and cause. Inspect before continuing; never create another copy to bypass an error.

After timeout inspect the same request/operationId with dryRun:true. An existing verified copy returns replayed. A completed rollback returns a fresh preview and previousFailure (original code/details); inspect that error before another apply. Full snapshots run at batch boundaries; a changed source/environment still rolls back the copy. Copy readback includes the first differing property.

Read back every mapped node and its preview before reporting the result. User provides visual acceptance. Restart Figma plugin and Codex/MCP after installing updated code.
