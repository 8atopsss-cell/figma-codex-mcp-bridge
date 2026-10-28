# Theme conversion: operating instructions

Implemented: read-only `list_components` and `plan_theme_conversion`, plus a separate staged `copy_theme_component` preview/apply operation for one compatible parent INSTANCE on a new copy. Plans always return `executable:false`; `review` is not an apply token or proof of preserved content. Full recursive layout conversion, FRAME orchestration and missing-element creation remain later stages.

## Workflow

1. Resolve live active file/selection, exact FRAME/INSTANCE ID, main components, schemas and preview. A light-looking instance or the label `Modal light` does not prove it uses a light master.
2. Call `list_components` on explicit local library roots. It returns schema owners, component IDs/keys, definitions, variant values, schema errors and scoped pagination. Pass `expectedScopeSnapshot` on later pages. Limits or unavailable roots fail closed; do not treat partial search as absence.
3. Call `plan_theme_conversion` with `nodeId`, `libraryRootIds` (1-8), optional `targetTheme` (light default), `themeProperty` (theme default) and explicit `mappings`.
4. Mapping example: `{sourceId:"dark-set-id",targetId:"light-set-id",propertyMap:{"label#old":"label#new"},valueMap:{size:{"32px":"32"}}}`. IDs must belong to the respective schemas, target properties must be distinct, and types must match. Name-based candidates require confirmation; do not choose the first result or infer mappings from RGB.
5. Prefer an existing compatible themed parent, then read/replan its resulting nested tree. Nested decisions are provisional and require replanning after parent substitution. Never reuse old instance-child IDs for a changed parent. Preserve labels, custom icons, boolean/variant states, slot contents/order and layout; classify dark paint overrides separately from intentional user changes.
6. On slot/schema mismatch report **Светлый и тёмный компоненты необходимо привести в соответствие**. Show source/target IDs, missing or mismatched properties, affected contents and required corrections. Pause that component until alignment is agreed. Empty slots still require compatibility. Do not repair finished masters, flatten the node, create another component or use an appearance-only copy to bypass the conflict.
7. `reuse` means compatible schema/variant selection, not proven transfer. `mapping_required` needs explicit property/value/component mapping. `unknown` needs more evidence. `missing_variant`/`missing_component` are proposals, with no proof of global absence; recheck other pages and inaccessible libraries before creating anything.

## Input and output

`list_components`: required `rootNodeId` (attached local PAGE/SECTION/FRAME/COMPONENT/COMPONENT_SET); optional `query`, `offset`, `limit` (1-100), `scanLimit` (1-20000), `expectedScopeSnapshot`. Full scope scan precedes pagination. Instance subtrees are skipped because they are not library masters. `scopeComplete:true` is local to the listed roots only. Depth max 64, snapshot max 256 KiB, response max 512 KiB; narrow the roots on limits. No library imports.

`plan_theme_conversion`: optional explicit `sharedComponentIds` for verified common components and `frameFallbackNodeIds` for one-off compositions with no found counterpart. These cannot bypass an existing themed component or slot conflict. Source traversal max 2000 nodes/depth 16. No write/apply/dryRun fields are accepted.

Slot min/max and preferred values are checked before missing-variant proposals even when attachment inspection is deferred. Local masters must still belong to the document; an addressable soft-deleted master is unavailable. The planner rechecks catalog, source/target schemas and target slot references before returning; drift produces SOURCE_CHANGED, not a stale reuse proposal.

Output includes parent-first steps, exact source main/schema owner and target IDs, evidence (`explicit_mapping`, `same_set_theme_axis`, `name_candidate`), mapped values, preservation evidence, `issues`, `blockedBy`, `provisional` and `requiresReplanAfterParent`. Snapshots are diagnostic, not write authorization. Show exact changes and obtain confirmation before any later mutation; prior approval applies only to that same scope.

## Copy one compatible parent through its target master

Use `copy_theme_component` only after live source/target inspection. Input is the planner fields without `frameFallbackNodeIds`, plus `operationId`, `name`, `position`, explicit `layerMap` and `dryRun` (true default). `layerMap` maps exact SOURCE descendant node IDs to exact TARGET MASTER descendant IDs, separately from propertyMap. Cover the parent structure; nested INSTANCE interiors and free SLOT contents are preserved/checked as subtrees. SLOT layer mapping must agree with the SLOT propertyMap. Do not infer layer identity from names or child indexes. The source must be a standalone INSTANCE under PAGE or a free-layout FRAME; finished component/instance ancestry is rejected. Applying nested theme substitutions inside an INSTANCE is not supported yet; fresh descendant planning does not claim that capability.

Preview must not write, clone or reserve metadata. The parent must resolve to a compatible exact `reuse` target; alignment, unknown schema and ambiguous maps block before cloning. Unsupported overrides/preservation fail closed instead of clearing all overrides or accepting native swap heuristics as proof. The original and masters remain unchanged. A converted parent may still contain pending dark/shared/unknown nested instances; do not claim full theme conversion.

Current transfer requires matching mapped hierarchy and sibling order, with no unmapped target layers. Paint/geometry/text-style overrides and complex nested SLOT compositions in preserved subtrees are unsupported. Differences in text formatting, bindings, reactions, vector data or preserved content must fail validation instead of disappearing silently. `preservationRestores` lists source nested mains restored for content/custom-icon preservation, not nested theme conversion. `freshInventory` uses actual result IDs; `pendingDescendantSteps` remain provisional source-plan evidence. `followupRequired:true` means the theme conversion is incomplete.

Present exact source/target IDs, maps, contents, copy name/placement and limitations, then obtain agreement. Apply the unchanged request with dryRun=false and expectedState from preview; on SOURCE_CHANGED inspect and preview again. After apply read the actual resulting tree/main identities and preview, then replan descendants using fresh IDs. Do not reuse provisional child IDs from the old parent. Never import, detach, repair library schemas or create another master to bypass incompatibility.

Retry timeout with the SAME operationId and dryRun=true. Verify replay rather than producing another copy. Report OPERATION_INCOMPLETE / OPERATION_RESULT_CHANGED; for ROLLBACK_INCOMPLETE include all remainingNodeIds, cleanupErrors and cause. Cleanup removes only objects created by this operation, never originals or unknown edited leftovers. User alone grants visual acceptance.

## Separate appearance copy

Use `duplicate_node` only when the user explicitly wants a copy retaining its current component links with changed paint styles. Recoloring a dark master instance is not component-theme reuse. The default theme-conversion workflow is catalog → plan → review; it must not silently fall back to duplicate_node/create_screen.

After changing source/skills run the build, verify the transfer package and update the installed skill from the project copy. Reload Figma plugin and Codex/MCP for new methods. The canonical local manifest remains in the project root; do not create v_2 installations.
