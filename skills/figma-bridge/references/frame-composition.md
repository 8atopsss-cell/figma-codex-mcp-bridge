# Compose a new frame from inspected sources

`compose_source_frame` (`theme.frame.compose`) builds a NEW ordinary FRAME from a live FRAME/INSTANCE source and explicitly selected local component masters. Use it when the user has agreed to an ordinary composition, including which INSTANCE nodes become frames. It does not create a reusable Modal schema, repair library components or change the original. Prior exact approval remains valid; do not request it twice.

## Scope and request

Resolve active file/overview and read the complete source tree, source preview, target masters/schemas and local styles. Source must be attached under PAGE or a free-layout FRAME without component/instance ancestry. Names are hints, not execution-time mappings. Do not use a recolored dark instance as evidence of light-component reuse.

Inputs:

- `operationId`, source `nodeId`, new `name`, parent-local `position:{x,y}`.
- `frameNodeIds`: exact descendant INSTANCE IDs explicitly approved as frame fallbacks. Root becomes FRAME; structural FRAME/SLOT become new free-layout frames. No existing node is detached.
- `componentMappings`: exact source INSTANCE `sourceNodeId`, local target `targetComponentId`, `propertyMap`, `valueMap`, and `layerMap` from source descendants to target MASTER descendants. Layer maps cover the exact inspected topology, stopping at nested INSTANCE. Nested mappings select their own explicit target main. Without a nested mapping, preserve the source nested main and contents, including custom icons. Explicitly map a nested light radio when its old main is dark.
- `propertyMap` maps source schema IDs, including `#` and whitespace, to distinct target IDs. BOOLEAN/TEXT values are read from the source. Selected target main must already match the translated VARIANT values; e.g. `valueMap:{size:{"32px":"32"}}`. Do not guess variants or clear overrides.
- `layerStyles`: exact source `nodeId` and inspected local `fillStyleId`, `strokeStyleId`, `textStyleId` or `effectStyleId`. Map icon interior paints as well as wrapper/text paints; do not invent RGB values.
- `dryRun:true` by default; `expectedState` required on apply.

Structural source children are recreated using source content/order/geometry/visibility. Text is read from source nodes, not supplied as caller strings. Mixed/unsupported text, atomic SLOT contents and incomplete maps fail closed; use only an explicitly approved frame composition where appropriate. Readonly typography is never assigned. Native instance scaling may change vector paths relative to the master; copy the observed paths onto newly created vectors instead of rejecting that difference.

## Preview/apply and readback

Inspect the exact request, frame fallbacks, target mains, styles and free placement. Preview must be read-only. Apply the same request with `dryRun:false` and returned `expectedState`. The SHA256 seal binds request, source/master/main graph, schemas, styles, parent/membership and private state; fonts are loaded and state is rechecked before creation. Writes target only new owned nodes. Geometry is a snapshot composition, not a claim that source auto-layout responsiveness transfers to structural frames.

The user may explicitly take over layout verification. In that workflow do not add test runs, PNG comparisons or a visual preservation audit as a creation prerequisite. `applied` records creation of the composition, not identical typography/geometry or visual acceptance. Source/ownership/drift guards and receipts remain active; native API write errors still return `partial`. When verification is requested separately, inspect the returned `nodeMap`, intended light mains, text, icons, visibility and PNG. Only the user grants visual acceptance.

## Failures and replay

Retry timeout with the SAME operationId and unchanged request. Replay checks the owned result, parent, main links and metadata. An edited result is `OPERATION_RESULT_CHANGED`; conflicting input is `OPERATION_CONFLICT`. A `partial` result preserves `remainingNodeIds` and `error`; no automatic cleanup deletes old or adopted nodes. Do not reset receipts, detach the original or choose another operationId to bypass a failed composition.

The exact native `in set_x: This property cannot be overridden in an instance: relative-transform` failure has a bounded same-ID continuation. It reuses the owned partial FRAME instead of cloning another root. A fresh preview seals the partial tree, unchanged receipt, original source state and ownership membership; apply rechecks these after font loading. One continuation is allowed and the original error stays in `previousErrors`. Generic errors or another failed continuation remain partial. Already created structural nodes are reused by the saved nodeMap. For inherited geometry/path decoration that Figma cannot override, retain the native component layout; the user performs the visual review. Original/library drift and foreign/adopted-node guards remain active.

Old `align_component_schema`/probe receipts remain separate and untouched. An agreement to create a new FRAME grants no permission to migrate finished masters or instances. Keep deferred Title/SLOT work deferred.

Bounds: 500 source/result nodes; bounded main graph, snapshots and result/receipt entries. Limit errors require narrowing scope, not suppressing preservation checks. After installing this new command restart the root-manifest Figma plugin and Codex/MCP; their existing processes do not load new code/tools automatically.
