import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { copyFixture } from './theme-copy-fixture.js';

async function executor() {
  expect(existsSync('src/plugin/theme-copy.ts'), 'Stage B executor exists').toBe(true);
  return (await import('../src/plugin/theme-copy.js')).copyThemeComponent;
}
describe('parent-first safe theme copy', () => {
  it('previews without writes and copies text, boolean state, dimensions with single root swap', async () => {
    const copy = await executor(), f = copyFixture();
    const preview = await copy(f.api, f.input);
    expect(preview.status).toBe('preview'); expect(preview.expectedState).toBeTruthy();
    expect(f.source.clone).not.toHaveBeenCalled(); expect(f.document.setPluginData).not.toHaveBeenCalled();
    const result = await copy(f.api, { ...f.input, dryRun: false, expectedState: preview.expectedState });
    const root = f.nodes.get(result.nodeId!);
    expect(root.getMainComponentAsync).toBeDefined(); expect(await root.getMainComponentAsync()).toBe(f.light);
    expect(root.swapComponent).toHaveBeenCalledTimes(1);
    expect(root.componentProperties['label#l'].value).toBe('Save edited');
    expect(root.componentProperties['show#l'].value).toBe(false);
    expect(root.children[0].characters).toBe('Save edited'); expect(root.children[0].visible).toBe(false);
    expect([root.width, root.height]).toEqual([f.source.width, f.source.height]);
    expect(f.text.characters).toBe('Save edited'); expect(await f.source.getMainComponentAsync()).toBe(f.dark);
  });
  it('rejects source FRAME, root keep, unmapped layers and paint overrides before clone', async () => {
    const copy = await executor();
    for (const kind of ['frame', 'keep', 'mapping', 'paint']) {
      const f = copyFixture(); let input: any = { ...f.input };
      if (kind === 'frame') f.source.type = 'FRAME';
      if (kind === 'keep') { input.mappings = []; input.sharedComponentIds = ['dark']; }
      if (kind === 'mapping') input.layerMap = {};
      if (kind === 'paint') f.source.overrides = [{ id: f.text.id, overriddenFields: ['fills'] }];
      await expect(copy(f.api, input)).rejects.toThrow(); expect(f.source.clone).not.toHaveBeenCalled();
    }
  });
  it('pins full target/source tree and links, rejecting drift before clone and during font await', async () => {
    const copy = await executor(), f = copyFixture();
    const p = await copy(f.api, f.input); f.lightText.characters = 'changed master';
    await expect(copy(f.api, { ...f.input, dryRun: false, expectedState: p.expectedState })).rejects.toThrow('SOURCE_CHANGED');
    expect(f.source.clone).not.toHaveBeenCalled();
    const p2 = await copy(f.api, f.input);
    f.api.loadFontAsync.mockImplementation(async () => { f.text.characters = 'changed during await'; });
    await expect(copy(f.api, { ...f.input, dryRun: false, expectedState: p2.expectedState })).rejects.toThrow('SOURCE_CHANGED');
    expect(f.page.children).toEqual([f.source]);
    const next = await copy(f.api, f.input); expect(next.previousFailure?.code).toBe('SOURCE_CHANGED');
  });
  it('replays durable receipts, rejects conflicts and externally edited results', async () => {
    const copy = await executor(), f = copyFixture(), p = await copy(f.api, f.input);
    const apply = { ...f.input, dryRun: false, expectedState: p.expectedState };
    const r = await copy(f.api, apply);
    expect((await copy(f.api, apply)).status).toBe('replayed'); expect(f.source.clone).toHaveBeenCalledTimes(1);
    await expect(copy(f.api, { ...apply, name: 'Conflict' })).rejects.toThrow('OPERATION_CONFLICT');
    f.nodes.get(r.nodeId!)!.children[0].characters = 'external edit';
    await expect(copy(f.api, apply)).rejects.toThrow('OPERATION_RESULT_CHANGED');
  });
  it('does not trust swap preservation and rolls back failed transfers', async () => {
    const copy = await executor(), f = copyFixture(), p = await copy(f.api, f.input);
    f.api.loadFontAsync.mockRejectedValue(new Error('Font unavailable'));
    await expect(copy(f.api, { ...f.input, dryRun: false, expectedState: p.expectedState })).rejects.toThrow('Font unavailable');
    expect(f.page.children).toEqual([f.source]); expect(f.lightText.characters).toBe('Light');
  });
  it('replays original result after source drift, rejects missing chunks and incomplete receipts', async () => {
    const copy = await executor(), f = copyFixture(), p = await copy(f.api, f.input);
    const apply = { ...f.input, dryRun: false, expectedState: p.expectedState };
    const r = await copy(f.api, apply); f.text.characters = 'Source changed later';
    expect((await copy(f.api, apply)).status).toBe('replayed');
    f.nodes.get(r.nodeId!)!.setPluginData('theme-copy-v1-chunk-0', '');
    await expect(copy(f.api, apply)).rejects.toThrow('OPERATION_RESULT_CHANGED');
    const g = copyFixture();
    const clean = (await import('../src/shared/theme-copy.js')).themeCopySchema.parse(g.input);
    const { dryRun: _dry, expectedState: _state, ...request } = clean;
    const { stable } = await import('../src/plugin/variant-state.js');
    g.document.setPluginData('theme-copy-v1-copy-button', stable({ request: stable(request), status: 'pending', nodeIds: ['possibly-created'] }));
    await expect(copy(g.api, g.input)).rejects.toThrow('OPERATION_INCOMPLETE');
    expect(g.source.clone).not.toHaveBeenCalled();
  });
  it('recovers applied receipt even after source removed', async () => {
    const copy = await executor(), f = copyFixture(), p = await copy(f.api, f.input);
    const args = { ...f.input, dryRun: false, expectedState: p.expectedState };
    await copy(f.api, args); f.source.remove(); f.nodes.delete(f.source.id);
    expect((await copy(f.api, args)).status).toBe('replayed');
  });
  it('rejects added target layers, unknown override IDs and text formatting loss', async () => {
    const copy = await executor();
    for (const kind of ['coverage', 'override', 'format']) {
      const f = copyFixture();
      if (kind === 'coverage') f.attach(f.light, f.make('extra-visible', 'RECTANGLE'));
      if (kind === 'override') f.source.overrides = [{ id: 'outside-source', overriddenFields: ['characters'] }];
      if (kind === 'format') f.text.fontName = { family: 'Inter', style: 'Bold' };
      let rejected = false;
      try { const p = await copy(f.api, f.input); await copy(f.api, { ...f.input, dryRun: false, expectedState: p.expectedState }); } catch { rejected = true; }
      expect(rejected, kind).toBe(true); expect(f.page.children).toEqual([f.source]);
    }
  });
  it('reports exact rollback survivors and keeps incomplete operation blocked', async () => {
    const copy = await executor(), f = copyFixture(), p = await copy(f.api, f.input);
    const clone = f.source.clone.getMockImplementation()!;
    f.source.clone.mockImplementation(() => { const n = clone(); n.remove.mockImplementation(() => { throw new Error('Cannot remove'); }); return n; });
    f.api.loadFontAsync.mockRejectedValue(new Error('Font fails'));
    let failure: any;
    try { await copy(f.api, { ...f.input, dryRun: false, expectedState: p.expectedState }); } catch (e) { failure = e; }
    expect(failure.code).toBe('ROLLBACK_INCOMPLETE');
    const remaining = f.page.children.find((n: any) => n !== f.source);
    expect(remaining.children.length).toBe(1);
    expect(remaining.children[0].remove).not.toHaveBeenCalled();
    expect(failure.details.remainingNodeIds.sort()).toEqual([remaining.id, ...remaining.children.map((n: any) => n.id)].sort());
    await expect(copy(f.api, f.input)).rejects.toThrow('ROLLBACK_INCOMPLETE');
  });
  it('rejects modified chunk result metadata despite unchanged visual result', async () => {
    const copy = await executor(), f = copyFixture(), p = await copy(f.api, f.input);
    const args = { ...f.input, dryRun: false, expectedState: p.expectedState }, r = await copy(f.api, args), root = f.nodes.get(r.nodeId!)!;
    const count = Number(root.getPluginData('theme-copy-v1-chunks'));
    let value = ''; for (let i = 0; i < count; i++) value += root.getPluginData(`theme-copy-v1-chunk-${i}`);
    const record = JSON.parse(value); record.result.name = 'Forged metadata';
    root.setPluginData('theme-copy-v1-chunk-0', JSON.stringify(record)); root.setPluginData('theme-copy-v1-chunks', '1');
    await expect(copy(f.api, args)).rejects.toThrow('OPERATION_RESULT_CHANGED');
  });
  it('preserves custom unexposed nested icons through explicit layer mapping', async () => {
    const copy = await executor(), f = copyFixture();
    const original = f.make('icon-original', 'COMPONENT'), custom = f.make('icon-custom', 'COMPONENT');
    f.attach(f.kit, original); f.attach(f.kit, custom);
    const targetIcon = f.make('target-icon', 'INSTANCE', { main: original, componentProperties: {} }); f.attach(f.light, targetIcon);
    const sourceIcon = f.make('Isource;source-icon', 'INSTANCE', { main: custom, componentProperties: {}, visible: false }); f.attach(f.source, sourceIcon);
    const input = { ...f.input, layerMap: { ...f.input.layerMap, [sourceIcon.id]: targetIcon.id } };
    const p = await copy(f.api, input), r = await copy(f.api, { ...input, dryRun: false, expectedState: p.expectedState });
    const copied = f.nodes.get(r.nodeMap![sourceIcon.id])!;
    expect(await copied.getMainComponentAsync()).toBe(custom); expect(copied.visible).toBe(false);
    expect(await sourceIcon.getMainComponentAsync()).toBe(custom);
    expect(r.pendingDescendantSteps.every((s: any) => s.status === 'pending')).toBe(true);
  });
  it('transfers compatible SLOT children in order, never clones SLOT, leaves descendants pending', async () => {
    const copy = await executor(), f = copyFixture();
    f.dark.componentPropertyDefinitions = { content: { type: 'SLOT', defaultValue: '', slotSettings: {} } };
    f.light.componentPropertyDefinitions = { content: { type: 'SLOT', defaultValue: '', slotSettings: {} } };
    f.source.componentProperties = { content: { type: 'SLOT', value: '' } };
    f.text.remove(); f.darkText.remove(); f.lightText.remove();
    const ds = f.make('dark-slot', 'SLOT', { componentPropertyReferences: { slotContentId: 'content' } }); f.attach(f.dark, ds);
    const ts = f.make('light-slot', 'SLOT', { componentPropertyReferences: { slotContentId: 'content' } }); f.attach(f.light, ts);
    const slot = f.make('Isource;dark-slot', 'SLOT', { componentPropertyReferences: { slotContentId: 'content' } }); f.attach(f.source, slot);
    const a = f.make('content-text', 'TEXT', { characters: 'Slot custom content' }); f.attach(slot, a);
    const nested = f.make('content-icon', 'INSTANCE', { main: f.dark, componentProperties: {} }); f.attach(slot, nested);
    const input = { ...f.input, mappings: [{ sourceId: 'dark', targetId: 'light' }], layerMap: { [slot.id]: ts.id } };
    const p = await copy(f.api, input), r = await copy(f.api, { ...input, dryRun: false, expectedState: p.expectedState });
    const copied = f.nodes.get(r.nodeId!)!, copiedSlot = copied.children[0];
    expect(copiedSlot.type).toBe('SLOT'); expect(slot.clone).not.toHaveBeenCalled();
    expect(copiedSlot.children.map((n: any) => n.type)).toEqual(['TEXT', 'INSTANCE']);
    expect(copiedSlot.children[0].characters).toBe(a.characters);
    expect(await copiedSlot.children[1].getMainComponentAsync()).toBe(f.dark);
    expect(r.followupRequired).toBe(true); expect(r.pendingDescendantSteps.length).toBeGreaterThan(0);
    expect(r.freshInventory.instances.some((n: any) => n.nodeId === copiedSlot.children[1].id)).toBe(true);
  });
});
