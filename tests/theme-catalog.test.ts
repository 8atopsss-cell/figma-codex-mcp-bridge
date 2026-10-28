import { describe, expect, it } from 'vitest';
import { listComponents, collectComponents } from '../src/plugin/component-catalog.js';
import { themeFixture } from './theme-fixture.js';

describe('read-only component catalog', () => {
  it('paginates a complete scoped scan and includes family/schema provenance', async () => {
    const f = themeFixture();
    const result = await listComponents(f.api, { rootNodeId: 'kit', limit: 2 });
    expect(result).toMatchObject({ scopeComplete: true, total: 7, offset: 0, nextOffset: 2 });
    expect(result.components.map((c: any) => c.id)).toEqual(['modal-dark', 'modal-light']);
    const next = await listComponents(f.api, { rootNodeId: 'kit', offset: 2, limit: 100, query: 'button light' });
    expect(next.total).toBe(3);
    expect(next.components[0]).toMatchObject({ id: 'light-disable', definitionSource: { id: 'buttons-light' } });
    expect(f.kit.loadAsync).toHaveBeenCalled();
    for (const n of f.registry.values()) { expect(n.clone).not.toHaveBeenCalled(); expect(n.setPluginData).not.toHaveBeenCalled(); }
  });

  it('deduplicates overlapping roots and does not count instance descendants as library masters', async () => {
    const f = themeFixture();
    const demo = f.instance('demo', f.darkModal); f.attach(f.kit, demo);
    f.attach(demo, f.make('fake-master', 'COMPONENT', 'Not a local master'));
    const result = await collectComponents(f.api, ['kit', 'buttons-light'], 100);
    expect(result.components).toHaveLength(7);
    expect(result.components.some((c: any) => c.id === 'fake-master')).toBe(false);
  });

  it('fails closed on an incomplete scan rather than declaring a component missing', async () => {
    const f = themeFixture();
    await expect(listComponents(f.api, { rootNodeId: 'kit', scanLimit: 2 })).rejects.toThrow('CATALOG_LIMIT_EXCEEDED');
    await expect(listComponents(f.api, { rootNodeId: 'missing' })).rejects.toThrow('NODE_NOT_FOUND');
    await expect(listComponents(f.api, { rootNodeId: 'window' })).rejects.toThrow('UNSUPPORTED_NODE');
  });

  it('retains schema read failures and rejects remote roots as a complete local search', async () => {
    const f = themeFixture();
    Object.defineProperty(f.lightModal, 'componentPropertyDefinitions', { get() { throw new Error('Conflicting variants'); } });
    const result = await listComponents(f.api, { rootNodeId: 'kit', query: 'modal light' });
    expect(result.components[0]).toMatchObject({ schemaStatus: 'unavailable', warnings: [expect.stringContaining('Conflicting variants')] });
    f.darkModal.remote = true;
    await expect(listComponents(f.api, { rootNodeId: 'modal-dark' })).rejects.toThrow('UNSUPPORTED_NODE');
  });

  it('rejects pagination against an edited catalog snapshot', async () => {
    const f = themeFixture(); const first = await listComponents(f.api, { rootNodeId: 'kit', limit: 1 });
    f.lightModal.name = 'Changed modal';
    await expect(listComponents(f.api, { rootNodeId: 'kit', offset: 1, expectedScopeSnapshot: first.scopeSnapshot })).rejects.toThrow('SOURCE_CHANGED');
  });
});
