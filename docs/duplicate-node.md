# Copy a window and assign existing paint styles

`duplicate_node` copies a live FRAME or INSTANCE using Figma's native clone. It preserves component links and slot contents; it never detaches instances, swaps components, or edits the original tree. The copy stays under the same parent, at the explicitly requested coordinates. Supported parents: PAGE or FRAME with `layoutMode=NONE`. Component/instance ancestors, component sets, sections as direct parents and auto-layout parents are rejected.

Resolve the active file and selected node first. Inspect its full tree, preview and accessible PaintStyle IDs. Show the source ID, new name, placement and exact fill/stroke style assignments and obtain confirmation. Existing confirmation for that exact scope remains valid. Theme matching is explicit: do not infer styles from equal RGB values or mode names.

Preview example (replace the illustrative IDs with live IDs):

```json
{
  "sourceNodeId": "1:2",
  "operationId": "license-modal-light-v1",
  "name": "Modal light",
  "position": { "x": 1000, "y": 288 },
  "layerStyles": [
    { "sourceNodeId": "1:2", "fillStyleId": "S:light-modal," },
    { "sourceNodeId": "I1:2;3:4", "fillStyleId": "S:light-text," },
    { "sourceNodeId": "I1:2;3:5", "strokeStyleId": "S:light-border," }
  ],
  "dryRun": true
}
```

Preview does not write nodes or metadata. The result contains `expectedState`, source/parent IDs, name, position and the exact assignments. Apply the unchanged request with `dryRun:false` and that `expectedState`. Operation IDs accept 1–80 ASCII letters, digits, underscores or hyphens. At most 200 distinct layer overrides; the source tree is bounded to 2,000 nodes and depth 16, and preview state to 256 KiB.

The command validates layer membership and PAINT style types before cloning. It loads fonts for styled text, restores copied constraints/reactions if native cloning changed them, and reads back geometry, typography, content, component links, slot structure, paints and bindings. Only explicitly requested paint channels and root name/position may differ. Success returns `nodeId` and `nodeMap` from every source descendant ID to its copy. Main-component links remain attached to their existing components; light appearance is an override, not a swap to another component.

Writes are serialized in the bridge and plugin. The MCP call pins the active connection before entering the write queue. Source, parent environment and style changes invalidate the preview with `SOURCE_CHANGED`. Copy-side metadata and a private document-level operation receipt support retries; source layers receive no metadata writes. Large copy receipts are split into entries below Figma's 100 kB per-entry limit.

After TIMEOUT/disconnect, inspect the **same operationId and request with dryRun:true** before another apply. `replayed` returns the existing copy after checking its tree and parent. If rollback completed, preview returns `previousFailure` with the original error code and details, without creating another copy. Read the failure before explicitly applying a fresh preview. Changed requests return `OPERATION_CONFLICT`; edited, moved or deleted results return `OPERATION_RESULT_CHANGED`. Pending/interrupted operations return `OPERATION_INCOMPLETE`; inspect them rather than generating another operation ID. A successful rollback clears the operation receipt, retains a separate bounded failure record and permits a clean retry. Incomplete rollback returns `ROLLBACK_INCOMPLETE` with `remainingNodeIds`, cleanup errors and cause; it retains the receipt to block duplicates. Do not delete survivors without approval.

Full source/parent/style snapshots run at write-batch boundaries, rather than after each individual paint or font await. Final source verification still rolls back the entire copy if the source or its environment changed during the batch. Copy readback reports the first differing property and expected/actual values, preserving the validation of unrequested geometry, text, structure and component links.

For an explicitly recolored VECTOR, changing `fills` and `fillStyleId` inside `vectorNetwork.regions` is part of the requested fill change. Those paint fields are checked against the requested PaintStyle rather than compared to the dark source. Vertices, segments, winding rules and region loops must still match the source exactly. The source vector remains unchanged.

After applying, read all mapped IDs and the copy preview. Automated readback does not establish visual acceptance; the user accepts the result.

After installing a new build, restart both the Figma plugin and Codex/MCP. A running plugin or bridge continues using its loaded code. Automated checks cover the contract, preservation, file pinning, retries and rollback; live acceptance in Figma is a separate check.
