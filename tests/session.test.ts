import { once } from 'node:events';
import WebSocket from 'ws';
import { describe, expect, it } from 'vitest';
import { startBridgeSocketServer } from '../src/bridge/session.js';

const token = 'a'.repeat(64);

describe('local Figma session', () => {
  it('preserves complete rollback details through the socket reply', async () => {
    const bridge = await startBridgeSocketServer({ port: 0, token });
    const socket = new WebSocket(`ws://127.0.0.1:${bridge.port}`, { origin: 'null' });
    try {
      await once(socket, 'open');
      const hello = once(socket, 'message');
      socket.send(JSON.stringify({ type: 'hello', token }));
      await hello;
      const message = once(socket, 'message');
      const result = bridge.session.call('component.variants.create', {
        componentSetId: 'set', operationId: 'op', variants: [{ sourceComponentId: 'source', properties: { theme: 'light' }, position: { x: 75, y: 64 } }],
      });
      const details = { remainingNodeIds: Array.from({ length: 20 }, (_, index) => `new-${index}`), cause: 'Removal failed' };
      const rejected = expect(result).rejects.toMatchObject({ details });
      const request = JSON.parse(String((await message)[0]));
      socket.send(JSON.stringify({ type: 'plugin.error', requestId: request.requestId, code: 'ROLLBACK_INCOMPLETE', message: 'Cleanup failed', details }));
      await rejected;
    } finally { socket.close(); await bridge.close(); }
  });

  it('preserves plugin error details for the MCP caller', async () => {
    const bridge = await startBridgeSocketServer({ port: 0, token });
    const socket = new WebSocket(`ws://127.0.0.1:${bridge.port}`, { origin: 'null' });
    try {
      await once(socket, 'open');
      const hello = once(socket, 'message');
      socket.send(JSON.stringify({ type: 'hello', token }));
      await hello;
      const message = once(socket, 'message');
      const result = bridge.session.call('node.tree', { nodeId: '4391:92046', depth: 0, offset: 0, limit: 1 });
      const rejected = expect(result).rejects.toThrow('FIGMA_API_ERROR: node.tree 4391:92046: Component set has existing errors');
      const request = JSON.parse(String((await message)[0]));
      socket.send(JSON.stringify({ type: 'plugin.error', requestId: request.requestId, code: 'FIGMA_API_ERROR', message: 'node.tree 4391:92046: Component set has existing errors' }));
      await rejected;
    } finally {
      socket.close();
      await bridge.close();
    }
  });

  it('keeps two files connected and routes commands to the visible tab', async () => {
    const bridge = await startBridgeSocketServer({ port: 0, token });
    const first = new WebSocket(`ws://127.0.0.1:${bridge.port}`, { origin: 'null' });
    const second = new WebSocket(`ws://127.0.0.1:${bridge.port}`, { origin: 'null' });
    const opened = [once(first, 'open'), once(second, 'open')];
    try {
      for (const [index, socket] of [first, second].entries()) {
        await opened[index];
        const hello = Promise.race([
          once(socket, 'message').then(() => true),
          once(socket, 'close').then(() => false),
        ]);
        socket.send(JSON.stringify({ type: 'hello', token }));
        expect(await hello).toBe(true);
      }
      expect(bridge.session.connectionCount).toBe(2);

      first.send(JSON.stringify({ type: 'file.presence', visible: true, active: true }));
      second.send(JSON.stringify({ type: 'file.presence', visible: false, active: false }));
      await new Promise((resolve) => setTimeout(resolve, 20));
      const firstMessage = once(first, 'message');
      const firstResult = bridge.session.call('file.overview', {});
      const firstRequest = JSON.parse(String((await firstMessage)[0]));
      first.send(JSON.stringify({ type: 'plugin.result', requestId: firstRequest.requestId, value: { fileName: 'First' } }));
      await expect(firstResult).resolves.toEqual({ fileName: 'First' });

      first.send(JSON.stringify({ type: 'file.presence', visible: false, active: false }));
      second.send(JSON.stringify({ type: 'file.presence', visible: true, active: true }));
      await new Promise((resolve) => setTimeout(resolve, 20));
      const secondMessage = once(second, 'message');
      const secondResult = bridge.session.call('file.overview', {});
      const secondRequest = JSON.parse(String((await secondMessage)[0]));
      second.send(JSON.stringify({ type: 'plugin.result', requestId: secondRequest.requestId, value: { fileName: 'Second' } }));
      await expect(secondResult).resolves.toEqual({ fileName: 'Second' });
    } finally {
      first.close();
      second.close();
      await bridge.close();
    }
  });

  it('fails closed when active tab is unknown and keeps requests isolated by file', async () => {
    const bridge = await startBridgeSocketServer({ port: 0, token });
    const first = new WebSocket(`ws://127.0.0.1:${bridge.port}`, { origin: 'null' });
    const second = new WebSocket(`ws://127.0.0.1:${bridge.port}`, { origin: 'null' });
    const opened = [once(first, 'open'), once(second, 'open')];
    try {
      for (const [index, socket] of [first, second].entries()) {
        await opened[index];
        const hello = Promise.race([
          once(socket, 'message').then(() => true),
          once(socket, 'close').then(() => false),
        ]);
        socket.send(JSON.stringify({ type: 'hello', token }));
        expect(await hello).toBe(true);
      }
      first.send(JSON.stringify({ type: 'file.presence', visible: false, active: false }));
      second.send(JSON.stringify({ type: 'file.presence', visible: false, active: false }));
      await new Promise((resolve) => setTimeout(resolve, 20));
      await expect(bridge.session.call('page.create', { name: 'Wrong file' })).rejects.toThrow('FILE_SELECTION_REQUIRED');

      first.send(JSON.stringify({ type: 'file.presence', visible: true, active: false }));
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(bridge.session.listFiles()[0].active).toBe(true);

      first.send(JSON.stringify({ type: 'file.presence', visible: true, active: true }));
      await new Promise((resolve) => setTimeout(resolve, 20));
      const incoming = once(first, 'message');
      const result = bridge.session.call('file.overview', {});
      const request = JSON.parse(String((await incoming)[0]));
      second.send(JSON.stringify({ type: 'plugin.result', requestId: request.requestId, value: { fileName: 'Wrong' } }));
      first.send(JSON.stringify({ type: 'plugin.result', requestId: request.requestId, value: { fileName: 'Right' } }));
      await expect(result).resolves.toEqual({ fileName: 'Right' });

      expect(() => bridge.session.activateFile(bridge.session.listFiles()[0].id)).not.toThrow();
      expect(() => bridge.session.activateFile(bridge.session.listFiles()[1].id)).toThrow('ACTIVE_FILE_ALREADY_DETECTED');
      expect(bridge.session.listFiles()[0].active).toBe(true);
      first.send(JSON.stringify({ type: 'file.presence', visible: false, active: false }));
      second.send(JSON.stringify({ type: 'file.presence', visible: false, active: false }));
      await new Promise((resolve) => setTimeout(resolve, 20));
      bridge.session.activateFile(bridge.session.listFiles()[1].id);
      expect(bridge.session.listFiles()[1].active).toBe(true);
      expect(bridge.session.listFiles()[1].visible).toBe(false);
      const selectedMessage = once(second, 'message');
      const selectedResult = bridge.session.call('file.overview', {});
      const selectedRequest = JSON.parse(String((await selectedMessage)[0]));
      second.send(JSON.stringify({ type: 'plugin.result', requestId: selectedRequest.requestId, value: { fileName: 'Selected' } }));
      await expect(selectedResult).resolves.toEqual({ fileName: 'Selected' });

      const pinned = bridge.session.pinCurrentFile();
      bridge.session.activateFile(bridge.session.listFiles()[0].id);
      const pinnedMessage = once(second, 'message');
      const pinnedResult = pinned.call('file.overview', {});
      const pinnedRequest = JSON.parse(String((await pinnedMessage)[0]));
      second.send(JSON.stringify({ type: 'plugin.result', requestId: pinnedRequest.requestId, value: { fileName: 'Still second' } }));
      await expect(pinnedResult).resolves.toEqual({ fileName: 'Still second' });
    } finally {
      first.close();
      second.close();
      await bridge.close();
    }
  });

  it('pairs one plugin and correlates replies by request ID', async () => {
    const bridge = await startBridgeSocketServer({ port: 0, token });
    const socket = new WebSocket(`ws://127.0.0.1:${bridge.port}`, { origin: 'null' });
    try {
      await once(socket, 'open');
      const hello = once(socket, 'message');
      socket.send(JSON.stringify({ type: 'hello', token }));
      expect(JSON.parse(String((await hello)[0])).type).toBe('hello.ok');

      const message = once(socket, 'message');
      const result = bridge.session.call('file.overview', {});
      const request = JSON.parse(String((await message)[0]));
      expect(request.method).toBe('file.overview');
      socket.send(JSON.stringify({ type: 'plugin.result', requestId: request.requestId, value: { pages: ['A'] } }));
      await expect(result).resolves.toEqual({ pages: ['A'] });
    } finally {
      socket.close();
      await bridge.close();
    }
  });

  it('rejects a wrong token and fails pending calls on disconnect', async () => {
    const bridge = await startBridgeSocketServer({ port: 0, token });
    const stranger = new WebSocket(`ws://127.0.0.1:${bridge.port}`, { origin: 'null' });
    try {
      await once(stranger, 'open');
      const closed = once(stranger, 'close');
      stranger.send(JSON.stringify({ type: 'hello', token: 'wrong' }));
      await closed;
      await expect(bridge.session.call('file.overview', {})).rejects.toThrow('NOT_CONNECTED');

      const socket = new WebSocket(`ws://127.0.0.1:${bridge.port}`, { origin: 'null' });
      await once(socket, 'open');
      const hello = once(socket, 'message');
      socket.send(JSON.stringify({ type: 'hello', token }));
      await hello;
      const message = once(socket, 'message');
      const result = bridge.session.call('file.overview', {});
      await message;
      socket.close();
      await expect(result).rejects.toThrow('FIGMA_DISCONNECTED');
    } finally {
      await bridge.close();
    }
  });

  it('requires an explicit plugin confirmation before deletion', async () => {
    const bridge = await startBridgeSocketServer({ port: 0, token });
    const socket = new WebSocket(`ws://127.0.0.1:${bridge.port}`, { origin: 'null' });
    try {
      await once(socket, 'open');
      const hello = once(socket, 'message');
      socket.send(JSON.stringify({ type: 'hello', token }));
      await hello;

      const prompt = once(socket, 'message');
      const refused = bridge.session.confirmDelete({ nodeId: '2:2', nodeName: 'Card', nodeType: 'FRAME' });
      const request = JSON.parse(String((await prompt)[0]));
      expect(request).toEqual(expect.objectContaining({ type: 'confirmation.request', nodeId: '2:2', nodeName: 'Card' }));
      socket.send(JSON.stringify({ type: 'confirmation.reply', confirmationId: request.confirmationId, accepted: false }));
      await expect(refused).rejects.toThrow('CONFIRMATION_REQUIRED');

      const secondPrompt = once(socket, 'message');
      const accepted = bridge.session.confirmDelete({ nodeId: '2:2', nodeName: 'Card', nodeType: 'FRAME' });
      const second = JSON.parse(String((await secondPrompt)[0]));
      socket.send(JSON.stringify({ type: 'confirmation.reply', confirmationId: second.confirmationId, accepted: true }));
      await expect(accepted).resolves.toBeUndefined();
    } finally {
      socket.close();
      await bridge.close();
    }
  });
});
