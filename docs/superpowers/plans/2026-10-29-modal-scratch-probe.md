# Modal: scratch API probe and migration inventory

**Status:** Implementation authorized by user's "продолжаем" after the reviewed plan. This authorizes a separate diagnostic draft and read-only inventory. It does not authorize structural edits of finished dark/light masters or migration of their instances.

**Goal:** Validate an API-compatible header (Optional label outside Title SLOT) on newly created draft nodes, and prepare an evidence-backed migration map before requesting finished-library changes.

**Live source:** SD Enterprice/UI kit933:24166; dark2046:48406/light4745:44256 unchanged since checkpoint. Current selection16135:104955 is a separate screen, not the resumed target. Git clean at2f47989,feat/figma-mcp-bridge,fetch0 0.

## Bounded probe design

New MCP `probe_modal_slot_structure`, protocol `component.modal.probe`, args operationId/dryRun(defaulttrue)/expectedState(requiredapply). No arbitrary JS, node patches, imports, existing node targets or user-supplied source IDs. Create ONE operation-owned draft PAGE named Codex / Modal API probe; all components/text/frames/instances are newly created there. Do not change current page/selection, finished components, existing styles or incomplete receipts.

Read-only preview returns exact fixed test plan, document state fingerprint and proposed draft name. Apply rechecks state around font loading, creates operation receipt and only owned draft nodes; no native delete of existing nodes. Fixed Inter Regular typography suffices for a capability test, no appearance-parity claim. Keep result page for review even if an individual capability test fails. Timeout retry same operationId must return same page/result, never another draft. New page ownership markers, complete result snapshots/hash/main links and bounded receipts must reject modified/conflicting/incomplete replay. Report partial created IDs, never silently remove a page containing foreign edits.

Cases on fresh draft nodes:

1. Proposed vertical header: Optional TEXT sibling of Title FRAME->SLOT; BOOLEAN binds outside SLOT. Create true/false instances, verify label visibility changes while Title remains present and linked.
2. Newly created legacy-shaped draft: Optional starts inside Title SLOT. Test reparenting that owned Optional out of SLOT into a wrapper, then BOOLEAN binding outside. Record exact API failure if unsupported; no claim that this proves all production migration paths.
3. Draft instance custom Title content: test preserving/replacing custom slot contents on owned new instance only and read back IDs/content/order/visibility. Unsupported operations are explicit case failures, not a reason to touch the production masters.

Bound all node counts/snapshots/public result/pluginData entry sizes. Failed tests remain visible on the draft and in structured result. API-level failure is evidence, not automatic permission to edit the library.

## Parallel work

- Core worker: src/shared/modal-probe.ts,src/plugin/modal-probe.ts,tests/modal-probe*.ts via TDD. Parent owns protocol/MCP/queue/smoke/docs and full build verification.
- Read-only inventory worker: fresh72instance trees from prior audit; classify default lineage vs custom candidates, preserve full content hashes/paint/style/main/visibility data in a project audit, mark all unresolved mappings explicitly. No live writes.
- Review worker after implementation: inspect source/state/ownership guards, replay/partial behavior, native API capabilities and data preservation claims. Fulltests/typecheck/build/installskills/smoke/transfer verification before runtime load.

## Next checkpoint

Run read-only preview then authorized draft apply after new runtime is loaded, inspect every case and created page preview. Prepare exact migration diff plus unresolved custom Title cases. Obtain separate finished-component approval before any production structural write. Old modal-light-align-20261028-v1 remains incomplete/recovery3of3; do not reset or bypass it.

## Native page-limit finding and bounded recovery

The plugin/MCP were restarted and the new command loaded. Fresh complete native membership is65dark+7light, unchanged before/after72new read-only instance captures. Native overrides are available72/72 (651records); custom39Title roles remain unresolved. The original probe's native createPage failed with the exact Starter3-page limit before creating any nodes. Same-ID inspection confirmed a partial receipt with createdNodeIds[] and no pageId. No diagnostic cases ran and no production nodes changed. Two earlier SOURCE_CHANGED failures were prewrite context drift; selection changed during preparation.

Implementation adjustment within the authorized isolated draft scope: expose a same-ID read-only recovery preview ONLY for this exact zero-node page-limit failure. It proposes one new owned free-layout FRAME2600x1200 below existing top-level content on currentPAGE. No new input fields, no new operation ID, no receipt reset or deleted evidence. ExpectedState binds original raw receipt, currentPAGE/editor context, exact top-level geometry and placement, repeated after font loading. Preserve original receipt/failure in recovery history; allow just one recovery attempt. Partials with existing nodes or any recovery flag remain blocked. Existing finished components/instances/styles are excluded from writes. Completed PAGE results remain backward compatible; FRAME results report existingpageId/newcontainerId and verify frame rootgeometry,parentPAGE,schema,mainlinks and content on replay.

Only plugin runtime reload is needed for this adjustment: existing MCP method name/input schema are unchanged. Native draft results remain pending until that reload; do not claim the new structure supported based on mock tests alone.
