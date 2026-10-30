import { describe, expect, it } from 'vitest';
import { probeModalStructure } from '../src/plugin/modal-probe.js';
import { modalProbeFixture } from './modal-probe-fixture.js';

const args = { operationId: 'scratch-1' };
const receiptKey = 'modal-probe-v1-operation-scratch-1';
async function pageLimitFailure(f: ReturnType<typeof modalProbeFixture>) {
  f.state.pageLimit = true;
  const result = await apply(f);
  expect(result.status).toBe('partial'); expect(result.createdNodeIds).toEqual([]);
  return f.root.getPluginData(receiptKey);
}
async function apply(f: ReturnType<typeof modalProbeFixture>) {
  const p = await probeModalStructure(f.api, args);
  return probeModalStructure(f.api, { ...args, dryRun: false, expectedState: p.expectedState });
}
describe('bounded scratch modal capability probe', () => {
  it('recovers exact zero-node page-cap failure once under same ID inside one new owned frame', async () => {
    const f = modalProbeFixture(); f.user.y = 500; f.user.height = 100;
    const original = await pageLimitFailure(f); const oldReceipt = JSON.parse(original);
    const writes = f.root.setPluginData.mock.calls.length;
    const p = await probeModalStructure(f.api, args);
    expect(p.status).toBe('preview'); expect(p.pageId).toBe(f.page.id);
    expect(p.containerType).toBe('FRAME'); expect(p.placement).toEqual({ x: 0, y: 800, width: 2600, height: 1200 });
    expect(p.recovery?.previousFailure).toEqual(oldReceipt.failure); expect(p.recovery?.attempt).toBe(1);
    expect(f.root.getPluginData(receiptKey)).toBe(original); expect(f.root.setPluginData.mock.calls).toHaveLength(writes);
    expect(f.api.createFrame).not.toHaveBeenCalled();
    const before = { name: f.page.name, backgrounds: f.page.backgrounds, metadata: f.page.getPluginDataKeys(), selection: f.page.selection };
    const r = await probeModalStructure(f.api, { ...args, dryRun: false, expectedState: p.expectedState });
    expect(r.status).toBe('applied'); expect(r.cases.map(c => c.passed)).toEqual([true, true, true]);
    expect(r.pageId).toBe(f.page.id); expect(r.containerType).toBe('FRAME'); expect(r.containerId).toBeTruthy();
    expect(r.createdNodeIds).not.toContain(f.page.id); expect(f.api.createPage).toHaveBeenCalledTimes(1);
    const frame = f.nodes.get(r.containerId!); expect(frame.parent).toBe(f.page); expect(frame.layoutMode).toBe('NONE'); expect(frame.clipsContent).toBe(false);
    expect([frame.x, frame.y, frame.width, frame.height]).toEqual([0, 800, 2600, 1200]);
    expect(f.page.children).toEqual([f.user, frame]); expect(f.user.characters).toBe('Untouched');
    expect({ name: f.page.name, backgrounds: f.page.backgrounds, metadata: f.page.getPluginDataKeys(), selection: f.page.selection }).toEqual(before);
    expect(f.page.setPluginData).not.toHaveBeenCalled();
    for (const id of r.createdNodeIds) { let node = f.nodes.get(id); while (node && node !== frame) node = node.parent; expect(node).toBe(frame); }
    const receipt = JSON.parse(f.root.getPluginData(receiptKey));
    expect(receipt.recovery.originalReceipt).toBe(original); expect(receipt.recovery.previousFailure).toEqual(oldReceipt.failure);
    const creates = f.state.creates; const replay = await probeModalStructure(f.api, args);
    expect(replay.status).toBe('replayed'); expect(replay.containerId).toBe(frame.id); expect(f.state.creates).toBe(creates);
  });
  it.each(['generic', 'nodes', 'page', 'chunks', 'nested-marker', 'nested-chunks', 'recovery'] as const)('blocks unsafe page-limit recovery: %s', async edit => {
    const f = modalProbeFixture(); await pageLimitFailure(f); const receipt = JSON.parse(f.root.getPluginData(receiptKey));
    if (edit === 'generic') receipt.failure.message = 'native create failed';
    if (edit === 'nodes') receipt.createdNodeIds = [f.user.id];
    if (edit === 'page') receipt.pageId = f.page.id;
    if (edit === 'chunks') f.root.setPluginData(`${receiptKey}-0`, 'orphan');
    if (edit === 'nested-chunks') f.user.setPluginData(`${receiptKey}-0`, 'orphan');
    if (edit === 'nested-marker') f.user.setPluginData('modal-probe-v1-owner', JSON.stringify({ operationId: args.operationId, requestHash: receipt.requestHash, version: 1 }));
    if (edit === 'recovery') receipt.recovery = { attempt: 1 };
    f.root.setPluginData(receiptKey, JSON.stringify(receipt));
    await expect(probeModalStructure(f.api, args)).rejects.toThrow(/OPERATION_INCOMPLETE|OPERATION_CONFLICT/);
    expect(f.api.createFrame).not.toHaveBeenCalled(); expect(f.api.createPage).toHaveBeenCalledTimes(1);
  });
  it.each(['geometry', 'selection', 'page', 'receipt', 'marker', 'membership'] as const)('blocks recovery drift during font load: %s', async edit => {
    const f = modalProbeFixture(); await pageLimitFailure(f); const p = await probeModalStructure(f.api, args);
    f.api.loadFontAsync.mockImplementation(async () => {
      if (edit === 'geometry') f.user.y++;
      if (edit === 'selection') f.page.selection = [];
      if (edit === 'page') f.api.currentPage = f.make('PAGE', 'other-page');
      if (edit === 'receipt') f.root.setPluginData(receiptKey, f.root.getPluginData(receiptKey) + ' ');
      if (edit === 'marker') f.user.setPluginData('modal-probe-v1-owner', JSON.stringify({ operationId: args.operationId }));
      if (edit === 'membership') f.page.appendChild(f.make('TEXT'));
    });
    await expect(probeModalStructure(f.api, { ...args, dryRun: false, expectedState: p.expectedState })).rejects.toThrow('SOURCE_CHANGED');
    expect(f.api.createFrame).not.toHaveBeenCalled();
  });
  it.each(['x', 'width', 'fills', 'clipsContent', 'layoutMode', 'parent'] as const)('rejects recovered frame %s drift on replay', async edit => {
    const f = modalProbeFixture(); await pageLimitFailure(f); const r = await apply(f); const frame = f.nodes.get(r.containerId!);
    if (edit === 'parent') { const page = f.make('PAGE', 'foreign-page'); f.root.appendChild(page); page.appendChild(frame); }
    else if (edit === 'fills') frame.fills = [{ type: 'SOLID', color: { r: 1, g: 0, b: 0 } }];
    else if (edit === 'layoutMode') frame.layoutMode = 'VERTICAL';
    else if (edit === 'clipsContent') frame.clipsContent = true;
    else frame[edit]++;
    await expect(probeModalStructure(f.api, args)).rejects.toThrow('OPERATION_RESULT_CHANGED');
  });
  it('permanently blocks partial fallback without overwriting original failure history', async () => {
    const f = modalProbeFixture(); const original = await pageLimitFailure(f); f.state.failCreateAt = 2;
    const r = await apply(f); expect(r.status).toBe('partial');
    expect(JSON.parse(f.root.getPluginData(receiptKey)).recovery.originalReceipt).toBe(original);
    await expect(probeModalStructure(f.api, args)).rejects.toThrow('OPERATION_INCOMPLETE');
    expect(f.api.createFrame).toHaveBeenCalledTimes(1);
  });
  it.each(['nonfinite', 'overflow', 'rotation', 'duplicate'] as const)('rejects unbounded recovery context: %s', async edit => {
    const f = modalProbeFixture(); await pageLimitFailure(f);
    if (edit === 'nonfinite') f.user.y = Number.NaN;
    if (edit === 'overflow') f.user.y = 999_900;
    if (edit === 'rotation') f.user.rotation = 45;
    if (edit === 'duplicate') f.page.children.push(f.user);
    await expect(probeModalStructure(f.api, args)).rejects.toThrow('LIMIT_EXCEEDED');
    expect(f.api.createFrame).not.toHaveBeenCalled();
  });
  it('does not demand-load unrelated pages or recursively enumerate unrelated scene trees', async () => {
    const f = modalProbeFixture(); await pageLimitFailure(f);
    const unloaded = f.make('PAGE', 'unloaded-page'); f.root.appendChild(unloaded);
    Object.defineProperty(unloaded, 'children', { get() { throw Error('unloaded page'); } });
    // Existing nested content is irrelevant: eligible v1 failed before creating its owned PAGE.
    Object.defineProperty(f.user, 'children', { get() { throw Error('large unrelated subtree must not be read'); } });
    const p = await probeModalStructure(f.api, args); expect(p.status).toBe('preview');
    expect(p.placement).toEqual({ x: 0, y: 230, width: 2600, height: 1200 });
    expect(f.api.createFrame).not.toHaveBeenCalled();
  });
  it('uses transformed top-level bounds and blocks stale recovery state before font loading', async () => {
    const f = modalProbeFixture(); await pageLimitFailure(f);
    f.user.rotation = 45; f.user.absoluteBoundingBox = { x: -50, y: 100, width: 150, height: 300 };
    const p = await probeModalStructure(f.api, args); expect(p.placement).toEqual({ x: -50, y: 600, width: 2600, height: 1200 });
    const fontCalls = f.api.loadFontAsync.mock.calls.length; f.user.absoluteBoundingBox.height++;
    await expect(probeModalStructure(f.api, { ...args, dryRun: false, expectedState: p.expectedState })).rejects.toThrow('SOURCE_CHANGED');
    expect(f.api.loadFontAsync.mock.calls).toHaveLength(fontCalls); expect(f.api.createFrame).not.toHaveBeenCalled();
  });
  it('previews fixed plan read-only with request-bound SHA state', async () => {
    const f = modalProbeFixture(); const p = await probeModalStructure(f.api, args);
    expect(p.status).toBe('preview'); expect(p.plan).toHaveLength(3);
    expect(p.expectedState).toMatch(/^modal-probe-preview-v1:sha256:[a-f0-9]{64}$/);
    expect(f.api.createPage).not.toHaveBeenCalled(); expect(f.api.loadFontAsync).not.toHaveBeenCalled();
    expect(f.root.setPluginData).not.toHaveBeenCalled();
    expect((await probeModalStructure(f.api, { operationId: 'other' })).expectedState).not.toBe(p.expectedState);
  });
  it('creates one owned page, tests BOOLEAN outside SLOT and custom content; preserves user page/selection', async () => {
    const f = modalProbeFixture(); const r = await apply(f);
    expect(r.status).toBe('applied'); expect(r.cases.map(c => c.passed)).toEqual([true, true, true]);
    expect(r.createdNodeIds).toContain(r.pageId); expect(new Set(r.createdNodeIds).size).toBe(r.createdNodeIds.length);
    expect(f.api.createPage).toHaveBeenCalledTimes(1); expect(f.api.currentPage).toBe(f.page); expect(f.page.selection).toEqual([f.user]);
    expect(f.page.children).toEqual([f.user]); expect(f.user.characters).toBe('Untouched');
    for (const id of r.createdNodeIds) { let n = f.nodes.get(id); while (n && n.id !== r.pageId) n = n.parent; expect(n?.id).toBe(r.pageId); }
    for (const n of f.nodes.values()) expect(n.remove).not.toHaveBeenCalled();
  });
  it('records native SLOT-sublayer rejection without claiming migration success', async () => {
    const f = modalProbeFixture(); f.state.denyLegacyReparent = true; const r = await apply(f);
    expect(r.cases[1].passed).toBe(false); expect(r.cases[1].failure?.message).toContain('native reparent restriction');
    expect(r.cases[0].passed).toBe(true); expect(r.cases[2].passed).toBe(true);
    expect(r.pageId).toBeTruthy(); expect((await probeModalStructure(f.api, args)).status).toBe('replayed');
  });
  it('blocks stale state and drift while loading Inter before page/receipt creation', async () => {
    for (const during of [false, true]) {
      const f = modalProbeFixture(); const p = await probeModalStructure(f.api, args);
      if (during) f.api.loadFontAsync.mockImplementation(async () => { f.page.name = 'changed'; }); else f.page.name = 'changed';
      await expect(probeModalStructure(f.api, { ...args, dryRun: false, expectedState: p.expectedState })).rejects.toThrow('SOURCE_CHANGED');
      expect(f.api.createPage).not.toHaveBeenCalled(); expect(f.root.setPluginData).not.toHaveBeenCalled();
    }
  });
  it('durably replays same page without font load or new native writes', async () => {
    const f = modalProbeFixture(); const a = await apply(f); f.api.loadFontAsync.mockClear();
    const r = await probeModalStructure(f.api, args); expect(r.status).toBe('replayed'); expect(r.pageId).toBe(a.pageId);
    expect(r.cases).toEqual(a.cases); expect(f.api.createPage).toHaveBeenCalledTimes(1); expect(f.api.loadFontAsync).not.toHaveBeenCalled();
  });
  it('rejects draft text, marker, main-link and foreign-child edits on replay', async () => {
    for (const edit of ['text', 'marker', 'main', 'foreign']) {
      const f = modalProbeFixture(); const a = await apply(f); const page = f.nodes.get(a.pageId!);
      if (edit === 'text') [...f.nodes.values()].find(n => a.createdNodeIds.includes(n.id) && n.type === 'TEXT').characters += 'edited';
      if (edit === 'marker') page.setPluginData('modal-probe-v1-owner', 'wrong');
      if (edit === 'main') [...f.nodes.values()].find(n => n.type === 'INSTANCE').main = f.user;
      if (edit === 'foreign') page.appendChild(f.user);
      await expect(probeModalStructure(f.api, args)).rejects.toThrow('OPERATION_RESULT_CHANGED'); expect(f.api.createPage).toHaveBeenCalledTimes(1);
    }
  });
  it('retains bounded partial draft IDs and fails closed on retry without cleanup', async () => {
    const f = modalProbeFixture(); f.state.failCreateAt = 3; const r = await apply(f);
    expect(r.status).toBe('partial'); expect(r.pageId).toBeTruthy(); expect(r.createdNodeIds).toContain(r.pageId);
    await expect(probeModalStructure(f.api, args)).rejects.toThrow('OPERATION_INCOMPLETE');
    for (const n of f.nodes.values()) expect(n.remove).not.toHaveBeenCalled();
  });
  it('rejects malformed/conflicting/incomplete receipts and altered result chunks', async () => {
    for (const edit of ['null', 'request', 'incomplete', 'payload', 'orphan']) {
      const f = modalProbeFixture(); await apply(f); const key = 'modal-probe-v1-operation-scratch-1';
      const receipt = JSON.parse(f.root.getPluginData(key));
      if (edit === 'null') f.root.setPluginData(key, 'null');
      if (edit === 'request') f.root.setPluginData(key, JSON.stringify({ ...receipt, requestHash: 'wrong' }));
      if (edit === 'incomplete') f.root.setPluginData(key, JSON.stringify({ ...receipt, phase: 'running' }));
      if (edit === 'payload') f.root.setPluginData(`${key}-0`, f.root.getPluginData(`${key}-0`) + ' ');
      if (edit === 'orphan') f.root.setPluginData(key, '');
      await expect(probeModalStructure(f.api, args)).rejects.toThrow(/OPERATION_CONFLICT|OPERATION_INCOMPLETE|OPERATION_RESULT_CHANGED/);
      expect(f.api.createPage).toHaveBeenCalledTimes(1);
    }
  });
  it('rejects component schema, paint and custom metadata drift on replay', async () => {
    for (const edit of ['schema', 'paint', 'metadata']) {
      const f = modalProbeFixture(); const r = await apply(f);
      const master = [...f.nodes.values()].find(n => n.type === 'COMPONENT');
      if (edit === 'schema') master.componentPropertyDefinitions.extra = { type: 'BOOLEAN', defaultValue: false };
      if (edit === 'paint') master.fills = [{ type: 'SOLID', color: { r: 1, g: 0, b: 0 } }];
      if (edit === 'metadata') f.nodes.get(r.pageId!).setPluginData('foreign-note', 'manual edit');
      await expect(probeModalStructure(f.api, args)).rejects.toThrow('OPERATION_RESULT_CHANGED');
    }
  });
  it('records actual main-link identity and rejects an unexpected owned main', async () => {
    const f = modalProbeFixture(); const native = f.api.createComponent.getMockImplementation(); let first: any;
    f.api.createComponent.mockImplementation(() => {
      const n = native(); first ??= n; const create = n.createInstance.getMockImplementation();
      n.createInstance.mockImplementation(() => { const instance = create(); instance.main = first; return instance; }); return n;
    });
    const r = await apply(f); expect(r.status).toBe('partial'); expect(r.failure?.code).toBe('OPERATION_RESULT_CHANGED');
  });
  it.each(['default-content', 'custom-visibility', 'custom-order'] as const)('fails custom-title when staging loses %s', async (edit) => {
    const f = modalProbeFixture(); const create = f.api.createFrame.getMockImplementation();
    f.api.createFrame.mockImplementation(() => {
      const frame = create(); const append = frame.appendChild.getMockImplementation();
      frame.appendChild.mockImplementation((child: any) => {
        const fromSlot = child.parent?.type === 'SLOT'; append(child);
        if (!fromSlot || frame.name !== 'Preserved displaced Title contents') return;
        if (edit === 'default-content' && child.name === 'Heading') child.characters = 'Lost default title';
        if (edit === 'custom-visibility' && child.name === 'Custom title first') child.visible = false;
        if (edit === 'custom-order' && child.name === 'Custom title second') frame.children.reverse();
      });
      return frame;
    });
    const r = await apply(f);
    expect(r.status).toBe('applied'); expect(r.cases.slice(0, 2).map(c => c.passed)).toEqual([true, true]);
    expect(r.cases[2].passed).toBe(false); expect(r.cases[2].failure?.code).toBe('CAPABILITY_NOT_SUPPORTED');
    expect(r.cases[2].failure?.message).toContain('preservation');
    for (const node of f.nodes.values()) expect(node.remove).not.toHaveBeenCalled();
  });
  it.each(['backgrounds', 'guides', 'flowStartingPoints', 'prototypeBackgrounds'] as const)('rejects owned page %s drift on replay', async (field) => {
    const f = modalProbeFixture(); const r = await apply(f); const page = f.nodes.get(r.pageId!);
    if (field === 'guides') page.guides = [{ axis: 'X', offset: 10 }];
    else if (field === 'flowStartingPoints') page.flowStartingPoints = [{ nodeId: page.children[0].id, name: 'Manual flow' }];
    else page[field] = [{ type: 'SOLID', color: { r: 1, g: 0, b: 0 } }];
    await expect(probeModalStructure(f.api, args)).rejects.toThrow('OPERATION_RESULT_CHANGED');
    expect(f.api.createPage).toHaveBeenCalledTimes(1);
  });
  it('rejects oversized snapshots before completion and reports surviving draft', async () => {
    const f = modalProbeFixture(); const create = f.api.createText.getMockImplementation();
    f.api.createText.mockImplementation(() => { const n = create(); n.fills = [{ blob: 'x'.repeat(4_300_000) }]; return n; });
    const r = await apply(f); expect(r.status).toBe('partial'); expect(r.failure?.code).toBe('LIMIT_EXCEEDED'); expect(r.createdNodeIds.length).toBeGreaterThan(0);
  });
});
