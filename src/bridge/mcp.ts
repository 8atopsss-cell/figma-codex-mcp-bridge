import { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

export interface BridgeCaller {
  call(method: string, args: unknown): Promise<unknown>;
}

export function createBridgeServer(bridge: BridgeCaller): McpServer {
  const server = new McpServer({ name: 'figma-codex-bridge', version: '0.1.0' });

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

  return server;
}
