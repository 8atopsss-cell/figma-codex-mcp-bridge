import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { describe, expect, it } from 'vitest';
import { createBridgeServer } from '../src/bridge/mcp.js';
import { updateNode } from '../src/plugin/write.js';

describe('MCP bridge', () => {
  it.each(['GROUP', 'VECTOR', 'INSTANCE', 'ELLIPSE'])('renames %s through MCP and returns rejected patches as errors', async (type) => {
    const node = { id: '2:3', type, name: 'Original', x: 20 };
    const api = { getNodeByIdAsync: async () => node } as unknown as Parameters<typeof updateNode>[0];
    const calls: Array<{ method: string; args: unknown }> = [];
    const server = createBridgeServer({ call: async (method, args) => {
      calls.push({ method, args });
      if (method !== 'node.update') throw new Error('Unexpected method');
      return updateNode(api, args);
    } });
    const client = new Client({ name: 'rename-test', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
      const args = { nodeId: node.id, patch: { name: 'Renamed' } };
      const result = await client.callTool({ name: 'update_node', arguments: args });
      expect(result.isError).not.toBe(true);
      expect(result.content).toEqual([{ type: 'text', text: JSON.stringify({ nodeId: node.id, name: 'Renamed' }) }]);
      expect(calls).toEqual([{ method: 'node.update', args }]);
      const rejected = await client.callTool({ name: 'update_node', arguments: { nodeId: node.id, patch: { name: 'Rejected', x: 50 } } });
      expect(rejected.isError).toBe(true);
      expect(rejected.content).toEqual([{ type: 'text', text: 'UNSUPPORTED_NODE' }]);
      expect(node).toEqual({ id: '2:3', type, name: 'Renamed', x: 20 });
    } finally { await client.close(); await server.close(); }
  });

  it('captures the active file before a variant write waits behind another write', async () => {
    let active = 'file-a';
    let release!: () => void;
    let started!: () => void;
    let pinned!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const firstStarted = new Promise<void>((resolve) => { started = resolve; });
    const filePinned = new Promise<void>((resolve) => { pinned = resolve; });
    const files: string[] = [];
    const server = createBridgeServer({
      call: async () => { started(); await blocked; return { pageId: 'page' }; },
      pinCurrentFile: () => {
        const file = active; pinned();
        return { call: async () => { files.push(file); return { status: 'preview' }; } };
      },
    });
    const client = new Client({ name: 'variants-queue', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
      const first = client.callTool({ name: 'create_page', arguments: { name: 'Test' } });
      await firstStarted;
      const next = client.callTool({ name: 'create_component_variants', arguments: {
        componentSetId: 'set', operationId: 'op', variants: [{ sourceComponentId: 'source', properties: { theme: 'light' }, position: { x: 75, y: 64 } }],
      } });
      await filePinned;
      active = 'file-b';
      release();
      await Promise.all([first, next]);
      expect(files).toEqual(['file-a']);
    } finally { release(); await client.close(); await server.close(); }
  });

  it('pins variant creation to the file chosen at invocation and forwards preview arguments', async () => {
    const pinned: Array<{ method: string; args: unknown }> = [];
    const server = createBridgeServer({
      call: async () => { throw new Error('Unpinned call'); },
      pinCurrentFile: () => ({ call: async (method, args) => { pinned.push({ method, args }); return { status: 'preview' }; } }),
    });
    const client = new Client({ name: 'variants-test', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
      const { tools } = await client.listTools();
      expect(tools.find((tool) => tool.name === 'create_component_variants')?.annotations?.readOnlyHint).toBe(false);
      const args = { componentSetId: 'set', operationId: 'op', componentSetSize: { width: 120, height: 200 }, newVariantValues: { theme: ['light'] }, variants: [{ sourceComponentId: 'source', properties: { theme: 'light' }, position: { x: 75, y: 64 } }] };
      const result = await client.callTool({ name: 'create_component_variants', arguments: args });
      expect(result.isError).not.toBe(true);
      expect(pinned).toEqual([{ method: 'component.variants.create', args: { ...args, dryRun: true, variants: [{ ...args.variants[0], layerStyles: [] }] } }]);
    } finally { await client.close(); await server.close(); }
  });

  it('keeps rollback IDs in MCP error details even when the error message is short', async () => {
    const details = { remainingNodeIds: ['new-1', 'new-2'], cause: 'Removal failed' };
    const server = createBridgeServer({ call: async () => { throw Object.assign(new Error('ROLLBACK_INCOMPLETE'), { details }); } });
    const client = new Client({ name: 'variants-errors', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
      const result = await client.callTool({ name: 'create_component_variants', arguments: {
        componentSetId: 'set', operationId: 'op', variants: [{ sourceComponentId: 'source', properties: { theme: 'light' }, position: { x: 75, y: 64 } }],
      } });
      expect(result.isError).toBe(true);
      expect(result.content).toContainEqual({ type: 'text', text: JSON.stringify({ details }) });
    } finally { await client.close(); await server.close(); }
  });

  it('exposes Figma overview and reports a disconnected file', async () => {
    const server = createBridgeServer({
      call: async () => { throw new Error('NOT_CONNECTED'); },
      pairingCode: 'a'.repeat(64),
    });
    const client = new Client({ name: 'bridge-test', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    try {
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
      const { tools } = await client.listTools();
      expect(tools.map((tool) => tool.name)).toContain('get_file_overview');
      expect(tools.map((tool) => tool.name)).toContain('get_pairing_code');

      const pairing = await client.callTool({ name: 'get_pairing_code', arguments: {} });
      expect(pairing.content).toEqual([{ type: 'text', text: 'a'.repeat(64) }]);

      const result = await client.callTool({ name: 'get_file_overview', arguments: {} });
      expect(result.isError).toBe(true);
      expect(result.content).toEqual([{ type: 'text', text: 'NOT_CONNECTED' }]);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('forwards tree arguments and returns a PNG as image content', async () => {
    const calls: Array<{ method: string; args: unknown }> = [];
    const server = createBridgeServer({
      call: async (method, args) => {
        calls.push({ method, args });
        if (method === 'node.preview') return { mimeType: 'image/png', data: 'iVBORw==' };
        if (method === 'node.svg') return '<svg><path /></svg>';
        return { id: '3:1', name: 'Screen' };
      },
    });
    const client = new Client({ name: 'bridge-test', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
      await client.callTool({ name: 'get_node_tree', arguments: { nodeId: '3:1' } });
      expect(calls[0]).toEqual({ method: 'node.tree', args: { nodeId: '3:1', depth: 2, offset: 0, limit: 50 } });
      const image = await client.callTool({ name: 'get_node_preview', arguments: { nodeId: '3:1' } });
      expect(image.content).toEqual([{ type: 'image', mimeType: 'image/png', data: 'iVBORw==' }]);
      const svg = await client.callTool({ name: 'get_node_svg', arguments: { nodeId: '3:2' } });
      expect(svg.content).toEqual([{ type: 'text', text: '<svg><path /></svg>' }]);
      expect(calls[2]).toEqual({ method: 'node.svg', args: { nodeId: '3:2' } });
      const variableResult = await client.callTool({ name: 'get_variables', arguments: { nodeId: '3:1', variableIds: ['V:primary'] } });
      expect(variableResult.isError).not.toBe(true);
      expect(calls[3]).toEqual({ method: 'variables.list', args: { nodeId: '3:1', variableIds: ['V:primary'], offset: 0, limit: 100 } });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('deletes only after the plugin confirms the named node', async () => {
    const calls: string[] = [];
    let accepted = false;
    const server = createBridgeServer({
      call: async (method) => {
        calls.push(method);
        return method === 'node.tree' ? { id: '2:2', name: 'Card', type: 'FRAME' } : { nodeId: '2:2' };
      },
      confirmDelete: async (node) => {
        expect(node).toEqual({ nodeId: '2:2', nodeName: 'Card', nodeType: 'FRAME' });
        if (!accepted) throw new Error('CONFIRMATION_REQUIRED');
      },
    });
    const client = new Client({ name: 'bridge-test', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
      const rejected = await client.callTool({ name: 'delete_node', arguments: { nodeId: '2:2' } });
      expect(rejected.isError).toBe(true);
      expect(calls).toEqual(['node.tree']);
      accepted = true;
      const deleted = await client.callTool({ name: 'delete_node', arguments: { nodeId: '2:2' } });
      expect(deleted.isError).not.toBe(true);
      expect(calls).toEqual(['node.tree', 'node.tree', 'node.delete']);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
