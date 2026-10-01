import { describe, expect, it, vi } from 'vitest';
import { getVariables } from '../src/plugin/variables.js';

const alias = (id: string) => ({ type: 'VARIABLE_ALIAS', id });
const collection = (id = 'theme', modes = [{ modeId: 'light', name: 'Light' }, { modeId: 'dark', name: 'Dark' }]) => ({
  id, key: `${id}-key`, name: id, remote: false, hiddenFromPublishing: false,
  defaultModeId: modes[0].modeId, modes, variableIds: [] as string[], isExtension: false,
});
const variable = (id: string, valuesByMode: Record<string, unknown>, variableCollectionId = 'theme') => ({
  id, key: `${id}-key`, name: id, description: `Token ${id}`, resolvedType: 'COLOR', variableCollectionId,
  remote: false, hiddenFromPublishing: false, scopes: ['ALL_SCOPES'], codeSyntax: { WEB: `var(--${id})` }, valuesByMode,
});
function mockApi(variables: ReturnType<typeof variable>[], collections = [collection()], node?: object) {
  const api = {
    getNodeByIdAsync: vi.fn(async () => node ?? null),
    variables: {
      getLocalVariablesAsync: vi.fn(async () => variables.filter((v) => !v.remote)),
      getLocalVariableCollectionsAsync: vi.fn(async () => collections.filter((c) => !c.remote)),
      getVariableByIdAsync: vi.fn(async (id: string) => variables.find((v) => v.id === id) ?? null),
      getVariableCollectionByIdAsync: vi.fn(async (id: string) => collections.find((c) => c.id === id) ?? null),
    },
  };
  return { api: api as unknown as Parameters<typeof getVariables>[0], mocks: api };
}
const args = { offset: 0, limit: 100 };

describe('variable handoff', () => {
  it('preserves token metadata and every mode with multi-hop alias provenance', async () => {
    const light = { r: 1, g: 0.34, b: 0.13, a: 1 };
    const dark = { r: 0.8, g: 0.2, b: 0.1, a: 1 };
    const tokens = [
      variable('color.action.primary', { light: alias('orange.500'), dark: alias('orange.500') }),
      variable('orange.500', { light: alias('palette.orange'), dark: alias('palette.orange') }),
      variable('palette.orange', { light, dark }),
    ];
    const theme = { ...collection(), variableIds: tokens.map((v) => v.id) };
    const { api } = mockApi(tokens, [theme]);
    const result = await getVariables(api, { ...args, variableIds: [tokens[0].id] });
    expect(result.rootVariableIds).toEqual(['color.action.primary']);
    expect(result.variables).toHaveLength(3);
    expect(result.variables[0]).toMatchObject(tokens[0]);
    expect(result.collections[0]).toMatchObject(theme);
    expect(result.resolutions).toMatchObject([
      { variableId: tokens[0].id, collectionId: 'theme', modeId: 'light', status: 'resolved', value: light },
      { variableId: tokens[0].id, collectionId: 'theme', modeId: 'dark', status: 'resolved', value: dark },
    ]);
    expect(result.resolutions[1].chain.map((step) => [step.variableId, step.modeId])).toEqual([
      ['color.action.primary', 'dark'], ['orange.500', 'dark'], ['palette.orange', 'dark'],
    ]);
  });

  it('uses inherited node modes across collections and includes Figma consumer resolution', async () => {
    const colors = { ...collection('palette'), remote: true };
    const primary = {
      ...variable('primary', { light: alias('orange'), dark: alias('orange') }),
      resolveForConsumer: vi.fn(() => ({ resolvedType: 'COLOR', value: { r: 0.2, g: 0.1, b: 0, a: 1 } })),
    };
    const orange = { ...variable('orange', { light: { r: 1, g: 1, b: 1, a: 1 }, dark: { r: 0.2, g: 0.1, b: 0, a: 1 } }, 'palette'), remote: true };
    const node = { id: '3:1', name: 'Button', type: 'FRAME', explicitVariableModes: {}, resolvedVariableModes: { theme: 'light', palette: 'dark' } };
    const { api } = mockApi([primary, orange], [collection(), colors], node);
    const result = await getVariables(api, { ...args, variableIds: ['primary'], nodeId: '3:1' });
    expect(result.nodeContext).toMatchObject({ nodeId: '3:1', explicitVariableModes: {}, resolvedVariableModes: node.resolvedVariableModes });
    expect(result.variables.find((v) => v.id === 'orange')).toMatchObject({ remote: true, variableCollectionId: 'palette' });
    expect(result.nodeResolutions[0]).toMatchObject({
      variableId: 'primary', resolvedForConsumer: { resolvedType: 'COLOR', value: { r: 0.2, g: 0.1, b: 0, a: 1 } },
      status: 'resolved', chain: [{ modeId: 'light', modeSource: 'nodeResolved' }, { modeId: 'dark', modeSource: 'nodeResolved' }],
    });
    expect(primary.resolveForConsumer).toHaveBeenCalledWith(node);
  });

  it('labels default modes without equating Light and Dark names across collections', async () => {
    const { api } = mockApi([
      variable('primary', { light: alias('base'), dark: alias('base') }),
      variable('base', { p1: 10, p2: 20 }, 'palette'),
    ], [collection(), collection('palette', [{ modeId: 'p1', name: 'Light' }, { modeId: 'p2', name: 'Dark' }])]);
    const result = await getVariables(api, { ...args, variableIds: ['primary'] });
    expect(result.resolutionContext).toBe('collectionDefaults');
    expect(result.resolutions[1]).toMatchObject({ modeId: 'dark', value: 10, chain: [{ modeId: 'dark' }, { modeId: 'p1', modeSource: 'collectionDefault' }] });
  });

  it('reports cycles and missing aliases while preserving the original values', async () => {
    const { api } = mockApi([
      variable('a', { light: alias('b'), dark: alias('missing') }),
      variable('b', { light: alias('a'), dark: 0 }),
    ]);
    const result = await getVariables(api, { ...args, variableIds: ['a'] });
    expect(result.resolutions).toMatchObject([
      { status: 'unresolved', reason: 'ALIAS_CYCLE' }, { status: 'unresolved', reason: 'VARIABLE_NOT_FOUND' },
    ]);
    expect(result.variables[0].valuesByMode).toEqual({ light: alias('b'), dark: alias('missing') });
    expect(result.warnings.join(' ')).toContain('missing');
    expect(result.resolutions[0]).not.toHaveProperty('value');
  });

  it('does not replace a missing value for an inherited mode with the default', async () => {
    const token = { ...variable('space', { light: 8 }), resolvedType: 'FLOAT', resolveForConsumer: vi.fn(() => { throw new Error('missing value'); }) };
    const node = { id: '3:1', name: 'Button', type: 'FRAME', explicitVariableModes: {}, resolvedVariableModes: { theme: 'dark' } };
    const { api } = mockApi([token], [collection()], node);
    const result = await getVariables(api, { ...args, nodeId: '3:1' });
    expect(result.nodeResolutions[0]).toMatchObject({ status: 'unresolved', reason: 'MODE_VALUE_MISSING' });
    expect(result.nodeResolutions[0]).not.toHaveProperty('value');
    expect(result.warnings.join(' ')).toContain('resolveForConsumer');
  });

  it('keeps false, zero, empty text and code syntax without coercion', async () => {
    const { api } = mockApi([
      { ...variable('hidden', { light: false }), resolvedType: 'BOOLEAN' },
      { ...variable('space', { light: 0 }), resolvedType: 'FLOAT' },
      { ...variable('label', { light: '' }), resolvedType: 'STRING' },
    ]);
    const result = await getVariables(api, args);
    expect(result.resolutions.map((v) => v.value)).toEqual([false, 0, '']);
    expect(result.variables[1].codeSyntax).toEqual({ WEB: 'var(--space)' });
  });

  it('paginates roots and includes their alias dependencies outside the page', async () => {
    const { api } = mockApi([variable('a', { light: alias('c') }), variable('b', { light: 2 }), variable('c', { light: 3 })]);
    const first = await getVariables(api, { offset: 0, limit: 1 });
    expect(first.rootVariableIds).toEqual(['a']);
    expect(first.variables.map((v) => v.id)).toEqual(['a', 'c']);
    expect(first.pagination).toEqual({ offset: 0, limit: 1, total: 3, nextOffset: 1 });
    const last = await getVariables(api, { offset: 2, limit: 1 });
    expect(last.pagination.nextOffset).toBeNull();
  });

  it('reads a requested remote collection without importing library variables', async () => {
    const remoteCollection = { ...collection('remote'), remote: true, variableIds: ['library-token'] };
    const token = { ...variable('library-token', { light: 8 }, 'remote'), remote: true };
    const { api } = mockApi([token], [collection(), remoteCollection]);
    const result = await getVariables(api, { ...args, collectionId: 'remote' });
    expect(result.rootVariableIds).toEqual(['library-token']);
    expect(result.variables[0]).toMatchObject({ id: 'library-token', remote: true });
    await expect(getVariables(api, { ...args, collectionId: 'missing' })).rejects.toThrow('COLLECTION_NOT_FOUND');
  });

  it('rejects nonexistent nodes and non-consumer nodes', async () => {
    const { api } = mockApi([]);
    await expect(getVariables(api, { ...args, nodeId: 'missing' })).rejects.toThrow('NODE_NOT_FOUND');
    const { api: pageApi } = mockApi([], [], { id: '0:1', name: 'Page', type: 'PAGE' });
    await expect(getVariables(pageApi, { ...args, nodeId: '0:1' })).rejects.toThrow('UNSUPPORTED_NODE');
  });

  it('reads inherited extension values without replacing the base token values', async () => {
    const extension = {
      ...collection('brand', [{ modeId: 'brand-light', name: 'Light' }, { modeId: 'brand-dark', name: 'Dark' }]),
      isExtension: true, rootVariableCollectionId: 'theme', parentVariableCollectionId: 'theme',
      variableIds: ['primary', 'base'], variableOverrides: { base: { 'brand-dark': 24 } },
    };
    const primary = {
      ...variable('primary', { light: alias('base'), dark: alias('base') }),
      valuesByModeForCollectionAsync: vi.fn(async () => ({ 'brand-light': alias('base'), 'brand-dark': alias('base') })),
      resolveForConsumer: vi.fn(() => ({ value: 24, resolvedType: 'FLOAT' })),
    };
    const base = {
      ...variable('base', { light: 8, dark: 16 }),
      valuesByModeForCollectionAsync: vi.fn(async () => ({ 'brand-light': 8, 'brand-dark': 24 })),
    };
    const node = { id: '3:1', name: 'Brand button', type: 'FRAME', explicitVariableModes: {}, resolvedVariableModes: { brand: 'brand-dark' } };
    const { api } = mockApi([primary, base], [collection(), extension], node);
    const result = await getVariables(api, { ...args, collectionId: 'brand', variableIds: ['primary'], nodeId: node.id });
    expect(result.variables[1]).toMatchObject({ valuesByMode: { light: 8, dark: 16 }, valuesByCollection: { brand: { 'brand-light': 8, 'brand-dark': 24 } } });
    expect(result.nodeResolutions[0]).toMatchObject({ status: 'resolved', value: 24, chain: [{ collectionId: 'brand' }, { collectionId: 'brand' }] });
    expect(result.collections.find((c) => c.id === 'brand')).toMatchObject({ parentVariableCollectionId: 'theme', variableOverrides: extension.variableOverrides });
  });

  it('flags a trace that disagrees with the native Figma value', async () => {
    const token = { ...variable('space', { light: 8 }), resolveForConsumer: vi.fn(() => ({ resolvedType: 'FLOAT', value: 12 })) };
    const node = { id: '3:1', name: 'Button', type: 'FRAME', explicitVariableModes: {}, resolvedVariableModes: { theme: 'light' } };
    const { api } = mockApi([token], [collection()], node);
    const result = await getVariables(api, { ...args, nodeId: node.id });
    expect(result.nodeResolutions[0]).toMatchObject({ status: 'unresolved', reason: 'CONSUMER_RESOLUTION_MISMATCH', resolvedForConsumer: { value: 12 } });
    expect(result.nodeResolutions[0]).not.toHaveProperty('value');
    expect(result.warnings.join(' ')).toContain('use the native consumer value');
  });

  it('reports bounded alias graph and depth failures rather than inventing a value', async () => {
    const tokens = Array.from({ length: 502 }, (_, i) => variable(`v${i}`, { light: i === 501 ? 8 : alias(`v${i + 1}`) }));
    const { api } = mockApi(tokens);
    const result = await getVariables(api, { ...args, variableIds: ['v0'] });
    expect(result.variables).toHaveLength(500);
    expect(result.warnings.join(' ')).toContain('alias graph limited');
    expect(result.resolutions[0]).toMatchObject({ status: 'unresolved', reason: 'ALIAS_DEPTH_LIMIT' });
    expect(result.resolutions[0]).not.toHaveProperty('value');
  });
});
