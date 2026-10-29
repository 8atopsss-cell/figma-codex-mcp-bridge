import { describe, expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { alignmentFixture } from './component-alignment-fixture.js';

async function executor() {
  expect(existsSync('src/plugin/component-alignment.ts'), 'Bounded alignment executor exists').toBe(true);
  return (await import('../src/plugin/component-alignment.js')).alignComponent;
}
async function failedAlignment() {
  const align = await executor(), f = alignmentFixture(), p = await align(f.api, f.input);
  // This recovery fixture models native inverse observed in the live audit.
  // Other fixtures retain their deliberately unsupported SLOT inverse.
  for (const node of [f.ls, f.lb]) {
    const descriptor = Object.getOwnPropertyDescriptor(node, 'componentPropertyReferences')!;
    Object.defineProperty(node, 'componentPropertyReferences', { ...descriptor, set(next: any) {
      descriptor.set!.call(node, next); if (!next?.slotContentId && node.type === 'SLOT') node.type = 'FRAME';
    } });
  }
  f.lt.setTextStyleIdAsync.mockRejectedValueOnce(Error('prior typography failure'));
  await expect(align(f.api, { ...f.input, dryRun: false, expectedState: p.expectedState })).rejects.toThrow(/PARTIAL_APPLY|ROLLBACK_INCOMPLETE/);
  const key = `component-alignment-v1-${f.input.operationId}`;
  expect(f.light.componentPropertyDefinitions).toEqual({});
  return { align, f, key, receipt: JSON.parse(f.document.getPluginData(key)) };
}
describe('bounded in-place component alignment', () => {
  it('binds native SLOTs before fields and BOOLEANs so slot conversion cannot erase requested child state', async () => {
    const align = await executor(), f = alignmentFixture(); const phases: string[] = [];
    for (const node of [f.ls, f.lb, f.lt, f.lbar]) {
      const descriptor = Object.getOwnPropertyDescriptor(node, 'componentPropertyReferences')!;
      Object.defineProperty(node, 'componentPropertyReferences', { ...descriptor, set(next: any) {
        const converts = node.type === 'FRAME' && !!next?.slotContentId;
        descriptor.set!.call(node, next);
        if (converts && node !== f.lt) {
          phases.push(`slot:${node.id}`);
          for (const child of node.children ?? []) { child.componentPropertyReferences = {}; child.layoutSizingHorizontal = 'FILL'; }
        }
        if (next?.visible) phases.push(`boolean:${node.id}`);
      } });
    }
    const style = f.lt.setTextStyleIdAsync.getMockImplementation(); f.lt.setTextStyleIdAsync.mockImplementation(async (id: string) => { phases.push('typography'); await style(id); });
    const p = await align(f.api, f.input), beforeIds = [...f.nodes.keys()];
    expect(p.executionOrder).toEqual(['properties', 'slotBindings', 'fields', 'booleanBindings']);
    const r = await align(f.api, { ...f.input, dryRun: false, expectedState: p.expectedState });
    expect(r.status).toBe('applied'); expect(f.lt.layoutSizingHorizontal).toBe('HUG'); expect(f.lt.componentPropertyReferences.visible).toBe(r.propertyMap!['Optional label#1']);
    expect(f.lb.componentPropertyReferences).toEqual({ slotContentId: r.propertyMap!['content #5'], visible: r.propertyMap!['body copy#2'] });
    expect(phases.findIndex(p => p === 'typography')).toBeGreaterThan(phases.findIndex(p => p === `slot:${f.lb.id}`));
    expect(phases.findIndex(p => p === `boolean:${f.lt.id}`)).toBeGreaterThan(phases.findIndex(p => p === 'typography'));
    expect([...f.nodes.keys()]).toEqual(beforeIds); expect(f.light.deleteComponentProperty).not.toHaveBeenCalled();
  });
  it('reports bounded preservation paths and hashes without exposing text, names or metadata', async () => {
    const align = await executor(), f = alignmentFixture();
    const privateText = 'PRIVATE_TEXT_DO_NOT_RETURN', privateName = 'PRIVATE_LAYER_NAME';
    f.lt.characters = privateText; f.lbar.name = privateName;
    const extras = Array.from({ length: 30 }, (_, i) => { const n = f.create(`diagnostic-${i}`, 'FRAME', { name: `${privateName}-${i}` }); f.attach(f.lbar, n); return n; });
    const descriptor = Object.getOwnPropertyDescriptor(f.lbar, 'componentPropertyReferences')!;
    Object.defineProperty(f.lbar, 'componentPropertyReferences', { ...descriptor, set(next: any) {
      descriptor.set!.call(f.lbar, next);
      if (next?.visible) { f.lt.characters = 'SECRET_CHANGED'; f.lbar.name = 'SECRET_RENAMED'; f.lt.layoutSizingHorizontal = 'FILL'; extras.forEach(n => { n.name = 'SECRET_RENAMED'; }); }
    } });
    const p = await align(f.api, f.input);
    let failure: any; try { await align(f.api, { ...f.input, dryRun: false, expectedState: p.expectedState }); } catch (error) { failure = error; }
    expect(failure?.details.cause).toContain('differences'); expect(failure.details.cause).toContain('layoutSizingHorizontal');
    expect(failure.details.cause).not.toContain(privateText); expect(failure.details.cause).not.toContain(privateName); expect(failure.details.cause).not.toContain('SECRET_CHANGED'); expect(failure.details.cause).not.toContain('SECRET_RENAMED');
    const details = JSON.parse(failure.details.cause.slice(failure.details.cause.indexOf('{')));
    expect(details.differences.length).toBeLessThanOrEqual(20); expect(Buffer.byteLength(JSON.stringify(details.differences), 'utf8')).toBeLessThanOrEqual(2500); expect(details.differencesTruncated).toBe(true);
  });
  it('copies native text style without assigning readonly features or equal writable fields', async () => {
    const align = await executor(), f = alignmentFixture();
    f.dt.openTypeFeatures = { PNUM: true };
    let features = {}, size = 14, fontWrites = 0;
    Object.defineProperty(f.lt, 'openTypeFeatures', { configurable: true, enumerable: true, get: () => features });
    Object.defineProperty(f.lt, 'fontSize', { configurable: true, enumerable: true, get: () => size, set: (value: number) => { fontWrites++; size = value; f.lt.textStyleId = ''; } });
    f.lt.setTextStyleIdAsync.mockImplementation(async (id: string) => { f.lt.textStyleId = id; size = 16; features = { PNUM: true }; f.lt.paragraphSpacing = 10; });
    const p = await align(f.api, f.input);
    expect((await align(f.api, { ...f.input, dryRun: false, expectedState: p.expectedState })).status).toBe('applied');
    expect(f.lt.textStyleId).toBe(f.dt.textStyleId); expect(fontWrites).toBe(0); expect(f.lt.openTypeFeatures).toEqual({ PNUM: true });
  });
  it('rejects differing readonly features without an applicable style before creating properties', async () => {
    const align = await executor(), f = alignmentFixture(); f.dt.textStyleId = ''; f.dt.openTypeFeatures = { PNUM: true };
    Object.defineProperty(f.lt, 'openTypeFeatures', { configurable: true, enumerable: true, get: () => ({}) });
    await expect(align(f.api, f.input)).rejects.toThrow('PRESERVATION_UNSUPPORTED');
    expect(f.light.addComponentProperty).not.toHaveBeenCalled(); expect(f.lt.setTextStyleIdAsync).not.toHaveBeenCalled(); expect(f.document.setPluginData).not.toHaveBeenCalled();
  });
  it('preserves concurrent target typography edits during native style await', async () => {
    const align = await executor(), f = alignmentFixture(), p = await align(f.api, f.input);
    f.lt.setTextStyleIdAsync.mockImplementation(async (id: string) => { f.lt.textStyleId = id; f.lt.fontSize = 99; });
    await expect(align(f.api, { ...f.input, dryRun: false, expectedState: p.expectedState })).rejects.toThrow(/PARTIAL_APPLY|ROLLBACK_INCOMPLETE/);
    expect(f.lt.fontSize).toBe(99);
  });
  it('previews explicit same-operation recovery from a partial baseline and preserves original receipt until approved token apply', async () => {
    const align = await executor(), f = alignmentFixture(), p = await align(f.api, f.input);
    const originalApply = { ...f.input, dryRun: false, expectedState: p.expectedState };
    f.light.addComponentProperty.mockImplementationOnce(() => { throw Error('prior native failure'); });
    await expect(align(f.api, originalApply)).rejects.toThrow(/PARTIAL_APPLY|ROLLBACK_INCOMPLETE/);
    f.ls.layoutGrow = 0; f.ls.layoutSizingHorizontal = 'FIXED'; f.lt.fontSize = 16; f.lt.paragraphSpacing = 10; f.lt.textStyleId = '';
    const key = `component-alignment-v1-${f.input.operationId}`, originalReceipt = f.document.getPluginData(key), writes = f.document.setPluginData.mock.calls.length;
    const recovery = await align(f.api, f.input);
    expect(recovery.status).toBe('preview'); expect(recovery.recovery).toMatchObject({ requiresApproval: true, cause: 'prior native failure', attempt: 1 });
    expect(recovery.expectedState).toMatch(/^alignment-recovery-v1:sha256:[0-9a-f]{64}$/);
    expect(f.document.getPluginData(key)).toBe(originalReceipt); expect(f.document.setPluginData).toHaveBeenCalledTimes(writes);
    await expect(align(f.api, originalApply)).rejects.toThrow('OPERATION_INCOMPLETE');
    const approved = { ...f.input, dryRun: false, expectedState: recovery.expectedState };
    expect((await align(f.api, approved)).status).toBe('applied');
    const nextReceipt = JSON.parse(f.document.getPluginData(key)); expect(nextReceipt.recoveryAttempt).toBe(1); expect(nextReceipt.previousFailures).toEqual([JSON.parse(originalReceipt)]);
    expect((await align(f.api, approved)).status).toBe('replayed');
  });
  it('pins prior receipt text, paints and actual links throughout recovery approval and awaits', async () => {
    for (const kind of ['receipt', 'paint', 'main', 'await']) {
      const { align, f, key } = await failedAlignment(); let nested: any, other: any;
      if (kind === 'main') {
        const main = f.create('recovery-main', 'COMPONENT'); other = f.create('replacement-main', 'COMPONENT'); f.attach(f.kit, main); f.attach(f.kit, other);
        nested = f.create('recovery-nested', 'INSTANCE', { main }); f.attach(f.lbar, nested);
      }
      const p = await align(f.api, f.input), writes = f.document.setPluginData.mock.calls.length;
      if (kind === 'receipt') f.document.setPluginData(key, f.document.getPluginData(key) + ' ');
      if (kind === 'paint') f.lbar.fills[0].color.r = 0;
      if (kind === 'main') nested.main = other;
      if (kind === 'await') f.api.loadFontAsync.mockImplementationOnce(async () => { f.document.setPluginData(key, f.document.getPluginData(key) + ' '); });
      await expect(align(f.api, { ...f.input, dryRun: false, expectedState: p.expectedState })).rejects.toThrow('SOURCE_CHANGED');
      expect(f.light.addComponentProperty).toHaveBeenCalledTimes(5);
      expect(f.document.setPluginData.mock.calls.length).toBe(writes + (kind === 'paint' || kind === 'main' ? 0 : 1));
    }
  });
  it('rejects adopted old properties, converted slots, schema and physical or receipt-only chunks before recovery writes', async () => {
    for (const kind of ['reference', 'instance', 'slot', 'schema', 'chunks', 'receiptChunks']) {
      const { align, f, key, receipt } = await failedAlignment();
      if (kind === 'reference') f.lt.componentPropertyReferences = { visible: receipt.createdPropertyIds[0] };
      if (kind === 'instance') {
        const n = f.create('adopted', 'INSTANCE', { main: f.light, componentProperties: { [receipt.createdPropertyIds[0]]: { type: 'BOOLEAN', value: true } } });
        f.attach(f.page, n); f.light.getInstancesAsync.mockResolvedValue([n]);
      }
      if (kind === 'slot') f.ls.type = 'SLOT';
      if (kind === 'schema') f.light.componentPropertyDefinitions[receipt.createdPropertyIds[0]] = { type: 'BOOLEAN', defaultValue: false };
      if (kind === 'chunks') f.light.setPluginData(`${key}-chunk-0`, '{}');
      if (kind === 'receiptChunks') { receipt.chunks = 1; f.document.setPluginData(key, JSON.stringify(receipt)); }
      const writes = f.document.setPluginData.mock.calls.length;
      await expect(align(f.api, f.input), kind).rejects.toThrow();
      expect(f.document.setPluginData).toHaveBeenCalledTimes(writes); expect(f.light.addComponentProperty).toHaveBeenCalledTimes(5);
    }
  });
  it('limits recovery to three archived failures and preflights complete history bytes', async () => {
    const { align, f, key } = await failedAlignment();
    for (let attempt = 1; attempt <= 3; attempt++) {
      const p = await align(f.api, f.input), old = JSON.parse(f.document.getPluginData(key));
      expect(p.recovery?.attempt).toBe(attempt);
      f.light.addComponentProperty.mockImplementationOnce(() => { throw Error(`recovery failure ${attempt}`); });
      await expect(align(f.api, { ...f.input, dryRun: false, expectedState: p.expectedState })).rejects.toThrow(/PARTIAL_APPLY|ROLLBACK_INCOMPLETE/);
      const next = JSON.parse(f.document.getPluginData(key)); expect(next.previousFailures.at(-1)).toEqual(old); expect(next.previousFailures).toHaveLength(attempt);
    }
    const before = f.document.getPluginData(key);
    await expect(align(f.api, f.input)).rejects.toThrow('OPERATION_INCOMPLETE'); expect(f.document.getPluginData(key)).toBe(before);
    const large = await failedAlignment(); large.receipt.failure = 'x'.repeat(87_000); large.f.document.setPluginData(large.key, JSON.stringify(large.receipt));
    const writes = large.f.document.setPluginData.mock.calls.length;
    await expect(large.align(large.f.api, large.f.input)).rejects.toThrow('LIMIT_EXCEEDED'); expect(large.f.document.setPluginData).toHaveBeenCalledTimes(writes);
  });
  it('pins all seven affected instance custom baselines in recovery preview', async () => {
    const { align, f } = await failedAlignment(); const instances = [], labels = [];
    for (let i = 0; i < 7; i++) {
      const root = f.create(`existing-${i}`, 'INSTANCE', { main: f.light }); f.attach(f.page, root);
      const label = f.create(`custom-${i}`, 'TEXT', { characters: `Customer ${i}`, fillStyleId: `light-${i}` }); f.attach(root, label);
      instances.push(root); labels.push(label);
    }
    f.light.getInstancesAsync.mockResolvedValue(instances);
    const p = await align(f.api, f.input); expect(p.instanceImpact.target).toEqual({ count: 7, nodeIds: instances.map(n => n.id) });
    labels[6].characters = 'edited during approval';
    await expect(align(f.api, { ...f.input, dryRun: false, expectedState: p.expectedState })).rejects.toThrow('SOURCE_CHANGED');
    expect(f.light.addComponentProperty).toHaveBeenCalledTimes(5);
  });
  it('blocks a fresh operation ID bypass and corrupt alignment receipts without writes', async () => {
    const { align, f, key } = await failedAlignment(), before = f.document.getPluginData(key), writes = f.document.setPluginData.mock.calls.length;
    await expect(align(f.api, { ...f.input, operationId: 'bypass-incomplete' })).rejects.toThrow('OPERATION_INCOMPLETE');
    expect(f.document.setPluginData).toHaveBeenCalledTimes(writes); expect(f.document.getPluginData(key)).toBe(before);
    const clean = alignmentFixture(); clean.document.getPluginDataKeys(); clean.document.setPluginData('component-alignment-v1-corrupt', '{broken');
    await expect(align(clean.api, clean.input)).rejects.toThrow('OPERATION_INCOMPLETE'); expect(clean.light.addComponentProperty).not.toHaveBeenCalled();
  });
  it('transports compact digest for complete snapshots above 262 KiB and replays compact receipts', async () => {
    const align = await executor(), f = alignmentFixture();
    for (const node of [f.light, f.ls, f.lb, f.lt, f.lbar]) { node.getPluginDataKeys(); node.setPluginData('large-unicode', 'я'.repeat(30_000)); }
    const p = await align(f.api, f.input);
    expect(p.expectedState).toMatch(/^alignment-state-v2:sha256:[0-9a-f]{64}$/);
    expect(Buffer.byteLength(JSON.stringify(p), 'utf8')).toBeLessThan(20_000);
    const apply = { ...f.input, dryRun: false, expectedState: p.expectedState };
    expect((await align(f.api, apply)).status).toBe('applied');
    const chunks = f.light.getPluginDataKeys().filter((k: string) => k.includes('-chunk-')).sort();
    const stored = JSON.parse(chunks.map((k: string) => f.light.getPluginData(k)).join(''));
    expect(stored.stateDigest).toMatch(/^[0-9a-f]{64}$/); expect(stored.state).toBeUndefined();
    expect(Buffer.byteLength(JSON.stringify(stored), 'utf8')).toBeLessThan(20_000);
    expect((await align(f.api, apply)).status).toBe('replayed');
    expect(f.light.addComponentProperty).toHaveBeenCalledTimes(5);
    f.lbar.setPluginData('large-unicode', 'я'.repeat(29_999) + 'ю');
    await expect(align(f.api, apply)).rejects.toThrow('OPERATION_RESULT_CHANGED');
  });
  it('pins paints and actual main links in complete large captures before first write', async () => {
    const align = await executor();
    for (const kind of ['paint', 'main']) {
      const f = alignmentFixture();
      for (const node of [f.light, f.ls, f.lb, f.lt, f.lbar]) { node.getPluginDataKeys(); node.setPluginData('large', 'x'.repeat(60_000)); }
      const first = f.create('first-main', 'COMPONENT'), second = f.create('second-main', 'COMPONENT');
      f.attach(f.kit, first); f.attach(f.kit, second);
      const nested = f.create('nested-icon', 'INSTANCE', { main: first }); f.attach(f.lbar, nested);
      const p = await align(f.api, f.input);
      if (kind === 'paint') f.lbar.fills[0].color.r = 0;
      else nested.main = second;
      await expect(align(f.api, { ...f.input, dryRun: false, expectedState: p.expectedState })).rejects.toThrow('SOURCE_CHANGED');
      expect(f.light.addComponentProperty).not.toHaveBeenCalled(); expect(f.document.setPluginData).not.toHaveBeenCalled();
    }
  });
  it('validates legacy raw receipts and rejects unknown digest versions', async () => {
    const digest = await import('../src/plugin/snapshot-digest.js'), spy = vi.spyOn(digest, 'snapshotDigest');
    try {
      const align = await executor(), f = alignmentFixture(), p = await align(f.api, f.input);
      const apply = { ...f.input, dryRun: false, expectedState: p.expectedState };
      await align(f.api, apply);
      const key = `component-alignment-v1-${f.input.operationId}`;
      const receipt = JSON.parse(f.document.getPluginData(key));
      const stored = JSON.parse(Array.from({ length: receipt.chunks }, (_, i) => f.light.getPluginData(`${key}-chunk-${i}`)).join(''));
      const nativeCapture = spy.mock.calls.find(([text]) => text.startsWith('alignment-result-v2\0'))![0].split('\0')[2];
      expect(JSON.parse(nativeCapture).records[f.light.id]).toBeDefined();
      const rewrite = (value: unknown) => {
        const points = Array.from(JSON.stringify(value)); let count = 0;
        for (let i = 0; i < points.length; i += 12_000) f.light.setPluginData(`${key}-chunk-${count++}`, points.slice(i, i + 12_000).join(''));
        receipt.chunks = count; f.document.setPluginData(key, JSON.stringify(receipt));
      };
      rewrite({ ...stored, stateDigestVersion: 99 });
      await expect(align(f.api, apply)).rejects.toThrow('OPERATION_RESULT_CHANGED');
      rewrite({ state: nativeCapture, result: stored.result });
      expect((await align(f.api, apply)).status).toBe('replayed');
      f.lbar.fills[0].color.g = 0;
      await expect(align(f.api, apply)).rejects.toThrow('OPERATION_RESULT_CHANGED');
    } finally { spy.mockRestore(); }
  });
  it('retains an 8 MiB internal full-state bound and fails before writes', async () => {
    const align = await executor(), f = alignmentFixture();
    for (let i = 0; i < 90; i++) {
      const node = f.create(`bounded-metadata-${i}`, 'FRAME'); f.attach(f.lbar, node);
      node.getPluginDataKeys(); node.setPluginData('large', 'x'.repeat(96_000));
    }
    await expect(align(f.api, f.input)).rejects.toThrow(/LIMIT_EXCEEDED.*alignment-state.*8388608/);
    expect(f.light.addComponentProperty).not.toHaveBeenCalled(); expect(f.document.setPluginData).not.toHaveBeenCalled();
  });
  it('reads nested variant schemas from their component set and pins owner schema drift', async () => {
    const align = await executor(), f = alignmentFixture();
    const set = f.create('button-set', 'COMPONENT_SET', { componentPropertyDefinitions: { size: { type: 'VARIANT', defaultValue: '32', variantOptions: ['32', '40'] } } });
    f.attach(f.kit, set);
    const main = f.create('button-variant', 'COMPONENT', { variantProperties: { size: '32' } }); f.attach(set, main);
    Object.defineProperty(main, 'componentPropertyDefinitions', { configurable: true, get() { throw new Error('Can only get component property definitions of a component set or non-variant component'); } });
    const instance = f.create('button-instance', 'INSTANCE', { main }); f.attach(f.lbar, instance);
    const p = await align(f.api, f.input);
    expect(p.status).toBe('preview'); expect(f.light.addComponentProperty).not.toHaveBeenCalled();
    set.componentPropertyDefinitions.size.variantOptions.push('48');
    await expect(align(f.api, { ...f.input, dryRun: false, expectedState: p.expectedState })).rejects.toThrow('SOURCE_CHANGED');
    expect(f.light.addComponentProperty).not.toHaveBeenCalled();
    const next = await align(f.api, f.input);
    expect((await align(f.api, { ...f.input, dryRun: false, expectedState: next.expectedState })).status).toBe('applied');
    expect(await instance.getMainComponentAsync()).toBe(main);
  });
  it('previews exact five-property schema without writes; applies slots in place and merges refs', async () => {
    const align = await executor(), f = alignmentFixture();
    const children = f.light.children.map((n: any) => n.id), source = JSON.stringify(f.dark.componentPropertyDefinitions);
    const p = await align(f.api, f.input);
    expect(p.status).toBe('preview'); expect(p.plan.properties).toHaveLength(5);
    expect(f.light.addComponentProperty).not.toHaveBeenCalled(); expect(f.document.setPluginData).not.toHaveBeenCalled(); expect(f.light.setPluginData).not.toHaveBeenCalled();
    const r = await align(f.api, { ...f.input, dryRun: false, expectedState: p.expectedState });
    expect(r.status).toBe('applied'); expect(Object.keys(r.propertyMap!)).toHaveLength(5);
    expect(f.light.children.map((n: any) => n.id)).toEqual(children); expect(f.ls.children).toEqual([f.lt]);
    expect(f.ls.type).toBe('SLOT'); expect(f.lb.type).toBe('SLOT'); expect(f.lbar.type).toBe('FRAME');
    expect(f.lb.componentPropertyReferences).toEqual({ visible: r.propertyMap!['body copy#2'], slotContentId: r.propertyMap!['content #5'] });
    expect(f.lt.fontSize).toBe(16); expect(f.lt.textStyleId).toBe('dark-style'); expect(f.lt.fillStyleId).toBe('light-paint');
    expect(JSON.stringify(f.dark.componentPropertyDefinitions)).toBe(source); expect(f.dt.characters).toBe('Body');
    expect([...f.nodes.values()].every(n => !n.remove.mock.calls.length || ['source','dark-text','light-text'].includes(n.id))).toBe(true);
  });
  it('pins source, instances and fonts before first document write', async () => {
    const align = await executor();
    for (const kind of ['source', 'target', 'font', 'instance']) {
      const f = alignmentFixture();
      const instance = f.create('live-instance', 'INSTANCE', { main: f.light }); f.attach(f.page, instance);
      f.light.getInstancesAsync.mockResolvedValue([instance]);
      const p = await align(f.api, f.input);
      if (kind === 'source') f.dt.characters = 'drift';
      if (kind === 'target') f.lt.characters = 'drift';
      if (kind === 'font') f.api.loadFontAsync.mockImplementation(async () => { f.dt.characters = 'await drift'; });
      if (kind === 'instance') instance.overrides = [{ id: instance.id, overriddenFields: ['visible'] }];
      await expect(align(f.api, { ...f.input, dryRun: false, expectedState: p.expectedState })).rejects.toThrow('SOURCE_CHANGED');
      expect(f.light.addComponentProperty).not.toHaveBeenCalled(); expect(f.document.setPluginData).not.toHaveBeenCalled();
    }
  });
  it('loads old and new fonts before writes, rejects unavailable font', async () => {
    const align = await executor(), f = alignmentFixture(); f.lt.fontName = { family: 'Old', style: 'Bold' };
    const p = await align(f.api, f.input);
    f.api.loadFontAsync.mockRejectedValue(new Error('Font unavailable'));
    await expect(align(f.api, { ...f.input, dryRun: false, expectedState: p.expectedState })).rejects.toThrow('Font unavailable');
    expect(f.light.addComponentProperty).not.toHaveBeenCalled(); expect(f.document.setPluginData).not.toHaveBeenCalled();
  });
  it('replays durable receipt and rejects conflicts, edited result and missing chunks', async () => {
    const align = await executor(), f = alignmentFixture(), p = await align(f.api, f.input);
    const apply = { ...f.input, dryRun: false, expectedState: p.expectedState };
    await align(f.api, apply); f.dt.characters = 'Source can change later';
    expect((await align(f.api, apply)).status).toBe('replayed'); expect(f.light.addComponentProperty).toHaveBeenCalledTimes(5);
    await expect(align(f.api, { ...apply, fields: [] })).rejects.toThrow('OPERATION_CONFLICT');
    f.lt.characters = 'External edit';
    await expect(align(f.api, apply)).rejects.toThrow('OPERATION_RESULT_CHANGED');
    const g = alignmentFixture(), pp = await align(g.api, g.input), aa = { ...g.input, dryRun: false, expectedState: pp.expectedState };
    await align(g.api, aa);
    const key = g.light.getPluginDataKeys().find((k: string) => k.includes('chunk-0'))!;
    g.light.setPluginData(key, ''); await expect(align(g.api, aa)).rejects.toThrow('OPERATION_RESULT_CHANGED');
  });
  it('rejects orphan, cross scope, incomplete bindings, mixed and preexisting schema', async () => {
    const align = await executor();
    for (const kind of ['orphan', 'physicalOrphan', 'cross', 'missing', 'mixed', 'schema', 'ancestor', 'nested']) {
      const f = alignmentFixture(); let input: any = structuredClone(f.input);
      if (kind === 'orphan') f.ds.componentPropertyReferences = {};
      if (kind === 'physicalOrphan') f.attach(f.dark, f.create('orphan-slot', 'SLOT', { componentPropertyReferences: { slotContentId: 'missing-property' } }));
      if (kind === 'cross') input.bindings[0].targetNodeIds = [f.dt.id];
      if (kind === 'missing') input.bindings.pop();
      if (kind === 'mixed') f.dt.fontName = f.api.mixed;
      if (kind === 'schema') f.light.componentPropertyDefinitions.x = { type: 'BOOLEAN', defaultValue: true };
      if (kind === 'ancestor') f.kit.type = 'COMPONENT_SET';
      if (kind === 'nested') { const ins = f.create('nested', 'INSTANCE', { main: f.dark }); f.attach(f.light, ins); f.attach(ins, f.lt); }
      await expect(align(f.api, input), kind).rejects.toThrow(); expect(f.light.addComponentProperty).not.toHaveBeenCalled();
    }
  });
  it('keeps nested light button main; permits only characters inside nested instances', async () => {
    const align = await executor(), f = alignmentFixture();
    const main = f.create('light-button-main', 'COMPONENT', { key: 'button-key', remote: false, componentPropertyDefinitions: {} }); f.attach(f.kit, main);
    const ins = f.create('button-instance', 'INSTANCE', { main }); f.attach(f.lbar, ins);
    const label = f.create('button-label', 'TEXT', { characters: 'lower' }); f.attach(ins, label);
    const input = { ...f.input, fields: [...f.input.fields, { sourceNodeId: f.dt.id, targetNodeId: label.id, fields: ['characters'] }] };
    const p = await align(f.api, input); await align(f.api, { ...input, dryRun: false, expectedState: p.expectedState });
    expect(label.characters).toBe('Body'); expect(await ins.getMainComponentAsync()).toBe(main); expect(ins.swapComponent).not.toHaveBeenCalled();
    const g = alignmentFixture(), nested = g.create('nested', 'INSTANCE', { main: g.dark }); g.attach(g.light, nested); g.attach(nested, g.lt);
    await expect(align(g.api, g.input)).rejects.toThrow();
  });
  it('accepts only native characters/styledTextSegments override growth on exact requested nested labels', async () => {
    const align = await executor();
    for (const unrelated of [false, true]) {
      const f = alignmentFixture();
      const main = f.create('light-button-main', 'COMPONENT', { key: 'button-key', remote: false, componentPropertyDefinitions: {} }); f.attach(f.kit, main);
      const ins = f.create('button-instance', 'INSTANCE', { main }); f.attach(f.lbar, ins);
      const label = f.create('button-label', 'TEXT', { characters: 'lower' }); f.attach(ins, label);
      const icon = f.create('button-icon', 'VECTOR', { visible: false }); f.attach(ins, icon);
      ins.overrides = [{ id: icon.id, overriddenFields: ['visible'] }];
      let value = label.characters;
      Object.defineProperty(label, 'characters', { configurable: true, enumerable: true, get: () => value, set: (next: string) => {
        value = next;
        ins.overrides = [{ id: icon.id, overriddenFields: ['visible'] }, { id: label.id, overriddenFields: ['characters', 'styledTextSegments', ...(unrelated ? ['fills'] : [])] }];
      } });
      const existing = f.create('existing-modal', 'INSTANCE', { main: f.light }); f.attach(f.page, existing);
      const existingButton = f.create('Iexisting-modal;button-instance', 'INSTANCE', { main }); f.attach(existing, existingButton);
      const existingLabel = f.create('Iexisting-modal;button-label', 'TEXT', { characters: 'lower' }); f.attach(existingButton, existingLabel);
      const existingIcon = f.create('Iexisting-modal;button-icon', 'VECTOR', { visible: false }); f.attach(existingButton, existingIcon);
      Object.defineProperty(existingLabel, 'characters', { configurable: true, enumerable: true, get: () => label.characters });
      const reflected = () => ins.overrides.map((row: any) => ({ id: `Iexisting-modal;${row.id}`, overriddenFields: [...row.overriddenFields] }));
      Object.defineProperty(existingButton, 'overrides', { configurable: true, enumerable: true, get: reflected });
      Object.defineProperty(existing, 'overrides', { configurable: true, enumerable: true, get: reflected });
      Object.defineProperty(existing, 'componentProperties', { configurable: true, enumerable: true, get: () => Object.fromEntries(Object.entries(f.light.componentPropertyDefinitions).map(([id, def]: any) => [id, { type: def.type, value: def.defaultValue ?? '' }])) });
      f.light.getInstancesAsync.mockResolvedValue([existing]);
      const input = { ...f.input, fields: [...f.input.fields, { sourceNodeId: f.dt.id, targetNodeId: label.id, fields: ['characters'] }] };
      const p = await align(f.api, input);
      if (unrelated) await expect(align(f.api, { ...input, dryRun: false, expectedState: p.expectedState })).rejects.toThrow(/ROLLBACK_INCOMPLETE|PARTIAL_APPLY/);
      else {
        const r = await align(f.api, { ...input, dryRun: false, expectedState: p.expectedState });
        expect(r.status).toBe('applied'); expect(label.characters).toBe('Body');
        expect(existingLabel.characters).toBe('Body'); expect(existingIcon.visible).toBe(false);
        expect(ins.overrides).toEqual([{ id: icon.id, overriddenFields: ['visible'] }, { id: label.id, overriddenFields: ['characters', 'styledTextSegments'] }]);
      }
    }
  });
  it('reports incomplete inverse without deleting nodes or unrelated properties; blocks retry', async () => {
    const align = await executor(), f = alignmentFixture(), p = await align(f.api, f.input);
    f.light.addComponentProperty.mockImplementationOnce(() => { f.light.componentPropertyDefinitions['unrelated#u'] = { type: 'BOOLEAN', defaultValue: false }; throw new Error('Partial native failure'); });
    const apply = { ...f.input, dryRun: false, expectedState: p.expectedState };
    await expect(align(f.api, apply)).rejects.toThrow(/PARTIAL_APPLY|ROLLBACK_INCOMPLETE/);
    expect(f.light.componentPropertyDefinitions['unrelated#u']).toBeDefined();
    await expect(align(f.api, apply)).rejects.toThrow('OPERATION_INCOMPLETE');
    expect(f.light.deleteComponentProperty).not.toHaveBeenCalledWith('unrelated#u');
  });
  it('rejects missing IDs explicitly, and detects nested main swaps during style await', async () => {
    const align = await executor(), f = alignmentFixture();
    await expect(align(f.api, { ...f.input, sourceComponentId: 'missing-source' })).rejects.toThrow('NODE_NOT_FOUND');
    const a = f.create('button-a', 'COMPONENT', { key: 'key-a', remote: false, componentPropertyDefinitions: {} }); f.attach(f.kit, a);
    const b = f.create('button-b', 'COMPONENT', { key: 'key-b', remote: false, componentPropertyDefinitions: {} }); f.attach(f.kit, b);
    const n = f.create('button', 'INSTANCE', { main: a }); f.attach(f.light, n);
    const p = await align(f.api, f.input);
    f.lt.setTextStyleIdAsync.mockImplementation(async (id: string) => { f.lt.textStyleId = id; n.main = b; });
    await expect(align(f.api, { ...f.input, dryRun: false, expectedState: p.expectedState })).rejects.toThrow(/ROLLBACK_INCOMPLETE|PARTIAL_APPLY/);
    expect(n.main).toBe(b); expect(n.swapComponent).not.toHaveBeenCalled();
  });
  it('rejects paint-bearing style changes and unsupported per-run paint bindings', async () => {
    const align = await executor(), f = alignmentFixture(), p = await align(f.api, f.input);
    f.lt.setTextStyleIdAsync.mockImplementation(async (id: string) => { f.lt.textStyleId = id; f.lt.fillStyleId = 'wrong-paint'; });
    await expect(align(f.api, { ...f.input, dryRun: false, expectedState: p.expectedState })).rejects.toThrow(/ROLLBACK_INCOMPLETE|PARTIAL_APPLY/);
    const g = alignmentFixture();
    g.lt.getStyledTextSegments.mockImplementation(() => [{ start: 0, end: 2, characters: 'Bo', fontName: g.lt.fontName, boundVariables: { fills: { id: 'private-paint', type: 'VARIABLE_ALIAS' } } }, { start: 2, end: 10, characters: 'dy light', fontName: g.lt.fontName, boundVariables: {} }]);
    await expect(align(g.api, g.input)).rejects.toThrow('PRESERVATION_UNSUPPORTED');
    expect(g.light.addComponentProperty).not.toHaveBeenCalled();
  });
  it('accepts native SLOT definitions omitting defaultValue and preserves native readback schema', async () => {
    const align = await executor(), f = alignmentFixture();
    delete f.dark.componentPropertyDefinitions['Title #4'].defaultValue;
    delete f.dark.componentPropertyDefinitions['content #5'].defaultValue;
    const add = f.light.addComponentProperty.getMockImplementation()!;
    f.light.addComponentProperty.mockImplementation((...args: any[]) => { const id = add(...args); if (args[1] === 'SLOT') delete f.light.componentPropertyDefinitions[id].defaultValue; return id; });
    const p = await align(f.api, f.input);
    const r = await align(f.api, { ...f.input, dryRun: false, expectedState: p.expectedState });
    expect(r.status).toBe('applied'); expect(f.light.componentPropertyDefinitions[r.propertyMap!['Title #4']].defaultValue).toBeUndefined();
  });
  it('preserves custom instance text while inherited schema, slot type and typography propagate', async () => {
    const align = await executor(), f = alignmentFixture();
    const root = f.create('existing', 'INSTANCE', { main: f.light }); f.attach(f.page, root);
    const inherited = new Map<string, any>();
    const copy = (master: any, parent: any) => {
      const values = Object.fromEntries(Object.entries(master).filter(([key, value]) => !['id', 'type', 'parent', 'children', '_alignmentData'].includes(key) && typeof value !== 'function'));
      const n = f.create(`Iexisting;${master.id}`, master.type, values); f.attach(parent, n); inherited.set(master.id, n);
      for (const key of ['type', 'componentPropertyReferences', 'fontName', 'fontSize', 'textStyleId', 'paragraphSpacing', 'textAutoResize', 'layoutAlign', 'layoutSizingHorizontal', 'layoutGrow', 'width']) if (key in master) Object.defineProperty(n, key, { configurable: true, enumerable: true, get: () => master[key] });
      Object.defineProperty(n, 'limitViolations', { configurable: true, enumerable: true, get: () => master.type === 'SLOT' ? [] : undefined });
      for (const child of master.children ?? []) copy(child, n);
      return n;
    };
    for (const master of f.light.children) copy(master, root);
    const text = inherited.get(f.lt.id); text.characters = 'Customer edited title';
    root.overrides = [{ id: text.id, overriddenFields: ['characters'] }];
    Object.defineProperty(root, 'componentProperties', { configurable: true, enumerable: true, get: () => Object.fromEntries(Object.entries(f.light.componentPropertyDefinitions).map(([id, def]: any) => [id, { type: def.type, value: def.defaultValue ?? '' }])) });
    f.light.getInstancesAsync.mockResolvedValue([root]);
    const p = await align(f.api, f.input);
    const r = await align(f.api, { ...f.input, dryRun: false, expectedState: p.expectedState });
    expect(r.status).toBe('applied'); expect(text.characters).toBe('Customer edited title'); expect(text.fontSize).toBe(16);
    expect(inherited.get(f.lb.id).type).toBe('SLOT'); expect(root.overrides).toEqual([{ id: text.id, overriddenFields: ['characters'] }]);
    expect(await root.getMainComponentAsync()).toBe(f.light);
  });
  it('preflights native receipt limits and autoRename, and loads fonts for text layout edits', async () => {
    const align = await executor(), f = alignmentFixture();
    f.lt.autoRename = true;
    await expect(align(f.api, f.input)).rejects.toThrow('PRESERVATION_UNSUPPORTED');
    const g = alignmentFixture();
    g.input.fields = [{ sourceNodeId: g.dt.id, targetNodeId: g.lt.id, fields: ['textAutoResize'] }];
    g.lt.fontName = { family: 'Only layout font', style: 'Bold' };
    const p = await align(g.api, g.input); await align(g.api, { ...g.input, dryRun: false, expectedState: p.expectedState });
    expect(g.api.loadFontAsync).toHaveBeenCalledWith({ family: 'Only layout font', style: 'Bold' });
    const h = alignmentFixture(), big = { ...h.input, fields: [], bindings: Array.from({ length: 100 }, (_, i) => ({ sourcePropertyId: `${'source-property'.repeat(8)}#${i}`, targetNodeIds: [`${'target-node'.repeat(10)}${i}`] })) };
    await expect(align(h.api, big)).rejects.toThrow('LIMIT_EXCEEDED'); expect(h.document.setPluginData).not.toHaveBeenCalled();
  });
  it('leaves operation property when user binds it elsewhere during async style setter', async () => {
    const align = await executor(), f = alignmentFixture();
    const foreign = f.create('extra-existing', 'RECTANGLE'); f.attach(f.light, foreign);
    const p = await align(f.api, f.input);
    let property: string;
    f.lt.setTextStyleIdAsync.mockImplementation(async (id: string) => {
      f.lt.textStyleId = id;
      property = Object.keys(f.light.componentPropertyDefinitions).find(k => k.startsWith('Optional label#'))!;
      foreign.componentPropertyReferences = { visible: property };
    });
    const remove = f.light.deleteComponentProperty.getMockImplementation()!;
    f.light.deleteComponentProperty.mockImplementation((id: string) => { for (const n of f.nodes.values()) if (n.componentPropertyReferences?.visible === id) n.componentPropertyReferences = {}; remove(id); });
    await expect(align(f.api, { ...f.input, dryRun: false, expectedState: p.expectedState })).rejects.toThrow('ROLLBACK_INCOMPLETE');
    expect(foreign.componentPropertyReferences.visible).toBe(property!);
    expect(f.light.componentPropertyDefinitions[property!]).toBeDefined();
    expect(f.light.deleteComponentProperty).not.toHaveBeenCalledWith(property!);
  });
  it('audits existing instances after rollback instead of reporting a restored master as restored operation', async () => {
    const align = await executor(), f = alignmentFixture();
    const instance = f.create('custom-instance', 'INSTANCE', { main: f.light }); f.attach(f.page, instance);
    const text = f.create('custom-instance-text', 'TEXT', { characters: 'Customer text' }); f.attach(instance, text);
    instance.overrides = [{ id: text.id, overriddenFields: ['characters'] }]; f.light.getInstancesAsync.mockResolvedValue([instance]);
    const input = { ...f.input, fields: [], bindings: f.input.bindings.filter(b => f.dark.componentPropertyDefinitions[b.sourcePropertyId].type === 'BOOLEAN') };
    delete f.dark.componentPropertyDefinitions['Title #4']; delete f.dark.componentPropertyDefinitions['content #5'];
    f.ds.type = 'FRAME'; f.db.type = 'FRAME'; f.ds.componentPropertyReferences = {}; f.db.componentPropertyReferences = { visible: 'body copy#2' };
    const p = await align(f.api, input);
    const add = f.light.addComponentProperty.getMockImplementation()!;
    f.light.addComponentProperty.mockImplementation((...args: any[]) => { text.characters = 'LOST'; return add(...args); });
    let error: any;
    try { await align(f.api, { ...input, dryRun: false, expectedState: p.expectedState }); } catch (e) { error = e; }
    expect(error.code).toBe('ROLLBACK_INCOMPLETE'); expect(error.details.restored).toBe(false);
    expect(error.details.changedNodeIds).toContain(text.id); expect(text.characters).toBe('LOST');
    expect(f.light.componentPropertyDefinitions).toEqual({}); expect(f.ls.type).toBe('FRAME');
  });
});
