import { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { screenSpecSchema, updateNodeSchema, variableReadSchema } from '../shared/protocol.js';

export interface BridgeCaller {
  call(method: string, args: unknown): Promise<unknown>;
  pairingCode?: string;
  confirmDelete?(node: { nodeId: string; nodeName: string; nodeType: string }): Promise<void>;
  listFiles?(): Array<{ id: string; name: string; active: boolean; visible: boolean }>;
  activateFile?(file: string): void;
  pinCurrentFile?(): Pick<BridgeCaller, 'call' | 'confirmDelete'>;
}

export function createBridgeServer(bridge: BridgeCaller): McpServer {
  const server = new McpServer({ name: 'figma-codex-bridge', version: '0.1.0' });
  const nodeId = z.string().min(1).max(128);
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
        description: 'List every Figma file currently connected to this bridge, including its name and active status.',
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
      description: 'Change explicitly listed properties of one editable Figma node. COMPONENT and COMPONENT_SET support name-only patches. Before modifying finished components, variants, instances or their sublayers, inspect the live source and ask the user to confirm the exact changes. Reuse existing confirmation only for those same objects and changes.',
      inputSchema: updateNodeSchema,
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async (args) => textResult(() => serializeWrite(() => bridge.call('node.update', args))),
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
  return { content: [{ type: 'text' as const, text: error instanceof Error ? error.message : 'FIGMA_API_ERROR' }], isError: true };
}
