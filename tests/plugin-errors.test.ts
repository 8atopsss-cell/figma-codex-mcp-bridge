import { afterEach, expect, it, vi } from 'vitest';
import { modalProbeFixture } from './modal-probe-fixture.js';

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });

it('dispatches frame composition and reports unavailable source without writes', async () => {
  const messages: any[] = [];
  const api = { showUI: vi.fn(), ui: { postMessage: (message: unknown) => messages.push(message), onmessage: undefined as unknown as (message: unknown) => Promise<void> },
    root: { getPluginData: () => '', getPluginDataKeys: () => [] }, getNodeByIdAsync: vi.fn(async () => null), createFrame: vi.fn() };
  vi.stubGlobal('figma', api); vi.stubGlobal('__html__', ''); await import('../src/plugin/main.js');
  await api.ui.onmessage({ type: 'plugin.call', requestId: 'compose', method: 'theme.frame.compose', args: { operationId: 'compose-1', nodeId: 'missing', name: 'Light', position: { x: 0, y: 0 } } });
  expect(messages[0]).toMatchObject({ type: 'plugin.error', requestId: 'compose', code: 'SOURCE_CHANGED' });
  expect(api.createFrame).not.toHaveBeenCalled();
});

it('dispatches scratch probe preview without creating draft nodes', async () => {
  const f = modalProbeFixture(); const messages: any[] = [];
  Object.assign(f.api, { showUI: vi.fn(), ui: { postMessage: (message: unknown) => messages.push(message), onmessage: undefined } });
  vi.stubGlobal('figma', f.api); vi.stubGlobal('__html__', '');
  await import('../src/plugin/main.js');
  await f.api.ui.onmessage({ type: 'plugin.call', requestId: 'probe', method: 'component.modal.probe', args: { operationId: 'probe-1' } });
  expect(messages[0]).toMatchObject({ type: 'plugin.result', requestId: 'probe', value: { status: 'preview', capabilityOnly: true } });
  expect(f.api.createPage).not.toHaveBeenCalled();
});

it('dispatches bounded reference repair and reports a missing instance', async () => {
  const messages: any[] = [];
  const api = { showUI: vi.fn(), ui: { postMessage: (message: unknown) => messages.push(message), onmessage: undefined as unknown as (message: unknown) => Promise<void> },
    root: { getPluginData: () => '', getPluginDataKeys: () => [] }, getNodeByIdAsync: vi.fn(async () => null) };
  vi.stubGlobal('figma', api); vi.stubGlobal('__html__', '');
  await import('../src/plugin/main.js');
  await api.ui.onmessage({ type: 'plugin.call', requestId: 'repair', method: 'component.reference.repair', args: {
    instanceId: 'missing-icon', expectedMainComponentId: 'orphan', replacementComponentId: 'wrapper', operationId: 'repair-1',
  } });
  expect(messages[0]).toMatchObject({ type: 'plugin.error', requestId: 'repair', code: 'NODE_NOT_FOUND' });
});

it('dispatches schema alignment and reports the missing source', async () => {
  const messages: any[] = [];
  const api = { showUI: vi.fn(), ui: { postMessage: (message: unknown) => messages.push(message), onmessage: undefined as unknown as (message: unknown) => Promise<void> },
    root: { getPluginData: () => '', getPluginDataKeys: () => [] }, getNodeByIdAsync: vi.fn(async () => null) };
  vi.stubGlobal('figma', api); vi.stubGlobal('__html__', '');
  await import('../src/plugin/main.js');
  await api.ui.onmessage({ type: 'plugin.call', requestId: 'align', method: 'component.schema.align', args: {
    sourceComponentId: 'missing-source', targetComponentId: 'light', operationId: 'align-1', bindings: [{ sourcePropertyId: 'title#d', targetNodeIds: ['light-title'] }],
  } });
  expect(messages).toHaveLength(1);
  expect(messages[0]).toMatchObject({ type: 'plugin.error', requestId: 'align', code: 'NODE_NOT_FOUND' });
});

it('dispatches a theme copy and reports the missing instance', async () => {
  const messages: any[] = [];
  const api = { showUI: vi.fn(), ui: { postMessage: (value: unknown) => messages.push(value), onmessage: undefined as unknown as (value: unknown) => Promise<void> },
    root: { getPluginData: () => '' },
    getNodeByIdAsync: vi.fn(async () => null) };
  vi.stubGlobal('figma', api); vi.stubGlobal('__html__', '');
  await import('../src/plugin/main.js');
  await api.ui.onmessage({ type: 'plugin.call', requestId: 'theme-copy', method: 'theme.copy', args: {
    nodeId: 'missing-instance', libraryRootIds: ['kit'], operationId: 'copy-1', name: 'Light copy', position: { x: 0, y: 0 },
  } });
  expect(messages).toHaveLength(1);
  expect(messages[0]).toMatchObject({ type: 'plugin.error', requestId: 'theme-copy', code: 'NODE_NOT_FOUND' });
});

it.each([
  ['components.list', { rootNodeId: 'missing-kit' }],
  ['theme.plan', { nodeId: 'missing-window', libraryRootIds: ['kit'] }],
])('dispatches read-only %s and reports a missing source', async (method, args) => {
  const messages: any[] = [];
  const api = { showUI: vi.fn(), ui: { postMessage: (value: unknown) => messages.push(value), onmessage: undefined as unknown as (value: unknown) => Promise<void> },
    getNodeByIdAsync: vi.fn(async () => null) };
  vi.stubGlobal('figma', api); vi.stubGlobal('__html__', '');
  await import('../src/plugin/main.js');
  await api.ui.onmessage({ type: 'plugin.call', requestId: 'theme-read', method, args });
  expect(messages[0]).toMatchObject({ type: 'plugin.error', requestId: 'theme-read', code: 'NODE_NOT_FOUND' });
});

it('dispatches duplication and returns the exact missing source ID', async () => {
  const messages: any[] = [];
  const api = {
    showUI: vi.fn(), ui: { postMessage: (message: unknown) => messages.push(message), onmessage: undefined as unknown as (message: unknown) => Promise<void> },
    getNodeByIdAsync: vi.fn(async () => null),
  };
  vi.stubGlobal('figma', api); vi.stubGlobal('__html__', '');
  await import('../src/plugin/main.js');
  await api.ui.onmessage({ type: 'plugin.call', requestId: 'copy', method: 'node.duplicate', args: {
    sourceNodeId: '16079:56961', operationId: 'light-copy', name: 'Modal light', position: { x: 1000, y: 288 },
  } });
  expect(messages).toHaveLength(1);
  expect(messages[0]).toMatchObject({ type: 'plugin.error', requestId: 'copy', code: 'NODE_NOT_FOUND', details: { sourceNodeId: '16079:56961' } });
});

it('queues plugin writes and continues after an earlier write fails', async () => {
  const messages: any[] = [];
  let release!: (value: null) => void;
  let started!: () => void;
  const pending = new Promise<null>((resolve) => { release = resolve; });
  const entered = new Promise<void>((resolve) => { started = resolve; });
  const component = { id: 'component', type: 'COMPONENT', name: 'Original' };
  const api = {
    showUI: vi.fn(), ui: { postMessage: (message: unknown) => messages.push(message), onmessage: undefined as unknown as (message: unknown) => Promise<void> },
    getNodeByIdAsync: vi.fn(async (id: string) => { if (id === 'page') { started(); return pending; } return component; }),
  };
  vi.stubGlobal('figma', api);
  vi.stubGlobal('__html__', '');
  await import('../src/plugin/main.js');
  const first = api.ui.onmessage({ type: 'plugin.call', requestId: 'screen', method: 'screen.create', args: {
    pageId: 'page', name: 'Test', x: 0, y: 0, width: 100, height: 100, children: [],
  } });
  await entered;
  const next = api.ui.onmessage({ type: 'plugin.call', requestId: 'rename', method: 'node.update', args: { nodeId: 'component', patch: { name: 'Changed' } } });
  expect(api.getNodeByIdAsync).toHaveBeenCalledTimes(1);
  release(null);
  await Promise.all([first, next]);
  expect(messages.map((message) => message.type)).toEqual(['plugin.error', 'plugin.result']);
  expect(component.name).toBe('Changed');
});

it('queues theme preview behind pending writes before inspecting its source', async () => {
  const messages: any[] = [];
  let release!: (value: null) => void;
  let started!: () => void;
  const pending = new Promise<null>(resolve => { release = resolve; });
  const entered = new Promise<void>(resolve => { started = resolve; });
  const api = { showUI: vi.fn(), ui: { postMessage: (message: unknown) => messages.push(message), onmessage: undefined as unknown as (message: unknown) => Promise<void> },
    root: { getPluginData: () => '' },
    getNodeByIdAsync: vi.fn(async (id: string) => { if (id === 'page') { started(); return pending; } return null; }) };
  vi.stubGlobal('figma', api); vi.stubGlobal('__html__', '');
  await import('../src/plugin/main.js');
  const first = api.ui.onmessage({ type: 'plugin.call', requestId: 'first', method: 'screen.create', args: {
    pageId: 'page', name: 'Test', x: 0, y: 0, width: 100, height: 100, children: [],
  } });
  await entered;
  const next = api.ui.onmessage({ type: 'plugin.call', requestId: 'next', method: 'theme.copy', args: {
    nodeId: 'instance', libraryRootIds: ['kit'], operationId: 'op', name: 'Light', position: { x: 0, y: 0 },
  } });
  expect(api.getNodeByIdAsync).toHaveBeenCalledTimes(1);
  release(null); await Promise.all([first, next]);
  expect(api.getNodeByIdAsync).toHaveBeenCalledWith('instance');
  expect(messages.map(message => message.requestId)).toEqual(['first', 'next']);
});

it('dispatches the new variant method and returns the exact component-set ID on a missing source', async () => {
  const messages: any[] = [];
  const api = {
    showUI: vi.fn(), ui: { postMessage: (message: unknown) => messages.push(message), onmessage: undefined as unknown as (message: unknown) => Promise<void> },
    getNodeByIdAsync: vi.fn(async () => null),
  };
  vi.stubGlobal('figma', api);
  vi.stubGlobal('__html__', '');
  await import('../src/plugin/main.js');
  await api.ui.onmessage({ type: 'plugin.call', requestId: 'r-variants', method: 'component.variants.create', args: {
    componentSetId: '1599:48606', operationId: 'op-1', variants: [{ sourceComponentId: '1599:48607', properties: { theme: 'light', state: 'descending' }, position: { x: 75, y: 64 } }],
  } });
  expect(messages).toHaveLength(1);
  expect(messages[0]).toMatchObject({ type: 'plugin.error', requestId: 'r-variants', code: 'NODE_NOT_FOUND', details: { componentSetId: '1599:48606' } });
});

it('includes the original Figma exception and requested node in an API error', async () => {
  const messages: unknown[] = [];
  const api = {
    showUI: vi.fn(), ui: { postMessage: (message: unknown) => messages.push(message), onmessage: undefined as unknown as (message: unknown) => Promise<void> },
    getNodeByIdAsync: vi.fn(async () => { throw new Error('in getNodeByIdAsync: Invalid node ID'); }),
  };
  vi.stubGlobal('figma', api);
  vi.stubGlobal('__html__', '');
  await import('../src/plugin/main.js');
  await api.ui.onmessage({ type: 'plugin.call', requestId: 'r1', method: 'node.svg', args: { nodeId: 'I4391:92047;1900:44734;1893:44709' } });
  expect(messages).toEqual([{
    type: 'plugin.error', requestId: 'r1', code: 'FIGMA_API_ERROR',
    message: 'node.svg I4391:92047;1900:44734;1893:44709: in getNodeByIdAsync: Invalid node ID',
  }]);
});
