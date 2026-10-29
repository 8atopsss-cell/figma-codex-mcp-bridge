import { describe, expect, it, vi } from 'vitest';
import { alignmentFixture } from './component-alignment-fixture.js';
import { repairComponentReference } from '../src/plugin/component-reference-repair.js';
import { componentReferenceRepairSchema } from '../src/shared/component-reference-repair.js';

function fixture() {
  const f = alignmentFixture();
  const old = f.create('orphan', 'COMPONENT', { width: 16, height: 16 });
  const replacement = f.create('attached', 'COMPONENT', { width: 16, height: 16, layoutMode: 'HORIZONTAL' }); f.attach(f.kit, replacement);
  const add = f.create('add', 'COMPONENT'); f.attach(f.kit, add);
  const vector = f.create('vector', 'VECTOR', { width: 16, height: 16 }); f.attach(add, vector);
  const makeIcon = (id: string, main: any) => {
    const icon = f.create(id, 'INSTANCE', { main, width: 16, height: 16, layoutMode: 'NONE' });
    const nested = f.create(`${id}-add`, 'INSTANCE', { name: 'add', main: add, width: 16, height: 16 }); f.attach(icon, nested);
    const leaf = f.create(`${id}-vector`, 'VECTOR', { name: 'Vector', width: 16, height: 16 }); f.attach(nested, leaf);
    return icon;
  };
  const oldNested = makeIcon('old-nested-holder', add).children[0]; f.attach(old, oldNested);
  const replacementNested = makeIcon('replacement-holder', add).children[0]; f.attach(replacement, replacementNested);
  const icon = makeIcon('icon', old); f.attach(f.light, icon);
  const affected = f.create('affected', 'INSTANCE', { main: f.light }); f.attach(f.page, affected);
  // Copy the complete owner, including custom text outside the icon wrapper.
  for (const child of f.light.children) {
    const copy = child.clone(); f.attach(affected, copy);
  }
  const inherited = affected.children.at(-1);
  const native = icon.swapComponent.getMockImplementation();
  const metadata = () => { for (const n of f.nodes.values()) n.getPluginDataKeys ??= vi.fn(() => []); };
  metadata();
  icon.swapComponent.mockImplementation((main: any) => {
    native(main); icon.layoutMode = main.layoutMode;
    inherited.swapComponent(main); inherited.layoutMode = main.layoutMode; metadata();
  });
  f.light.getInstancesAsync.mockResolvedValue([affected]);
  const input = { instanceId: icon.id, expectedMainComponentId: old.id, replacementComponentId: replacement.id, operationId: 'repair-icon' };
  return { ...f, input, old, replacement, add, icon, affected, inherited, metadata };
}

describe('component reference repair', () => {
  it('rejects an oversized full UTF-8 snapshot before any native or receipt writes', async () => {
    const f = fixture(); f.lt.characters = '🙂'.repeat(1_100_000);
    await expect(repairComponentReference(f.api, f.input)).rejects.toThrow('LIMIT_EXCEEDED');
    expect(f.icon.swapComponent).not.toHaveBeenCalled();
    expect(f.document.setPluginData).not.toHaveBeenCalled();
  });
  it('rejects invalid digest versions, malformed receipts and tampered result digests during replay', async () => {
    for (const tamper of [(stored: any) => { delete stored.result; }, (stored: any) => { stored.stateDigestVersion = 99; }, (stored: any) => { stored.stateDigest = stored.stateDigest.slice(0, -1) + (stored.stateDigest.endsWith('0') ? '1' : '0'); }]) {
      const f = fixture(); const p = await repairComponentReference(f.api, f.input);
      await repairComponentReference(f.api, { ...f.input, dryRun: false, expectedState: p.expectedState });
      const key = 'component-reference-repair-v1-operation-repair-icon';
      const receipt = JSON.parse(f.document.getPluginData(key));
      const stored = JSON.parse(Array.from({ length: receipt.chunks }, (_, i) => f.document.getPluginData(`${key}-${i}`)).join(''));
      tamper(stored); f.document.setPluginData(`${key}-0`, JSON.stringify(stored));
      await expect(repairComponentReference(f.api, f.input)).rejects.toThrow('OPERATION_RESULT_CHANGED');
      expect(f.icon.swapComponent).toHaveBeenCalledTimes(1);
    }
  });
  it('uses compact request-bound state for large complete snapshots and validates large replay state', async () => {
    const f = fixture(); f.lt.characters = 'x'.repeat(600_000);
    const p = await repairComponentReference(f.api, f.input);
    expect(p.expectedState!.length).toBeLessThan(100);
    const a = await repairComponentReference(f.api, { ...f.input, dryRun: false, expectedState: p.expectedState });
    expect(a.status).toBe('applied');
    expect((await repairComponentReference(f.api, f.input)).status).toBe('replayed');
    f.lt.characters = f.lt.characters.slice(0, -1) + 'z';
    await expect(repairComponentReference(f.api, f.input)).rejects.toThrow('OPERATION_RESULT_CHANGED');
  });
  it('detects drift anywhere in a large snapshot before native swap', async () => {
    const f = fixture(); f.lt.characters = 'x'.repeat(600_000);
    const p = await repairComponentReference(f.api, f.input);
    f.lt.characters = f.lt.characters.slice(0, -1) + 'z';
    await expect(repairComponentReference(f.api, { ...f.input, dryRun: false, expectedState: p.expectedState })).rejects.toThrow('SOURCE_CHANGED');
    expect(f.icon.swapComponent).not.toHaveBeenCalled();
  });
  it('repairs a hidden icon while preserving master and inherited instance visibility', async () => {
    const f = fixture(); f.icon.visible = false; f.inherited.visible = false;
    const p = await repairComponentReference(f.api, f.input);
    expect(f.icon.swapComponent).not.toHaveBeenCalled();
    const r = await repairComponentReference(f.api, { ...f.input, dryRun: false, expectedState: p.expectedState });
    expect(r.status).toBe('applied'); expect(f.icon.main).toBe(f.replacement);
    expect(f.icon.visible).toBe(false); expect(f.inherited.visible).toBe(false);
    expect(f.icon.children[0].main).toBe(f.add);
    expect((await repairComponentReference(f.api, f.input)).status).toBe('replayed');
  });
  it('requires preview state for apply and rejects unknown parameters', () => {
    const f = fixture(); expect(componentReferenceRepairSchema.parse(f.input).dryRun).toBe(true);
    expect(() => componentReferenceRepairSchema.parse({ ...f.input, dryRun: false })).toThrow();
    expect(() => componentReferenceRepairSchema.parse({ ...f.input, unsafe: true })).toThrow();
  });
  it('previews all affected instances without mutation; applies and replays with native ID mapping', async () => {
    const f = fixture(); const beforeText = f.affected.children[0].children[0].characters;
    const preview = await repairComponentReference(f.api, f.input);
    expect(preview.status).toBe('preview'); expect(preview.instanceImpact.nodeIds).toEqual([f.affected.id]);
    expect(f.icon.swapComponent).not.toHaveBeenCalled();
    const result = await repairComponentReference(f.api, { ...f.input, dryRun: false, expectedState: preview.expectedState });
    expect(result.status).toBe('applied'); expect(f.icon.main).toBe(f.replacement);
    expect(f.icon.children[0].main).toBe(f.add); expect(f.affected.children[0].children[0].characters).toBe(beforeText);
    expect(result.nodeMap?.some(p => p.beforeId !== p.afterId)).toBe(true);
    expect((await repairComponentReference(f.api, { ...f.input, dryRun: false, expectedState: preview.expectedState })).status).toBe('replayed');
    expect(f.icon.swapComponent).toHaveBeenCalledTimes(1);
  });
  it('rejects stale custom text, paint or replacement state before swap', async () => {
    for (const change of [(f: any) => { f.affected.children[0].children[0].characters = 'edited'; }, (f: any) => { f.icon.fills = []; }, (f: any) => { f.replacement.width = 18; }]) {
      const f = fixture(); const p = await repairComponentReference(f.api, f.input); change(f);
      await expect(repairComponentReference(f.api, { ...f.input, dryRun: false, expectedState: p.expectedState })).rejects.toThrow(/SOURCE_CHANGED|PRESERVATION_UNSUPPORTED/);
      expect(f.icon.swapComponent).not.toHaveBeenCalled();
    }
  });
  it('marks partial failure durably; blocks different operation IDs after native paint loss', async () => {
    const f = fixture(); const p = await repairComponentReference(f.api, f.input);
    const swap = f.icon.swapComponent.getMockImplementation();
    f.icon.swapComponent.mockImplementation((main: any) => { swap(main); f.icon.children[0].fills = []; });
    await expect(repairComponentReference(f.api, { ...f.input, dryRun: false, expectedState: p.expectedState })).rejects.toThrow(/PARTIAL_APPLY/);
    await expect(repairComponentReference(f.api, { ...f.input, dryRun: false, expectedState: p.expectedState })).rejects.toThrow(/OPERATION_INCOMPLETE/);
    await expect(repairComponentReference(f.api, { ...f.input, operationId: 'bypass' })).rejects.toThrow(/OPERATION_INCOMPLETE/);
    expect(f.icon.swapComponent).toHaveBeenCalledTimes(1);
  });
  it('rejects owner impact changes during async link capture before mutation', async () => {
    const f = fixture(); const p = await repairComponentReference(f.api, f.input);
    f.inherited.getMainComponentAsync.mockImplementationOnce(async () => { f.affected.x = 99; return f.old; });
    await expect(repairComponentReference(f.api, { ...f.input, dryRun: false, expectedState: p.expectedState })).rejects.toThrow(/SOURCE_CHANGED/);
    expect(f.icon.swapComponent).not.toHaveBeenCalled();
  });
  it('reads variant schema from attached set, never throwing component getter', async () => {
    const f = fixture(); const set = f.create('set', 'COMPONENT_SET', { componentPropertyDefinitions: {} }); f.attach(f.kit, set); f.attach(set, f.light);
    Object.defineProperty(f.light, 'componentPropertyDefinitions', { get() { throw Error('variant getter'); } });
    expect((await repairComponentReference(f.api, f.input)).status).toBe('preview');
  });
  it('preserves arbitrary text and nested metadata that equal old derived node IDs', async () => {
    const f = fixture(); const id = f.icon.children[0].id;
    f.lt.characters = id; f.lt.boundVariables = { fills: [{ type: 'VARIABLE_ALIAS', id }] };
    f.lt.setPluginData('id', id);
    const p = await repairComponentReference(f.api, f.input);
    const r = await repairComponentReference(f.api, { ...f.input, dryRun: false, expectedState: p.expectedState });
    expect(r.status).toBe('applied'); expect(f.lt.characters).toBe(id); expect(f.lt.getPluginData('id')).toBe(id);
    expect(r.changedNodeIds).toContain(f.icon.id); expect(r.changedNodeIds).toContain(f.inherited.id);
    expect(r.changedNodeIds).not.toContain(f.lt.id);
  });
  it('accepts only native mainComponent override bookkeeping and exact optional layout changes', async () => {
    const f = fixture(); const p = await repairComponentReference(f.api, f.input), swap = f.icon.swapComponent.getMockImplementation();
    f.icon.swapComponent.mockImplementation((main: any) => {
      swap(main); f.icon.layoutMode = 'NONE';
      f.icon.overrides = [{ id: f.icon.id, overriddenFields: ['mainComponent'] }];
      f.affected.overrides = [{ id: f.inherited.id, overriddenFields: ['mainComponent'] }];
    });
    expect((await repairComponentReference(f.api, { ...f.input, dryRun: false, expectedState: p.expectedState })).status).toBe('applied');
  });
  it('rejects extra paint override loss even when native link bookkeeping changes', async () => {
    const f = fixture(); f.icon.overrides = [{ id: f.icon.children[0].id, overriddenFields: ['fills', 'mainComponent'] }];
    const p = await repairComponentReference(f.api, f.input), swap = f.icon.swapComponent.getMockImplementation();
    f.icon.swapComponent.mockImplementation((main: any) => { swap(main); f.icon.overrides = [{ id: f.icon.children[0].id, overriddenFields: ['mainComponent'] }]; });
    await expect(repairComponentReference(f.api, { ...f.input, dryRun: false, expectedState: p.expectedState })).rejects.toThrow(/PARTIAL_APPLY/);
  });
  it('validates replay state and refuses native text damage outside the icon', async () => {
    const f = fixture(); const p = await repairComponentReference(f.api, f.input);
    await repairComponentReference(f.api, { ...f.input, dryRun: false, expectedState: p.expectedState });
    f.affected.children[0].children[0].characters = 'after apply';
    await expect(repairComponentReference(f.api, { ...f.input, dryRun: false, expectedState: p.expectedState })).rejects.toThrow(/OPERATION_RESULT_CHANGED/);
  });
  it('rejects loss of existing nested main override even when effective link stays correct', async () => {
    const f = fixture(); f.icon.overrides = [{ id: f.icon.children[0].id, overriddenFields: ['mainComponent'] }];
    const p = await repairComponentReference(f.api, f.input), swap = f.icon.swapComponent.getMockImplementation();
    f.icon.swapComponent.mockImplementation((main: any) => { swap(main); f.icon.overrides = []; });
    await expect(repairComponentReference(f.api, { ...f.input, dryRun: false, expectedState: p.expectedState })).rejects.toThrow(/PARTIAL_APPLY/);
  });
  it('restores only exact nested add links, then verifies native descendants', async () => {
    const f = fixture(), other = f.create('other-add', 'COMPONENT'); f.attach(f.kit, other);
    f.replacement.children[0].main = other;
    const p = await repairComponentReference(f.api, f.input), swap = f.icon.swapComponent.getMockImplementation();
    f.icon.swapComponent.mockImplementation((main: any) => {
      swap(main);
      for (const root of [f.icon, f.inherited]) {
        const nested = root.children[0], native = nested.swapComponent.getMockImplementation();
        nested.swapComponent.mockImplementation((add: any) => { native(add); nested.children[0].name = 'Vector'; f.metadata(); });
      }
    });
    const r = await repairComponentReference(f.api, { ...f.input, dryRun: false, expectedState: p.expectedState });
    expect(r.restoredNestedInstanceIds).toHaveLength(2); expect(f.icon.children[0].main).toBe(f.add);
  });
  it('refuses restoration when custom text changes during native async read', async () => {
    const f = fixture(), other = f.create('other-add', 'COMPONENT'); f.attach(f.kit, other); f.replacement.children[0].main = other;
    const p = await repairComponentReference(f.api, f.input), swap = f.icon.swapComponent.getMockImplementation();
    f.icon.swapComponent.mockImplementation((main: any) => {
      swap(main); f.icon.children[0].getMainComponentAsync.mockImplementationOnce(async () => { f.lt.characters = 'concurrent edit'; return other; });
    });
    await expect(repairComponentReference(f.api, { ...f.input, dryRun: false, expectedState: p.expectedState })).rejects.toThrow(/PARTIAL_APPLY/);
    expect(f.icon.children[0].swapComponent).not.toHaveBeenCalled(); expect(f.lt.characters).toBe('concurrent edit');
  });
  it('persists incomplete state even when malformed native tree prevents audit', async () => {
    const f = fixture(); const p = await repairComponentReference(f.api, f.input), swap = f.icon.swapComponent.getMockImplementation();
    f.icon.swapComponent.mockImplementation((main: any) => { swap(main); f.icon.children[0].children.push(f.icon); });
    await expect(repairComponentReference(f.api, { ...f.input, dryRun: false, expectedState: p.expectedState })).rejects.toThrow(/PARTIAL_APPLY/);
    await expect(repairComponentReference(f.api, { ...f.input, dryRun: false, expectedState: p.expectedState })).rejects.toThrow(/OPERATION_INCOMPLETE/);
  });
  it('chunks Unicode receipts within native entry limits and replays without another swap', async () => {
    const f = fixture(); f.lt.setPluginData('unicode', '🙂'.repeat(15_000));
    const p = await repairComponentReference(f.api, f.input);
    await repairComponentReference(f.api, { ...f.input, dryRun: false, expectedState: p.expectedState });
    for (const [key, value] of f.document.setPluginData.mock.calls) expect(Buffer.byteLength(key + value, 'utf8')).toBeLessThanOrEqual(100_000);
    expect((await repairComponentReference(f.api, { ...f.input, dryRun: false, expectedState: p.expectedState })).status).toBe('replayed');
  });
  it('rejects unsupported TEXT icon topology and attached expected main before swap', async () => {
    for (const mutation of [(f: any) => { f.icon.children[0].children[0].type = 'TEXT'; }, (f: any) => { f.attach(f.kit, f.old); }]) {
      const f = fixture(); mutation(f);
      await expect(repairComponentReference(f.api, f.input)).rejects.toThrow(/PRESERVATION_UNSUPPORTED/); expect(f.icon.swapComponent).not.toHaveBeenCalled();
    }
  });
});
