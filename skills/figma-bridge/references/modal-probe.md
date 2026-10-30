# Modal SLOT capability probe

`probe_modal_slot_structure` runs fixed diagnostic cases on newly created draft nodes. It does not align existing library components or migrate their instances. Resolve the active file with `list_connected_files` and `get_file_overview` first. Creation needs the user's authorized draft scope; it grants no permission to change finished components.

## Preview and apply

Preview is read-only:

```json
{"operationId":"modal-structure-probe-20261029-v1","dryRun":true}
```

Inspect the returned `plan`, document fingerprint `expectedState`, and draft name. Apply the same operation with `dryRun:false` and that exact `expectedState`. The tool accepts no existing node IDs, arbitrary scripts, patches or source components. It creates one page `Codex / Modal API probe`, fixed Inter Regular text, components and instances, without changing the current page or selection. No existing master, style, instance or failed alignment receipt is edited.

Cases:

1. `outside-optional`: BOOLEAN-bound Optional TEXT outside Title SLOT; true/false instances must retain a visible, linked Title.
2. `legacy-reparent`: a newly created legacy-shaped draft moves its owned Optional out of Title SLOT into a wrapper before binding BOOLEAN. Native rejection is a failed case.
3. `custom-title`: a new instance receives custom Title contents. IDs, text, order and visibility are read back across toggling and replacement. Displaced draft contents stay on an owned staging frame.

`capabilityOnly:true` always applies. `status:applied` means the diagnostic draft was recorded, even when a case has `passed:false`. Inspect **every** case and its evidence/failure. It does not prove safe migration of existing custom slots or visual parity. Only the user assigns visual acceptance.

## Replay and failures

After timeout, inspect with the **same operationId** and `dryRun:true`. Completed replay validates owned page membership, snapshots, metadata, schema and main links; edited results fail closed. `partial` retains created IDs/page and failure evidence. An incomplete receipt blocks retry. Never delete its evidence, reset receipts or choose a new ID to bypass a failure. No automatic cleanup deletes draft nodes.

One narrow exception is an explicit same-ID recovery preview after the exact observed native Starter page-limit error from `createPage`, with **zero** created IDs and no page/result chunks/recovery history. It proposes one new owned FRAME on the current PAGE instead of another PAGE. Preview exposes `recovery.previousFailure`, the unchanged `recovery.originalReceipt`, existing `pageId`, `containerType:FRAME` and exact `placement`. Inspect these before applying with the fresh expectedState. The fingerprint binds the original receipt, document/editor context and complete bounded top-level geometry; it is checked again after font loading. Existing nodes are not moved or restyled.

The new 2600×1200 free-layout frame is placed below current page content. Its new `containerId` differs from the existing `pageId`. Recovery attempt is capped at one; its receipt preserves the original failure. Any partial recovery stays blocked. This exception never applies to a generic API error, a failed operation with created nodes, an exhausted alignment or a completed/changed result. Artifact checks inspect root result keys, PAGE ownership markers and current PAGE direct children; they do not traverse or load unrelated page contents. Inspect the frame tree and PNG, then replay the same operation to verify persistence.

Limits: 240 owned nodes, 4 MiB snapshot, 512 KiB public result, 100 kB per pluginData entry. Preview checks document page topology/current selection and repeats after font loading. A new tool requires restarting both the root-manifest Figma plugin and Codex/MCP after building.

## Read-only migration inventory

`get_node_tree` now includes native `properties.overrides` on instances when available. Getter failure produces a warning; missing data is not an empty override list. Native entries identify overridden fields, not a complete history or the values themselves. Read the corresponding nodes and text segments.

For a root attached local COMPONENT only, `instanceInventory` enumerates native instances, checks main links and repeats membership enumeration. Maximum 1000. `complete:false` or warnings block a claim of complete impact. `count` and membership `snapshot` are emitted only on complete enumeration. This SHA256 binds owner ID/key and sorted instance IDs; it does **not** attest instance contents or overrides. Nested COMPONENT, COMPONENT_SET and INSTANCE reads do not enumerate a component inventory.

Record exact native lineage/property refs, full Title content hashes, geometry, visibility, styles and mixed text segments. Do not infer Optional from a layer's name, text or child position. Unknown custom lineage stays unresolved. Before any structural library edit, show the exact master/instance migration diff and obtain its explicit approval. Existing exhausted `modal-light-align-20261028-v1` remains incomplete at recovery 3/3.
