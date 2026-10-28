# Theme component reuse implementation plan

**Goal:** translate layouts through existing target-theme components, preserving instance data and reporting incompatible slots before any write.

**Approved behavior:** reuse a compatible light parent first, then inspect its actual nested instances. Reuse target-theme variants/components whenever available. Propose a missing variant/component for reusable UI; propose a frame for a one-off composition. An existing but incompatible light component is an alignment conflict, not permission to clone a duplicate or flatten it. Exact message: **Светлый и тёмный компоненты необходимо привести в соответствие**. Show affected source/target IDs, properties, slots, content and required corrections. Pause that component until the corrections are agreed.

**Architecture:** split discovery, planning and future writes. New read-only `list_components` supplies a complete bounded local catalog within explicit roots, with pagination. `plan_theme_conversion` traverses source instances, resolves explicit source/target mappings and same-set theme variants, compares properties/slots and returns parent-first actions and blockers. Names provide candidates only. Plans are never executable approval tokens. Existing `duplicate_node` remains an explicitly requested appearance-only copy tool, not the default theme conversion.

**Tech stack:** TypeScript, Figma Plugin API, Zod, existing MCP bridge, Vitest. Keep the canonical root manifest and generated transfer workflow. No new branch, commit, push, dependency, library import or Figma design write is part of this first implementation stage.

## Stage A — read-only catalog, compatibility and migration plan (implement now)

- [x] Write failing tests in `tests/theme-catalog.test.ts`, `tests/theme-plan.test.ts`, `tests/theme-compatibility.test.ts`: scoped catalog pagination, complete traversal, no imports/writes, unknown schema, schema/slot conflicts, aliases, exact variants, ambiguous name candidates, inaccessible components, frame/missing proposals and parent blockers.
- [x] Add bounded schemas/types in `src/shared/theme-conversion.ts`; register `components.list` / `theme.plan` in `src/shared/protocol.ts`. Reject write fields and duplicate source mappings. Defaults: light theme, theme axis `theme`, empty explicit mappings/shared IDs/frame fallbacks.
- [x] Implement `src/plugin/component-catalog.ts`: load explicit pages, walk local masters (skip instance subtrees), deduplicate roots, paginate only after a complete bounded scan. Include component identity, schema owner, raw property definitions, variant axes/options and schema failures. Never infer global absence from the scoped local catalog.
- [x] Implement pure `src/plugin/theme-compatibility.ts`: map full property IDs explicitly, validate matching types and current values, check SLOT attachment/content/limits/preferred-value restrictions. Missing/incompatible slots always return the alignment message with source/target evidence. Similar labels with different property IDs require an explicit map.
- [x] Implement `src/plugin/theme-plan.ts` and `src/plugin/theme-source.ts`: preserve source IDs/main components/current values/text/slot contents, resolve explicit pairs before same-family theme axes, select exact state/size variants, report candidates without guessing. Prefer a known existing candidate to a creation proposal even if incompatible. Mark dependent nested steps with blocked parent IDs and require replanning after parent substitution. Return `executable:false`; a reuse decision means schema compatibility, not proven content transfer.
- [x] Connect both tools in `src/plugin/main.ts` outside the write queue and in `src/bridge/mcp.ts` with `readOnlyHint:true`, `destructiveHint:false`, and one file-pinned connection per invocation. Test protocol, MCP annotations/forwarding and plugin dispatch.
- [x] Update project skill, add `skills/figma-bridge/references/theme-conversion.md`, document the contract and examples in `docs/theme-conversion.md`, update README and transfer instructions. Include operating limits, incomplete-library warnings, approvals and the difference between appearance copy and component reuse.
- [x] Run focused tests, full tests, typecheck, build, smoke and transfer SHA-256/skill/privacy checks. Install the project skill. Verify the canonical manifest, retain earlier local work and report that the running plugin/MCP must reload new tools.

Stage A handoff verification: 198 tests across 25 files passed; typecheck, build and MCP smoke passed. Transfer contained 16 verified files, all project skills matched source and the installed global copy, and no personal manifests, account settings, pairing tokens or node_modules were included. At that handoff, substitution/content-transfer execution remained outstanding. Current Stage B status is recorded below.

Validation commands:

```powershell
npm.cmd test -- tests/theme-catalog.test.ts tests/theme-compatibility.test.ts tests/theme-plan.test.ts tests/protocol.test.ts tests/mcp.test.ts tests/plugin-errors.test.ts
npm.cmd test
npm.cmd run typecheck
npm.cmd run build
npm.cmd run install:skills
npm.cmd run smoke:mcp
```

## Stage B — compatible component substitution (parent copy implemented)

Implementation contract for this stage: expose `copy_theme_component` / `theme.copy` as one parent INSTANCE substitution on a new copy. The request carries explicit `layerMap` entries from source descendant IDs to exact target-master descendant IDs; no matching by names or child indexes. The original instance and finished masters remain untouched. Preview is read-only; apply requires the same request and its full `expectedState`. A compatible parent can be copied while its descendant conversions remain pending; report those explicitly and inspect/replan the actual resulting tree before any later substitution. Never describe a parent-only result as a complete light layout. Unsupported overrides and ambiguous transfer block before cloning. Plain FRAME orchestration and automatic recursive conversion remain outstanding.

- [x] Add separate `copy_theme_component` / `theme.copy` preview/apply using Stage A root evidence, fresh full source/target snapshots and exact layerMap. Reject root alignment/unknown/mapping conflicts before cloning. Keep exact-operation agreement in instructions; no live apply has been authorized or performed.
- [x] Create a new INSTANCE copy and use `swapComponent`; restore mapped TEXT/BOOLEAN/INSTANCE_SWAP/VARIANT values. Rebuild compatible SLOT content in order. Preserve custom nested main identity, text, supported formatting, bindings, reactions, geometry and source layout; reject unsupported overrides instead of clearing them. Paint/range/vector-region inheritance is checked against exact target defaults, preserved custom icons against the original.
- [x] Return `stage:parent_only`, explicit `preservationRestores`, nodeMap and freshInventory; mark descendant steps pending/provisional. Check exact mapped topology/order and target coverage. Read/replan the resulting tree before any future nested theme substitutions.
- [x] Add durable receipts/chunk integrity checks, same-ID replay even after source removal, conflict/changed-result/incomplete-operation reporting, previous failure inspection, rollback only of new operation-owned objects, and protection for unrelated nodes inserted into working copies. Recheck source/master/result links and snapshots before committing; native API does not provide a global read transaction.
- [ ] Implement subsequent nested theme replacements within an owned working copy and FRAME orchestration. Do not pass nested INSTANCE ancestry to this parent-copy tool.
- [ ] Add explicit, separately agreed handling of supported theme-paint override removal/translation; current paint/geometry/text-style overrides fail closed. Extend complex nested SLOT/custom-instance and mixed target text-paint support only with preservation evidence.
- [ ] Verify live substitution/rollback and visual comparison on a separately approved compatible example, then the aligned Modal. Only the user grants visual acceptance.

Stage B parent-copy verification: full suite 231 tests / 28 files passed; typecheck, build and MCP smoke passed. Transfer SHA-256, exact file inventory (16 files), four source/installed/bundled skill files, excluded personal/runtime files and canonical manifest ID/paths verified. Review findings on rollback ownership, slot/property maps, structural order, late result/source/main drift, receipt corruption and shape-specific geometry were reproduced with regressions and fixed. No live Figma writes performed. Existing Modal alignment remains blocked; recursive application and Stage C are not claimed complete.

## Stage C — missing reusable elements and frame fallback

- [ ] Recheck complete intended search scope and inaccessible remote evidence before confirming absence. Reuse existing `create_component_variants` for approved missing combinations where its local-set/axis restrictions hold; do not expand a Cartesian product or alter existing schemas silently.
- [ ] Propose separately approved standalone components when the library does not use a compatible theme set. Build new compositions from existing target-theme child instances. Generate a plain frame only for the explicitly chosen one-off composition; preserve nested reusable instances.
- [ ] Report unavailable remote libraries or inconsistent schemas as unknown/alignment blockers. Do not import, publish, detach, edit finished masters or repair library schema automatically.

## Stage D — live validation

- [x] Run Stage A against the current window and UI kit after tool reload. Live `list_components` and `plan_theme_conversion` succeeded after restart. Dark main `2046:48406` has three BOOLEAN and three SLOT properties; existing light main `4745:44256` has no definitions. The result for `16112:22878` was `blocked`, root `alignment_required`, `executable:false`; no design writes.
- [ ] After separately agreed library alignment, validate Stage B on button/input/radio first, then the modal. Confirm source unchanged, correct light main components, preserved texts/slots/states, repeat protection and rollback. Only then accept full layout conversion.

## Decisions

- Existing compatible component > existing target-theme variant > approved creation proposal. Name matching is discovery evidence only.
- Explicit property/value maps handle differences such as dark `size=32px` and light `size=32`; no renaming of library definitions.
- A scoped local scan cannot prove that an accessible remote library or another unscanned page contains no counterpart.
- Schema compatibility does not prove text/slot/override transfer. Stage A always returns a non-executable review plan; Stage B is separate.
- Continue development without changing the current Figma layout or masters. The user's implementation instruction approves code/instructions; exact new library edits still require live inspection and separate confirmation.
- Review regressions also cover addressable soft-deleted local masters, changed source/target schemas/catalog during awaits, slot-content restrictions before a missing-variant proposal and changed slot references after inspection. Plans fail closed on drift instead of reporting stale reuse.

## Fresh Modal schema check

Read the active `SD Enterprice` file and current instance `16112:22878` without writes. The existing dark main `2046:48406` declares `Optional label#2046:0`, `button bar#2046:2`, `body copy#2674:0` (BOOLEAN) and `content_1#12414:0`, `content #12416:0`, `Title #12705:1` (SLOT). Existing light main `4745:44256` currently has no property definitions. The new pure compatibility checker was run against those freshly observed schemas and returned three PROPERTY_MISSING plus three SLOT_MISSING issues, all with the agreed alignment message. This validates the comparison logic against live evidence; the newly registered MCP tools themselves still require plugin/MCP reload for a live call. No design or master was changed.

After the user's reload, both tools were verified through live MCP calls. The same six root conflicts were returned. The library roots scanned were `4745:42929` (1 master), `4391:92031` (49 components/sets), `4553:39476` (19), and `5025:42279` (13). These are scoped counts, not global absence evidence. The active file was `SD Enterprice`; current selection had changed to SECTION `12452:22253`, so the read-only test addressed the previously named modal by its verified ID rather than treating the section as a conversion source.
