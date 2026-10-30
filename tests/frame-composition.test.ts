import { describe, expect, it, vi } from 'vitest';
import { composeSourceFrame } from '../src/plugin/frame-composition.js';
import { copyFixture } from './theme-copy-fixture.js';

function fixture() {
  const f = copyFixture(); let next = 0;
  const source = f.make('frame', 'FRAME', { width: 506, height: 365, layoutMode: 'NONE', fills: [] }); f.attach(f.page, source); f.attach(source, f.source);
  const heading = f.make('heading', 'TEXT', { characters: 'Native heading', x: 20, y: 10 }); f.attach(source, heading);
  f.light.createInstance = vi.fn(() => {
    const n = f.make(`new-${++next}`, 'INSTANCE', { main: f.light });
    f.attach(f.page, n); n.swapComponent(f.light); return n;
  });
  f.api.createFrame = vi.fn(() => { const n = f.make(`new-${++next}`, 'FRAME', { layoutMode: 'NONE', fillStyleId: '', strokeStyleId: '', effectStyleId: '' }); f.attach(f.page, n); return n; });
  f.api.createText = vi.fn(() => { const n = f.make(`new-${++next}`, 'TEXT'); f.attach(f.page, n); return n; });
  f.api.getStyleByIdAsync = vi.fn(async (id: string) => id === 'paint' ? { id, type: 'PAINT', name: 'light', paints: [] } : null);
  const args = { nodeId: source.id, operationId: 'compose', name: 'Light', position: { x: 700, y: 0 }, frameNodeIds: [],
    componentMappings: [{ sourceNodeId: f.source.id, targetComponentId: f.light.id, propertyMap: { 'label#d': 'label#l', 'show#d': 'show#l' }, layerMap: { [f.text.id]: f.lightText.id } }], layerStyles: [] };
  return { ...f, source, control: f.source, heading, args };
}

describe('bounded native source frame composition', () => {
  it('previews without writes, creates native text and light controls, then replays without duplicate', async () => {
    const f = fixture(); const p = await composeSourceFrame(f.api, f.args);
    expect(p.status).toBe('preview'); expect(p.expectedState).toMatch(/sha256:[a-f0-9]{64}$/); expect(f.api.createFrame).not.toHaveBeenCalled(); expect(f.document.setPluginData).not.toHaveBeenCalled();
    const a = await composeSourceFrame(f.api, { ...f.args, dryRun: false, expectedState: p.expectedState });
    expect(a.status).toBe('applied'); const root = f.nodes.get(a.nodeId!)!;
    expect([root.width, root.height, root.x]).toEqual([506, 365, 700]);
    expect(root.children.map((n: any) => n.type)).toEqual(['INSTANCE', 'TEXT']);
    expect(root.children[0].main.id).toBe('light'); expect(root.children[0].children[0].characters).toBe('Save edited'); expect(root.children[0].children[0].visible).toBe(false);
    expect(root.children[1].characters).toBe('Native heading'); expect(f.heading.clone).not.toHaveBeenCalled();
    expect((await composeSourceFrame(f.api, f.args)).status).toBe('replayed'); expect(f.api.createFrame).toHaveBeenCalledTimes(1);
    root.x++;
    await expect(composeSourceFrame(f.api, f.args)).rejects.toThrow('OPERATION_RESULT_CHANGED');
  });
  it.each(['source', 'target', 'style', 'font'] as const)('blocks %s drift before writes', async kind => {
    const f = fixture(); f.args.layerStyles = [{ nodeId: f.source.id, fillStyleId: 'paint' }] as any;
    const style = { id: 'paint', type: 'PAINT', name: 'light', paints: [] as unknown[] }; f.api.getStyleByIdAsync.mockImplementation(async () => style);
    const p = await composeSourceFrame(f.api, f.args);
    if (kind === 'source') f.heading.characters += '!';
    if (kind === 'target') f.lightText.characters += '!';
    if (kind === 'style') style.paints.push({ type: 'SOLID' });
    if (kind === 'font') f.api.loadFontAsync.mockImplementation(async () => { f.heading.fontSize = 23; });
    await expect(composeSourceFrame(f.api, { ...f.args, dryRun: false, expectedState: p.expectedState })).rejects.toThrow('SOURCE_CHANGED');
    expect(f.api.createFrame).not.toHaveBeenCalled();
  });
  it('blocks out of scope, omitted atomic layers and mixed typography before writes', async () => {
    for (const kind of ['scope', 'coverage', 'mixed']) {
      const f = fixture();
      if (kind === 'scope') f.args.frameNodeIds.push('light');
      if (kind === 'coverage') f.args.componentMappings[0].layerMap = {} as any;
      if (kind === 'mixed') f.heading.fontSize = f.api.mixed;
      await expect(composeSourceFrame(f.api, f.args)).rejects.toThrow(); expect(f.api.createFrame).not.toHaveBeenCalled();
    }
  });
  it('retains owned partial IDs and prevents duplicate after creation fails', async () => {
    const f = fixture(); const p = await composeSourceFrame(f.api, f.args); f.api.createText.mockImplementation(() => { throw new Error('native failure'); });
    const a = await composeSourceFrame(f.api, { ...f.args, dryRun: false, expectedState: p.expectedState });
    expect(a.status).toBe('partial'); expect(a.remainingNodeIds!.length).toBeGreaterThan(1);
    const again = await composeSourceFrame(f.api, f.args); expect(again.status).toBe('partial'); expect(again.remainingNodeIds).toEqual(a.remainingNodeIds); expect(f.api.createFrame).toHaveBeenCalledTimes(1);
    await expect(composeSourceFrame(f.api, { ...f.args, operationId: 'bypass-partial' })).rejects.toThrow('OPERATION_INCOMPLETE');
  });
  it('blocks a structural readonly typography override without a text style before writes', async () => {
    const f = fixture(); Object.defineProperty(f.heading, 'openTypeFeatures', { get: () => ({ TNUM: true }) });
    await expect(composeSourceFrame(f.api, f.args)).rejects.toThrow('TRANSFER_UNSUPPORTED'); expect(f.api.createFrame).not.toHaveBeenCalled();
  });
  it('loads source and target fonts, uses native text style setter and leaves readonly features intact', async () => {
    const f = fixture(); f.heading.textStyleId = 'text-style';
    Object.defineProperty(f.heading, 'openTypeFeatures', { get: () => ({ TNUM: true }) });
    f.api.getStyleByIdAsync.mockImplementation(async (id: string) => id === 'text-style' ? { id, type: 'TEXT', name: 'Heading', fontName: f.heading.fontName } : null);
    const originalCreate = f.api.createText.getMockImplementation()!;
    f.api.createText.mockImplementation(() => { const n = originalCreate(); n.textStyleId = ''; let features = {}; Object.defineProperty(n, 'openTypeFeatures', { get: () => features }); n.setTextStyleIdAsync = vi.fn(async (id: string) => { n.textStyleId = id; features = { TNUM: true }; }); return n; });
    const p = await composeSourceFrame(f.api, f.args); const a = await composeSourceFrame(f.api, { ...f.args, dryRun: false, expectedState: p.expectedState });
    expect(a.status).toBe('applied'); expect(f.nodes.get(a.nodeMap!.heading).openTypeFeatures).toEqual({ TNUM: true }); expect(f.api.loadFontAsync).toHaveBeenCalledWith(f.heading.fontName);
  });
  it('preserves per-edge strokes when aggregate strokeWeight is native mixed', async () => {
    const f = fixture(); Object.assign(f.source, { strokeWeight: f.api.mixed, strokeTopWeight: 1, strokeRightWeight: 0, strokeBottomWeight: 2, strokeLeftWeight: 0 });
    const make = f.api.createFrame.getMockImplementation()!; f.api.createFrame.mockImplementation(() => Object.assign(make(), { strokeWeight: 1, strokeTopWeight: 1, strokeRightWeight: 1, strokeBottomWeight: 1, strokeLeftWeight: 1 }));
    const p = await composeSourceFrame(f.api, f.args); const a = await composeSourceFrame(f.api, { ...f.args, dryRun: false, expectedState: p.expectedState }); expect(a.status).toBe('applied'); expect(f.nodes.get(a.nodeId!).strokeBottomWeight).toBe(2);
  });
  it('returns retained partial when a native setter ignores content', async () => {
    const f = fixture(), make = f.api.createText.getMockImplementation()!;
    f.api.createText.mockImplementation(() => { const n = make(); Object.defineProperty(n, 'characters', { get: () => 'wrong', set: () => {} }); return n; });
    const p = await composeSourceFrame(f.api, f.args), a = await composeSourceFrame(f.api, { ...f.args, dryRun: false, expectedState: p.expectedState }); expect(a.status).toBe('partial'); expect(a.error?.code).toBe('PRESERVATION_FAILED');
  });
  it('detects late source drift during awaited style capture', async () => {
    const f = fixture(); f.args.layerStyles = [{ nodeId: f.source.id, fillStyleId: 'paint' }] as any; const p = await composeSourceFrame(f.api, f.args);
    let reads = 0; f.api.getStyleByIdAsync.mockImplementation(async (id: string) => { if (++reads === 3) f.heading.characters += '!'; return { id, type: 'PAINT', paints: [], name: 'light' }; });
    await expect(composeSourceFrame(f.api, { ...f.args, dryRun: false, expectedState: p.expectedState })).rejects.toThrow('SOURCE_CHANGED'); expect(f.api.createFrame).not.toHaveBeenCalled();
  });
  it('detects source and result private metadata drift without exposing values', async () => {
    const f = fixture(); f.heading.getPluginDataKeys = () => ['private']; f.heading.setPluginData('private', 'first'); const p = await composeSourceFrame(f.api, f.args); f.heading.setPluginData('private', 'second');
    await expect(composeSourceFrame(f.api, { ...f.args, dryRun: false, expectedState: p.expectedState })).rejects.toThrow('SOURCE_CHANGED');
    f.heading.setPluginData('private', 'first'); const a = await composeSourceFrame(f.api, { ...f.args, dryRun: false, expectedState: p.expectedState }); const root = f.nodes.get(a.nodeId!); root.getPluginDataKeys = () => ['private', 'codex-compose-owner-v1']; root.setPluginData('private', 'edited');
    await expect(composeSourceFrame(f.api, f.args)).rejects.toThrow('OPERATION_RESULT_CHANGED');
  });
  it('seals sibling placement before creating the approved new composition', async () => {
    const f = fixture(), oldCopy = f.make('old-copy', 'FRAME', { x: 1018, y: 0, width: 506, height: 365 }); f.attach(f.page, oldCopy);
    const p = await composeSourceFrame(f.api, f.args); oldCopy.y = 440;
    await expect(composeSourceFrame(f.api, { ...f.args, dryRun: false, expectedState: p.expectedState })).rejects.toThrow('SOURCE_CHANGED'); expect(f.api.createFrame).not.toHaveBeenCalled();
  });
  it('preserves source atomic typography while retaining a real light main', async () => {
    const f = fixture(); f.text.fontName = { family: 'Inter', style: 'Regular' }; f.lightText.fontName = { family: 'Inter', style: 'Medium' };
    const p = await composeSourceFrame(f.api, f.args), a = await composeSourceFrame(f.api, { ...f.args, dryRun: false, expectedState: p.expectedState }); expect(a.status).toBe('applied'); expect(f.nodes.get(a.nodeMap![f.text.id]).fontName).toEqual(f.text.fontName);
  });
  it('reports partial when native property setter discards BOOLEAN state', async () => {
    const f = fixture(), create = f.light.createInstance.getMockImplementation()!;
    f.light.createInstance.mockImplementation(() => { const n = create(); n.setProperties = () => {}; return n; });
    const p = await composeSourceFrame(f.api, f.args), a = await composeSourceFrame(f.api, { ...f.args, dryRun: false, expectedState: p.expectedState }); expect(a.status).toBe('partial'); expect(a.error?.code).toBe('PRESERVATION_FAILED');
  });
  it('normalizes variant values only through explicit request mapping', async () => {
    const f = fixture(); f.control.componentProperties.size = { type: 'VARIANT', value: '32px' };
    f.light.componentPropertyDefinitions.size = { type: 'VARIANT', defaultValue: '32', variantOptions: ['32'] }; f.light.variantProperties = { size: '32' };
    await expect(composeSourceFrame(f.api, f.args)).rejects.toThrow('TRANSFER_UNSUPPORTED');
    (f.args.componentMappings[0] as any).valueMap = { size: { '32px': '32' } };
    const p = await composeSourceFrame(f.api, f.args); expect(p.status).toBe('preview');
    f.light.variantProperties.size = '40';
    await expect(composeSourceFrame(f.api, f.args)).rejects.toThrow('TRANSFER_UNSUPPORTED');
  });
  it.each([false, true])('preserves custom nested icon or explicit light nested main (mapping=%s)', async explicit => {
    const f = fixture();
    const custom = f.make('custom-icon', 'COMPONENT'), standard = f.make('standard-icon', 'COMPONENT'); f.attach(f.kit, custom); f.attach(f.kit, standard);
    const cv = f.make('custom-vector', 'VECTOR', { vectorPaths: [{ windingRule: 'NONZERO', data: 'M1 2L3 4' }] }), sv = f.make('standard-vector', 'VECTOR', { vectorPaths: [] }); f.attach(custom, cv); f.attach(standard, sv);
    const si = f.make('Isource;icon', 'INSTANCE', { main: custom, visible: false }), ti = f.make('target-icon', 'INSTANCE', { main: standard }); f.attach(f.control, si); f.attach(f.light, ti);
    f.attach(f.dark, f.make('icon', 'INSTANCE', { main: custom }));
    const sourceVector = f.make('IIsource;icon;custom-vector', 'VECTOR', { vectorPaths: cv.vectorPaths }); f.attach(si, sourceVector); const targetVector = f.make('Itarget-icon;standard-vector', 'VECTOR', { vectorPaths: [] }); f.attach(ti, targetVector);
    (f.args.componentMappings[0].layerMap as any)[si.id] = ti.id;
    if (explicit) f.args.componentMappings.push({ sourceNodeId: si.id, targetComponentId: standard.id, propertyMap: {}, layerMap: { [sourceVector.id]: sv.id } } as any);
    const p = await composeSourceFrame(f.api, f.args); const a = await composeSourceFrame(f.api, { ...f.args, dryRun: false, expectedState: p.expectedState });
    expect(a.status).toBe('applied'); const icon = f.nodes.get(a.nodeMap![si.id]); expect(icon.main.id).toBe(explicit ? standard.id : custom.id); expect(icon.visible).toBe(false);
  });
});
