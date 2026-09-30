import { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

export interface BridgeCaller {
  call(method: string, args: unknown): Promise<unknown>;
  pairingCode?: string;
}

export function createBridgeServer(bridge: BridgeCaller): McpServer {
  const server = new McpServer({ name: 'figma-codex-bridge', version: '0.1.0' });
  const nodeId = z.string().min(1).max(128);

  if (bridge.pairingCode) {
    server.registerTool(
      'get_pairing_code',
      {
        description: 'Show the one-time code that the user enters in the Figma plugin to connect this local bridge.',
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
