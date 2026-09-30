import { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { screenSpecSchema, updateNodeSchema } from '../shared/protocol.js';

export interface BridgeCaller {
  call(method: string, args: unknown): Promise<unknown>;
  pairingCode?: string;
  confirmDelete?(node: { nodeId: string; nodeName: string; nodeType: string }): Promise<void>;
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
        description: 'Show the session code that the user enters in the Figma plugin to connect this local bridge.',
        inputSchema: z.object({}),
        annotations: { readOnlyHint: true },
      },
      async () => ({ content: [{ type: 'text', text: bridge.pairingCode! }] }),
    );
  }

  server.registerTool(
    'get_file_overview',
    {
      description: 'Read pages, current page, and selection from the connected Figma file.',
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
      description: 'Read a bounded tree of editable nodes from the connected Figma file.',
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
    'get_local_styles',
    {
      description: 'Read local paint and text styles from the connected Figma file.',
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true },
    },
    async () => textResult(() => bridge.call('styles.list', {})),
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
      description: 'Change explicitly listed properties of one editable Figma node.',
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
      const node = z.object({ id: z.string(), name: z.string(), type: z.string() }).passthrough()
        .parse(await bridge.call('node.tree', { nodeId: id, depth: 0, offset: 0, limit: 1 }));
      if (node.id !== id || node.type === 'PAGE' || node.type === 'DOCUMENT') throw new Error('UNSUPPORTED_NODE');
      if (!bridge.confirmDelete) throw new Error('CONFIRMATION_REQUIRED');
      await bridge.confirmDelete({ nodeId: id, nodeName: node.name || '(без имени)', nodeType: node.type });
      return bridge.call('node.delete', { nodeId: id });
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
