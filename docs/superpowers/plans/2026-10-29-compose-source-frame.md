# Compose source frame implementation plan

> For agentic workers: use subagent-driven-development and TDD. No commit/branch/push authorization. Preserve existing work.

Goal: implement the explicitly approved new 506×365 light FRAME for source16079:56961, with ordinary text heading and real light input/buttons/radio instances; never change the original, existing appearance copy or library.

Architecture: a bounded `compose_source_frame` MCP endpoint (`theme.frame.compose`) with explicit declarative source node recipes. Recreate structural FRAME/SLOT and explicitly approved instance fallback nodes as new free-layout FRAMEs; copy source geometry/content, use local semantic PaintStyles. New atomic controls are created from explicitly named local masters with source-derived text/visibility/properties/custom icon transfers to exact target-master descendants. No arbitrary JS, generic property patch, edits of old nodes, implicit schema repair or source detachment. Geometry is snapshot composition; controls retain native component links.

The user approved this layout/design and resumed with “собери окно”. Do not request the same approval again. Current selection16149:114752 is another1920×944 screen; explicit approved source16079:56961 remains the target after its fresh readback. Title diagnostics are stopped.

Core schema and safety contract are implemented in a separate shared/plugin unit. Explicit source root, name/position and recursive recipe are request-bound; recipe sourceIDs must be in the verified source subtree. Every structural source child is represented once in original order. Atomic component leaves have explicit descendant transfers and target IDs; unsupported content fails preflight. Source text is read from nodes, not supplied by the caller. Explicit shared-component references preserve current icon mains. Source/target/fonts/styles/parent graph is sealed with SHA256, preview read-only, apply repeats checks after font loading, writes only owned new nodes. Receipts preserve same-ID replay and partial created IDs without deletion/reset. Max source/result nodes500, bounded snapshots/results/pluginData entries. Existing metadata must not be exposed as public payloads.

## Tasks

- [x] Core: src/shared/frame-composition.ts, src/plugin/frame-composition.ts and focused native-shaped tests implemented; frozen after user cancelled additional checks.
- [x] Parent: fresh complete75-node source/master/style capture, exact request13maps/2fallback/37styleentries, scoped card search and placement1018,440 prepared.
- [x] Parent: protocol/plugin/MCP write queues, file pinning and focused integration tests added.
- [ ] Independent review interrupted at user's explicit request; do not continue extra checks automatically.
- [x] Instructions/project skill/daily log updated; required build/install:skills completed. Full suite/typecheck/smoke/transfer verification cancelled by user; no fresh completion claim for them.
- [ ] Load root-manifest plugin and Codex/MCP, then mandatory fresh preview + same-request apply. Additional node/PNG/visual checks cancelled by user; report createdID/partial/error and leave visual verification to user.

Implementation details may be narrowed by verified native capabilities, but no recolored dark-instance copy may be reported as light-component reuse. Do not resume/change old incomplete alignment or probe receipts.
