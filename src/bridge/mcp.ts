import { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { createComponentVariantsSchema, duplicateNodeSchema, screenSpecSchema, updateNodeSchema, variableReadSchema } from '../shared/protocol.js';
import type { SyncController } from './sync/controller.js';
import { listComponentsSchema, themePlanSchema } from '../shared/theme-conversion.js';
import { themeCopySchema } from '../shared/theme-copy.js';
import { componentAlignmentSchema } from '../shared/component-alignment.js';
import { componentReferenceRepairSchema } from '../shared/component-reference-repair.js';
import { modalProbeSchema } from '../shared/modal-probe.js';
import { frameCompositionSchema } from '../shared/frame-composition.js';

export interface BridgeCaller {
  getSync?(): SyncController | undefined;
  call(method: string, args: unknown): Promise<unknown>;
  pairingCode?: string;
  confirmDelete?(node: { nodeId: string; nodeName: string; nodeType: string }): Promise<void>;
  listFiles?(): Array<{ id: string; name: string; fileKey?: string; active: boolean; visible: boolean }>;
  activateFile?(file: string): void;
  pinCurrentFile?(): Pick<BridgeCaller, 'call' | 'confirmDelete'>;
}

export function createBridgeServer(bridge: BridgeCaller): McpServer {
  const server = new McpServer({ name: 'figma-codex-bridge', version: '0.1.0' });
  const nodeId = z.string().min(1).max(128);
  if (bridge.getSync) {
    server.registerTool('get_storybook_sync_code', {
      description: 'Get a separate access code for the local Storybook sync UI. This is not the Figma pairing code.',
      inputSchema: z.object({}), annotations: { readOnlyHint: true },
    }, async () => textResult(async () => {
      const sync = bridge.getSync!();
      if (!sync) throw new Error('SYNC_NOT_CONFIGURED');
      return { accessCode: sync.accessCode, url: 'http://127.0.0.1:3847' };
    }));
    server.registerTool('mark_storybook_implemented', {
      description: 'After transferring the exact observed Figma snapshot to code, mark it ready for user visual acceptance. Export alone is not transfer. Never call merely to clear a marker.',
      inputSchema: z.object({ componentId: z.string().min(1).max(80), snapshotId: z.string().regex(/^[a-f0-9]{64}$/), revision: z.string().regex(/^[a-f0-9]{32}$/) }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: false },
    }, async ({ componentId, snapshotId, revision }) => textResult(async () => {
      const sync = bridge.getSync!();
      if (!sync) throw new Error('SYNC_NOT_CONFIGURED');
      return sync.implemented(componentId, snapshotId, revision);
    }));
  }
  let writeTail = Promise.resolve();
  const serializeWrite = <T>(action: () => Promise<T>): Promise<T> => {
    const next = writeTail.then(action, action);
    writeTail = next.then(() => undefined, () => undefined);
    return next;
  };

  if (bridge.pairingCode) {
    server.registerTool(
      'get_pairing_code',
      {
        description: 'Show the local pairing code used once to connect the Figma plugin to this bridge.',
        inputSchema: z.object({}),
        annotations: { readOnlyHint: true },
      },
      async () => ({ content: [{ type: 'text', text: bridge.pairingCode! }] }),
    );
  }

  if (bridge.listFiles && bridge.activateFile) {
    server.registerTool(
      'list_connected_files',
      {
        description: 'List every connected Figma file, name, active status and optional stable fileKey. Connection IDs change after reconnect. Missing fileKey means stable identity is unavailable; never identify a file by its name alone.',
        inputSchema: z.object({}),
        annotations: { readOnlyHint: true },
      },
      async () => textResult(async () => bridge.listFiles!()),
    );
    server.registerTool(
      'select_file',
      {
        description: 'Select a connected Figma file by exact name or connection ID only when no foreground tab is detected. Returns ACTIVE_FILE_ALREADY_DETECTED if another file is active. Use list_connected_files first.',
        inputSchema: z.object({ file: z.string().min(1).max(200) }),
        annotations: { readOnlyHint: false, destructiveHint: false },
      },
      async ({ file }) => textResult(async () => {
        bridge.activateFile!(file);
        return bridge.listFiles!();
      }),
    );
  }

  server.registerTool(
    'get_file_overview',
    {
      description: 'Read pages, current page, and selection from the active Figma file. For "this" or "selected" design requests, call this first; if selection is empty, ask the user to select the source node.',
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true },
    },
    async () => {
      try {
        const overview = await bridge.call('file.overview', {});
        return { content: [{ type: 'text', text: JSON.stringify(overview) }] };
      } catch (error) {
        const message = error instanceof Error ? error.message : 'FIGMA_API_ERROR';
        return { content: [{ type: 'text', text: message }], isError: true };
      }
    },
  );

  server.registerTool(
    'get_node_tree',
    {
      description: 'Read a bounded Figma node tree for code handoff. Includes exact paint, corner, stroke, effect, layout, typography, node boundVariables, explicitVariableModes, resolvedVariableModes, componentPropertyDefinitions with their source, componentProperties, and variantProperties under properties; mixed text styles under textSegments; and warnings for truncated trees or unavailable data. Read get_variables with referenced variableIds and nodeId to preserve tokens and effective themes. Never infer omitted values.',
      inputSchema: z.object({
        nodeId,
        depth: z.number().int().min(0).max(8).default(2),
        offset: z.number().int().min(0).default(0),
        limit: z.number().int().min(1).max(100).default(50),
      }),
      annotations: { readOnlyHint: true },
    },
    async (args) => textResult(() => bridge.call('node.tree', args)),
  );

  server.registerTool(
    'get_node_preview',
    {
      description: 'Return a PNG preview of one Figma node.',
      inputSchema: z.object({ nodeId, scale: z.number().min(0.1).max(4).default(1) }),
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      try {
        const preview = z.object({ mimeType: z.literal('image/png'), data: z.string() })
          .parse(await bridge.call('node.preview', args));
        return { content: [{ type: 'image' as const, mimeType: preview.mimeType, data: preview.data }] };
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    'get_node_svg',
    {
      description: 'Export a vector-capable Figma node as SVG text for reuse as a code asset. Call for VECTOR or BOOLEAN_OPERATION nodes when get_node_tree reports an asset warning.',
      inputSchema: z.object({ nodeId }),
      annotations: { readOnlyHint: true },
    },
    async ({ nodeId: id }) => {
      try {
        const svg = await bridge.call('node.svg', { nodeId: id });
        if (typeof svg !== 'string') throw new Error('INVALID_ARGUMENT');
        return { content: [{ type: 'text' as const, text: svg }] };
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    'list_components',
    {
      description: 'Read-only bounded catalog of local component masters and sets within an explicit library root. Includes IDs/keys, schema owner, property definitions, variant values and schema failures. Paginate with offset/limit and expectedScopeSnapshot from the previous result to detect edits. Only a complete scoped scan can return results; limits and inaccessible roots fail closed. Instance subtrees are not library masters. A scoped local search never proves global absence or grants permission to create/import components.',
      inputSchema: listComponentsSchema,
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    args => textResult(() => (bridge.pinCurrentFile?.() ?? bridge).call('components.list', args)),
  );

  server.registerTool(
    'plan_theme_conversion',
    {
      description: 'Read-only, non-executable component-reuse plan for a FRAME or INSTANCE. Prefer explicit source/target component or set mappings, then same-set theme variants. Names provide candidates only. Check full property IDs, explicit value aliases, slot attachment, contents and restrictions. Existing incompatible slots return alignment_required and the message: Светлый и тёмный компоненты необходимо привести в соответствие. Show differences and pause that component; never bypass with a painted clone, frame or new component. Nested steps are provisional and must be replanned after parent replacement. Missing variants/components are proposals within the search scope, never proof of global absence. This tool does not swap, clone, repair, import or write metadata; review does not authorize writes. See the project theme-conversion skill reference for operation and later stages.',
      inputSchema: themePlanSchema,
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    args => textResult(() => (bridge.pinCurrentFile?.() ?? bridge).call('theme.plan', args)),
  );

  server.registerTool(
    'get_local_styles',
    {
      description: 'Read local paint, text, and effect styles with full paint and typography properties for code handoff.',
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true },
    },
    async () => textResult(() => bridge.call('styles.list', {})),
  );

  server.registerTool(
    'get_variables',
    {
      description: 'Read variables, collections, modes, raw valuesByMode and alias dependencies from the active file without importing or changing them. Optional variableIds can include accessible remote tokens; collectionId filters roots; offset/limit paginate roots while including their dependencies. nodeId supplies consumer context, explicit/resolved modes, native resolveForConsumer values, and alias chains. Without nodeId, cross-collection aliases use labelled collection defaults; modes with matching names are never equated. Inspect warnings, unresolved statuses and pagination; raw values for all modes remain available.',
      inputSchema: variableReadSchema,
      annotations: { readOnlyHint: true },
    },
    async (args) => textResult(() => bridge.call('variables.list', args)),
  );

  server.registerTool(
    'create_page',
    {
      description: 'Create a page in the connected Figma file.',
      inputSchema: z.object({ name: z.string().min(1).max(200) }),
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async (args) => textResult(() => serializeWrite(() => bridge.call('page.create', args))),
  );

  server.registerTool(
    'create_screen',
    {
      description: 'Create one editable Figma screen with frames, text, and rectangles on a chosen page.',
      inputSchema: screenSpecSchema,
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async (args) => textResult(() => serializeWrite(() => bridge.call('screen.create', args))),
  );

  server.registerTool(
    'update_node',
    {
      description: 'Change explicitly listed properties of one editable Figma node. COMPONENT, COMPONENT_SET, GROUP, VECTOR, INSTANCE and ELLIPSE support name-only patches: { name }. Renaming an instance changes only that instance, not its main component. Before modifying finished components, variants, instances or their sublayers, inspect the live source and ask the user to confirm the exact changes. Reuse existing confirmation only for those same objects and changes.',
      inputSchema: updateNodeSchema,
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async (args) => textResult(() => serializeWrite(() => bridge.call('node.update', args))),
  );

  server.registerTool(
    'align_component_schema',
    {
      description: 'Align an existing local standalone target COMPONENT to an explicitly inspected local source COMPONENT: copy its complete BOOLEAN/SLOT schema and bind exact target descendant IDs, plus only the listed supported fields from exact source/target node pairs. In-place FRAME-to-SLOT conversion preserves IDs and children. This CHANGES A FINISHED MASTER and affects its instances. Inspect live schemas, bindings, fields, and instanceImpact, and obtain agreement for that exact scope before apply; reuse the same prior agreement. Source and target must be distinct; target schema initially empty. No orphan properties, names inferred as mappings, imports, detach, node deletion, main-component swaps, or paint changes. Defaults dryRun=true; apply unchanged arguments with dryRun=false and preview expectedState. Recheck source, target, fonts and affected instances; errors stop unsupported transfer. Retry timeouts using the SAME operationId; inspect changed/incomplete receipts rather than bypassing them. Report exact changedNodeIds, createdPropertyIds and cleanup errors if rollback is incomplete. Verify schemas, refs, IDs, styles, instance content and preview after apply. See project component-alignment instructions.',
      inputSchema: componentAlignmentSchema,
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    args => textResult(async () => {
      const target = bridge.pinCurrentFile?.() ?? bridge;
      return serializeWrite(() => target.call('component.schema.align', args));
    }),
  );

  server.registerTool(
    'repair_component_reference',
    {
      description: 'Preview/apply an explicitly approved orphan icon-reference repair on an exact direct-owned INSTANCE inside a local finished component master. Requires exact expected old local orphan main and attached replacement COMPONENT IDs. This changes a finished master and propagates to its instances: inspect full live trees, exact native layout changes and complete instanceImpact; obtain approval for that exact scope, reusing existing exact approval. Preserve icon content, paints, size, visibility and custom instance overrides. Native swap may regenerate derived descendant IDs; inspect returned mapping and previews. No generic swap, name inference, detach, deletion or reparenting. Defaults dryRun=true; apply unchanged request with expectedState. Same operationId for retries; inspect PARTIAL_APPLY/OPERATION_INCOMPLETE instead of bypassing with a new ID. No guaranteed inverse to an orphan main. Stop and report exact changedNodeIds and cause on partial failure; do not silently repair unrelated components.',
      inputSchema: componentReferenceRepairSchema,
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    args => textResult(async () => {
      const target = bridge.pinCurrentFile?.() ?? bridge;
      return serializeWrite(() => target.call('component.reference.repair', args));
    }),
  );

  server.registerTool(
    'probe_modal_slot_structure',
    {
      description: 'Preview/create an operation-owned draft for three fixed Modal API capability tests: Optional label BOOLEAN outside Title SLOT, reparenting new draft Slot content, and custom Title content on a new instance. Normally creates a PAGE; only an exact native Starter page-limit failure with zero created nodes permits one same-ID recovery preview into a new standalone FRAME below content on the current PAGE. Recovery preserves the original receipt/failure, reports existing pageId/new containerId and binds exact placement/top-level geometry. No existing master, instance, style, page property, selection or old alignment receipt is changed. Inputs only operationId/dryRun/expectedState; no arbitrary JS, source nodes or patches. Defaults dryRun=true; apply requires unchanged preview expectedState and authorized diagnostic scope. Retry same operationId; replay validates owned root state, membership, schemas and main links. Any other partial/changed result blocks retry; never bypass with a new ID or reset. Inspect every cases[].passed; applied only records the draft, not safe or approved production migration. Partial results retain IDs/evidence, with no deletion.',
      inputSchema: modalProbeSchema,
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    args => textResult(async () => {
      const target = bridge.pinCurrentFile?.() ?? bridge;
      return serializeWrite(() => target.call('component.modal.probe', args));
    }),
  );

  server.registerTool('compose_source_frame', {
    description: 'Preview/apply an explicitly approved NEW ordinary FRAME composition from a live FRAME/INSTANCE source. Structural FRAME/SLOT nodes become new free-layout frames; INSTANCE fallbacks require exact frameNodeIds. Atomic controls use explicitly mapped local component masters with exact source-descendant to target-master-descendant layerMap and BOOLEAN/TEXT propertyMap. Nested component mappings select light nested controls; other nested icon mains/content are preserved. Source text, visibility and geometry come from inspected nodes, not caller text. Use verified local Paint/Text/Effect styles via layerStyles. Source, existing copies and library remain unchanged; no source detach, library repair, arbitrary JS, node deletion or broad property patches. Defaults dryRun=true; inspect exact maps/fallbacks/placement and reuse prior approval only for that same scope. Apply the unchanged request with expectedState. Source/target/font/style/parent drift fails closed. Retry SAME operationId; verify replay and new mains/tree/PNG. Partial results retain remainingNodeIds and errors; never reset/delete receipts or bypass with a new ID. This creates a composition, not a new reusable Modal schema; visual acceptance belongs to the user.',
    inputSchema: frameCompositionSchema,
    annotations: { readOnlyHint: false, destructiveHint: false },
  }, args => textResult(async () => {
    const target = bridge.pinCurrentFile?.() ?? bridge;
    return serializeWrite(() => target.call('theme.frame.compose', args));
  }));

  server.registerTool(
    'copy_theme_component',
    {
      description: 'Preview/apply one parent component substitution on a NEW INSTANCE copy, preserving the original and library masters. This is a staged operation, not a complete layout conversion: inspect the resulting descendant inventory and replan using new IDs. Resolve the active file, inspect exact source/target masters, properties, slot contents and explicit layerMap (source descendant IDs to target master descendant IDs), then obtain agreement on the exact copy before apply. Defaults dryRun=true, read-only preview; apply requires the unchanged request, dryRun=false and expectedState. Existing incompatible slots require alignment and stop before cloning. Unsupported overrides or ambiguous transfer fail closed; never detach, reset all overrides, repair masters or bypass blockers with recoloring. Retry the SAME operationId after timeout; inspect incomplete/modified receipts, never create a second copy to bypass them. Report ROLLBACK_INCOMPLETE remainingNodeIds and cleanupErrors. Read back main identities, contents and preview; user grants visual acceptance.',
      inputSchema: themeCopySchema,
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    args => textResult(async () => {
      const target = bridge.pinCurrentFile?.() ?? bridge;
      return serializeWrite(() => target.call('theme.copy', args));
    }),
  );

  server.registerTool(
    'duplicate_node',
    {
      description: 'Duplicate a FRAME or INSTANCE under its existing page or free-layout FRAME parent, preserving slots and component links. Only new copies receive the explicitly listed PaintStyle overrides. Inspect live source and agree on the exact source, placement, name and styles first. Defaults to dryRun=true; apply the unchanged request with dryRun=false and expectedState from preview. After timeout retry the same operationId; replay returns the original copy. Never detach instances or guess theme colors. Read back nodeMap and preview before claiming visual parity. Reports remainingNodeIds on incomplete rollback.',
      inputSchema: duplicateNodeSchema,
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async (args) => textResult(async () => {
      const target = bridge.pinCurrentFile?.() ?? bridge;
      return serializeWrite(() => target.call('node.duplicate', args));
    }),
  );

  server.registerTool(
    'create_component_variants',
    {
      description: 'Create explicitly requested variants by cloning local components into their existing local component set (layoutMode NONE). Defaults to dryRun=true: returns names, placements, exact style assignments, requested set size/new values and expectedState without writes. Apply requires dryRun=false and the unchanged expectedState. Existing axes are required; optional newVariantValues explicitly permits used new values on those axes. Optional componentSetSize resizes the set without changing original child geometry. Layer overrides use accessible PaintStyle IDs on new copies only. Inspect the active file and obtain agreement on the exact set, sources, properties, placements, styles and any set size/new values; reuse that same approval. Retry with the same operationId after timeout to recover prior IDs. Returns source-to-clone maps; rollback removes only new nodes and restores operation-written dimensions unless manually changed. Report full rollback details.',
      inputSchema: createComponentVariantsSchema,
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async (args) => textResult(async () => {
      // Pin before entering the write queue, not when this request finally runs.
      const target = bridge.pinCurrentFile?.() ?? bridge;
      return serializeWrite(() => target.call('component.variants.create', args));
    }),
  );

  server.registerTool(
    'delete_node',
    {
      description: 'Delete one Figma node only after the user confirms it in the Figma plugin.',
      inputSchema: z.object({ nodeId }),
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    async ({ nodeId: id }) => textResult(() => serializeWrite(async () => {
      const target = bridge.pinCurrentFile?.() ?? bridge;
      const node = z.object({ id: z.string(), name: z.string(), type: z.string() }).passthrough()
        .parse(await target.call('node.tree', { nodeId: id, depth: 0, offset: 0, limit: 1 }));
      if (node.id !== id || node.type === 'PAGE' || node.type === 'DOCUMENT') throw new Error('UNSUPPORTED_NODE');
      if (!target.confirmDelete) throw new Error('CONFIRMATION_REQUIRED');
      await target.confirmDelete({ nodeId: id, nodeName: node.name || '(без имени)', nodeType: node.type });
      return target.call('node.delete', { nodeId: id });
    })),
  );

  return server;
}

async function textResult(action: () => Promise<unknown>) {
  try {
    return { content: [{ type: 'text' as const, text: JSON.stringify(await action()) }] };
  } catch (error) {
    return errorResult(error);
  }
}

function errorResult(error: unknown) {
  const content = [{ type: 'text' as const, text: error instanceof Error ? error.message : 'FIGMA_API_ERROR' }];
  if (error && typeof error === 'object' && 'details' in error && error.details !== undefined) {
    content.push({ type: 'text', text: JSON.stringify({ details: error.details }) });
  }
  return { content, isError: true };
}
