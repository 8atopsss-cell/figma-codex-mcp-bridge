# Variables and component schemas

Use this reference when transferring tokens, themes, or component settings to code.

## Read variables

`get_variables` accepts:

| Argument | Meaning |
| --- | --- |
| `variableIds` | Optional list of 1–100 exact IDs, including accessible remote variables. |
| `collectionId` | Optional collection filter for root variables; alias dependencies can belong to other collections. |
| `nodeId` | Optional consuming scene node. Supplies theme context; does not restrict the list to this node's bindings. |
| `offset`, `limit` | Root pagination. Defaults: `0`, `100`; maximum page size: `100`. |

With no filters the tool lists local variables. It reads accessible library tokens by ID without importing them. For a specific component, collect IDs from node bindings, paints, text segments, and component property definitions, then call:

```json
{
  "variableIds": ["VariableID:123:456"],
  "nodeId": "3:1"
}
```

The response includes:

- `collections`: IDs, keys, names, default modes, named mode IDs, variable IDs, publishing and remote flags. Extension collections also retain parent/root IDs and overrides.
- `variables`: IDs, keys, names, descriptions, resolved types, collection IDs, scopes, code syntax, raw `valuesByMode`, and remote/publishing flags. Aliases retain `{ "type": "VARIABLE_ALIAS", "id": "..." }`.
- `rootVariableIds`: selected roots for this page. `variables` also contains their recursively referenced alias dependencies, across all returned modes.
- `resolutions`: one trace for each root value's collection and mode. Each `chain` step retains variable name/ID, collection ID, mode ID, mode source, and raw value. Resolved traces include `value`; unresolved traces include `reason`.
- `nodeContext`: consumer ID/name, `explicitVariableModes`, `resolvedVariableModes` when `nodeId` is supplied.
- `nodeResolutions`: traces using the consumer's effective modes, plus `resolvedForConsumer` from Figma. A disagreement between the trace and native value is reported; use the native value and investigate the provenance warning.
- `pagination`: offset, limit, total root count, and `nextOffset` (`null` on the last page).
- `warnings`: inaccessible variables/collections, failed native resolution, unavailable extension values, cycles, missing mode values, or bounded traversal.

Pagination applies to roots, not dependencies. Keep requesting `nextOffset` when exporting the whole library; deduplicate graph entries by ID.

## Choose modes correctly

Each collection has its own mode IDs. `Light` in one collection and `Light` in another do not prove a relationship.

For `resolutions`, the root collection is forced to the indicated `modeId`; aliases in that collection use the same mode. Other collections use the consumer's resolved modes when supplied, otherwise their own defaults. `chain[].modeSource` is `requestedMode`, `nodeResolved`, or `collectionDefault`.

These per-mode traces are labelled evaluations, not a promise that switching one mode switches every other collection. Preserve raw mode values and define any application theme mapping from verified collection assignments. `nodeResolutions` describes the actual consumer context; `resolvedForConsumer` is the native Figma result.

`explicitVariableModes` records direct assignments. `resolvedVariableModes` records effective assignments including ancestors. An absent collection mode uses that collection's default. A selected mode with no value is an error, not a reason to silently use another mode.

Extension values come from `valuesByModeForCollectionAsync`, retained separately as `variables[].valuesByCollection[collectionId]`; base `valuesByMode` remains intact. Multiple applicable extensions without a clear trace context produce an unresolved trace; native consumer resolution can still be returned.

Traversal is bounded to 500 graph variables and 64 alias steps. Large serialized responses return `VARIABLES_TOO_LARGE`; request fewer root IDs or a smaller page. No values are fabricated when data is inaccessible or truncated.

## Preserve component API

`get_node_tree.properties` includes `componentProperties`, `variantProperties`, and `componentPropertyDefinitions` where applicable. For variants, definitions come from their component set. For instances, the reader calls `getMainComponentAsync` and reads that component or its set.

`componentPropertyDefinitionsSource` identifies the schema owner. Instance `mainComponent` identifies the selected main component. Definitions retain types, defaults, variant options, preferred swaps, and default-value variable bindings. Property names with `#` suffixes remain unchanged.

Use definition defaults for API/Controls defaults; chosen instance values describe only that instance. Do not infer allowed options from names such as `size=32`.

## Official API references

- [Figma Variables API](https://developers.figma.com/docs/plugins/working-with-variables/)
- [Effective node modes](https://developers.figma.com/docs/plugins/api/properties/nodes-resolvedvariablemodes/)
- [Component property definitions](https://developers.figma.com/docs/plugins/api/ComponentPropertyDefinitions/)
