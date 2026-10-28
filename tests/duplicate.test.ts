import { describe, expect, it, vi } from 'vitest';
import { duplicateNode } from '../src/plugin/duplicate.js';
import { duplicateNodeSchema } from '../src/shared/protocol.js';

function fixture() {
  let serial = 0;
  const registry = new Map<string, any>();
  const created: any[] = [];
  const style = { id: 'light', type: 'PAINT', name: 'Light', paints: [{ type: 'SOLID', color: { r: 1, g: 1, b: 1 } }] };
  function attach(parent: any, child: any) {
    if (child.parent) child.parent.children.splice(child.parent.children.indexOf(child), 1);
    parent.children.push(child); child.parent = parent;
  }
  function make(id: string, type: string, props: any = {}): any {
    const data = new Map<string, string>();
    const node: any = {
      id, type, name: id, parent: null, removed: false, x: 0, y: 0, width: 506, height: 365,
      fills: [], strokes: [], fillStyleId: '', strokeStyleId: '', boundVariables: {},
      constraints: { horizontal: 'CENTER', vertical: 'CENTER' }, reactions: [],
      getPluginData: (key: string) => data.get(key) ?? '',
      setPluginData: vi.fn((key: string, value: string) => { data.set(key, value); }),
      remove: vi.fn(() => { if (node.parent) node.parent.children.splice(node.parent.children.indexOf(node), 1); node.removed = true; }),
      setFillStyleIdAsync: vi.fn(async (id: string) => {
        node.fillStyleId = id; node.fills = structuredClone(style.paints);
        for (const region of node.vectorNetwork?.regions ?? []) {
          region.fillStyleId = id; region.fills = structuredClone(style.paints);
        }
      }),
      setStrokeStyleIdAsync: vi.fn(async (id: string) => { node.strokeStyleId = id; node.strokes = structuredClone(style.paints); }),
      setReactionsAsync: vi.fn(async (reactions: unknown) => { node.reactions = structuredClone(reactions); }),
      ...props,
    };
    if (['DOCUMENT', 'PAGE', 'FRAME', 'INSTANCE', 'SLOT', 'COMPONENT', 'SECTION'].includes(type)) {
      node.children = [];
      node.appendChild = (child: any) => attach(node, child);
    }
    if (type === 'INSTANCE') node.getMainComponentAsync = vi.fn(async () => ({ id: 'main-modal', key: 'modal-key' }));
    if (type === 'VECTOR') node.vectorNetwork ??= { vertices: [], segments: [], regions: [] };
    if (type === 'TEXT') {
      node.fontName = { family: 'PT Root UI', style: 'Medium' };
      node.getStyledTextSegments = () => [{ characters: node.characters, start: 0, end: node.characters.length,
        fontName: node.fontName, fontSize: 20, fills: node.fills, fillStyleId: node.fillStyleId, boundVariables: node.boundVariables }];
    }
    node.clone = vi.fn(() => {
      const clone = make(`new-${++serial}`, type);
      for (const [key, value] of Object.entries(node)) {
        if (['id', 'parent', 'children', 'removed'].includes(key) || typeof value === 'function') continue;
        clone[key] = structuredClone(value);
      }
      for (const child of node.children ?? []) clone.appendChild(child.clone());
      page.appendChild(clone);
      if (node === source) created.push(clone);
      return clone;
    });
    registry.set(id, node); return node;
  }
  const document = make('doc', 'DOCUMENT');
  const page = make('page', 'PAGE', { loadAsync: vi.fn(async () => {}) }); document.appendChild(page);
  const parent = make('parent', 'FRAME', { layoutMode: 'NONE', width: 1400, height: 1000 }); page.appendChild(parent);
  const source = make('source', 'INSTANCE', { x: 100, y: 200, componentProperties: { 'content#1': { type: 'SLOT' } } }); parent.appendChild(source);
  const slot = make('slot', 'SLOT', { componentPropertyReferences: { slotContentId: 'content#1' } }); source.appendChild(slot);
  const title = make('title', 'TEXT', { characters: 'Формирование запроса', width: 426, height: 48 }); slot.appendChild(title);
  const icon = make('icon', 'VECTOR', { vectorPaths: [{ windingRule: 'NONZERO', data: 'M0 0L1 1' }] }); slot.appendChild(icon);
  const api = { mixed: Symbol('mixed'), getNodeByIdAsync: vi.fn(async (id: string) => registry.get(id) ?? null),
    getStyleByIdAsync: vi.fn(async (id: string) => id === style.id ? style : null), loadFontAsync: vi.fn(async () => {}) };
  const args = { sourceNodeId: source.id, operationId: 'modal-light-v1', name: 'Modal light', position: { x: 700, y: 200 },
    layerStyles: [{ sourceNodeId: source.id, fillStyleId: style.id }, { sourceNodeId: title.id, fillStyleId: style.id }, { sourceNodeId: icon.id, strokeStyleId: style.id }] };
  return { api: api as unknown as Parameters<typeof duplicateNode>[0], args, source, parent, page, document, title, icon, slot, style, created, make };
}

async function apply(f: ReturnType<typeof fixture>) {
  const preview = await duplicateNode(f.api, f.args);
  return duplicateNode(f.api, { ...f.args, dryRun: false, expectedState: preview.expectedState });
}

describe('duplicate_node', () => {
  function vectorFillFixture() {
    const f = fixture();
    f.icon.vectorNetwork = { vertices: [{ x: 0, y: 0 }, { x: 1, y: 1 }],
      segments: [{ start: 0, end: 1 }], regions: [{ windingRule: 'NONZERO', loops: [[0]],
        fillStyleId: 'dark-region', fills: [{ type: 'SOLID', color: { r: 0, g: 0, b: 0 } }] }] };
    f.args.layerStyles[2] = { sourceNodeId: f.icon.id, fillStyleId: f.style.id };
    return f;
  }

  it('permits requested fill style changes inside vector regions while preserving geometry', async () => {
    const f = vectorFillFixture();
    await apply(f);
    expect(f.created[0].children[0].children[1].vectorNetwork).toMatchObject({
      vertices: f.icon.vectorNetwork.vertices, segments: f.icon.vectorNetwork.segments,
      regions: [{ loops: [[0]], windingRule: 'NONZERO', fillStyleId: f.style.id, fills: f.style.paints }],
    });
    expect(f.icon.vectorNetwork.regions[0].fillStyleId).toBe('dark-region');
  });

  it('still rejects changed vector vertices, segments and region loops during recoloring', async () => {
    for (const change of [(n: any) => n.vertices[0].x++, (n: any) => n.segments[0].end = 0,
      (n: any) => n.regions[0].loops = [[1]]]) {
      const f = vectorFillFixture(); const nativeClone = f.source.clone;
      f.source.clone = () => { const clone = nativeClone(); change(clone.children[0].children[1].vectorNetwork); return clone; };
      await expect(apply(f)).rejects.toMatchObject({ code: 'SOURCE_CHANGED', details: { stage: 'readback' } });
    }
  });

  it('rejects wrong vector region paints even if the top-level fill style matches', async () => {
    const f = vectorFillFixture(); const nativeClone = f.source.clone;
    f.source.clone = () => { const clone = nativeClone(); const icon = clone.children[0].children[1]; const setter = icon.setFillStyleIdAsync;
      icon.setFillStyleIdAsync = async (id: string) => { await setter(id); icon.vectorNetwork.regions[0].fillStyleId = 'unrequested'; }; return clone; };
    await expect(apply(f)).rejects.toMatchObject({ code: 'SOURCE_CHANGED', details: { stage: 'styles-readback' } });
  });
  it('does not rescan all component links after each individual paint assignment', async () => {
    const f = fixture();
    for (let i = 0; i < 40; i++) {
      const vector = f.make(`extra-${i}`, 'VECTOR'); f.slot.appendChild(vector);
      f.args.layerStyles.push({ sourceNodeId: vector.id, fillStyleId: f.style.id });
    }
    await apply(f);
    expect(f.source.getMainComponentAsync.mock.calls.length).toBeLessThan(10);
    expect(f.created[0].children[0].children.filter((node: any) => node.fillStyleId === f.style.id)).toHaveLength(41);
  });

  it('reports the exact changed property when copied content fails readback', async () => {
    const f = fixture(); const nativeClone = f.source.clone;
    f.source.clone = () => { const clone = nativeClone(); clone.children[0].children[0].characters = 'Lost'; return clone; };
    await expect(apply(f)).rejects.toMatchObject({ code: 'SOURCE_CHANGED', details: { stage: 'readback', field: expect.stringContaining('characters') } });
  });
  it('defaults to a read-only preview and requires that state before writing', async () => {
    const f = fixture();
    expect(duplicateNodeSchema.parse(f.args).dryRun).toBe(true);
    expect(duplicateNodeSchema.safeParse({ ...f.args, dryRun: false }).success).toBe(false);
    expect(duplicateNodeSchema.safeParse({ ...f.args, position: { x: Infinity, y: 0 } }).success).toBe(false);
    expect(duplicateNodeSchema.safeParse({ ...f.args, layerStyles: [f.args.layerStyles[0], f.args.layerStyles[0]] }).success).toBe(false);
    const preview = await duplicateNode(f.api, f.args);
    expect(preview).toMatchObject({ status: 'preview', sourceNodeId: 'source', parentId: 'parent', name: 'Modal light', position: f.args.position });
    expect(preview.expectedState).toBeTruthy();
    expect(f.source.clone).not.toHaveBeenCalled();
    expect(f.page.setPluginData).not.toHaveBeenCalled();
  });

  it('copies an instance, slots, text, vectors and main component links, styling copies only', async () => {
    const f = fixture();
    const result = await apply(f);
    const clone = f.created[0];
    expect(result.status).toBe('applied');
    expect(result.nodeMap).toEqual({ source: clone.id, slot: clone.children[0].id, title: clone.children[0].children[0].id, icon: clone.children[0].children[1].id });
    expect(clone).toMatchObject({ type: 'INSTANCE', parent: f.parent, name: 'Modal light', x: 700, y: 200, width: 506, height: 365, fillStyleId: 'light' });
    expect(clone.children[0].type).toBe('SLOT');
    expect(clone.children[0].children[0]).toMatchObject({ characters: f.title.characters, fillStyleId: 'light' });
    expect(clone.children[0].children[1]).toMatchObject({ strokeStyleId: 'light', vectorPaths: f.icon.vectorPaths });
    expect(await clone.getMainComponentAsync()).toEqual(await f.source.getMainComponentAsync());
    expect(f.source).toMatchObject({ x: 100, y: 200, name: 'source', fillStyleId: '' });
    expect(f.title.fillStyleId).toBe(''); expect(f.icon.strokeStyleId).toBe('');
    expect(f.parent.children).toEqual([f.source, clone]);
    expect(f.api.loadFontAsync).toHaveBeenCalledWith(f.title.fontName);
  });

  it('supports plain frames and page parents without changing geometry', async () => {
    const f = fixture(); f.source.type = 'FRAME'; delete f.source.getMainComponentAsync;
    f.page.appendChild(f.source);
    const result = await apply(f);
    expect(result.parentId).toBe('page'); expect(f.created[0].type).toBe('FRAME');
  });

  it('replays the same operation and refuses changed requests, edited, moved or deleted copies', async () => {
    const f = fixture(); const result = await apply(f);
    expect(await duplicateNode(f.api, f.args)).toMatchObject({ status: 'replayed', nodeId: result.nodeId, nodeMap: result.nodeMap });
    await expect(duplicateNode(f.api, { ...f.args, name: 'Other' })).rejects.toThrow('OPERATION_CONFLICT');
    f.created[0].x++;
    await expect(duplicateNode(f.api, f.args)).rejects.toThrow('OPERATION_RESULT_CHANGED');
    f.created[0].x--; f.page.appendChild(f.created[0]);
    await expect(duplicateNode(f.api, f.args)).rejects.toThrow('OPERATION_RESULT_CHANGED');
    f.created[0].remove();
    await expect(duplicateNode(f.api, f.args)).rejects.toThrow('OPERATION_RESULT_CHANGED');
    expect(f.created).toHaveLength(1);
  });

  it('rejects stale source, parent, style or request state before cloning', async () => {
    for (const change of [(f: any) => f.title.characters += '!', (f: any) => f.parent.width++, (f: any) => f.style.paints[0].color.r = 0,
      (f: any) => f.args.position.x++]) {
      const f = fixture(); const preview = await duplicateNode(f.api, f.args); change(f);
      await expect(duplicateNode(f.api, { ...f.args, dryRun: false, expectedState: preview.expectedState })).rejects.toThrow('SOURCE_CHANGED');
      expect(f.created).toHaveLength(0);
    }
  });

  it('validates supported sources, free-layout parents, ancestry, scope and style types before cloning', async () => {
    for (const change of [(f: any) => f.source.type = 'COMPONENT', (f: any) => f.parent.layoutMode = 'HORIZONTAL',
      (f: any) => f.parent.type = 'INSTANCE', (f: any) => f.parent.parent = null,
      (f: any) => f.args.layerStyles[0].sourceNodeId = 'parent', (f: any) => f.args.layerStyles[0].fillStyleId = 'missing',
      (f: any) => f.style.type = 'TEXT']) {
      const f = fixture(); change(f);
      await expect(duplicateNode(f.api, f.args)).rejects.toThrow(); expect(f.created).toHaveLength(0);
    }
  });

  it('rolls back only the new root on style failure and permits a clean retry', async () => {
    const f = fixture(); const nativeClone = f.source.clone;
    f.source.clone = () => { const clone = nativeClone(); clone.setFillStyleIdAsync.mockRejectedValueOnce(new Error('Setter failed')); return clone; };
    await expect(apply(f)).rejects.toThrow('Setter failed');
    expect(f.created[0].removed).toBe(true); expect(f.parent.children).toEqual([f.source]);
    const diagnostic = await duplicateNode(f.api, f.args);
    expect(diagnostic).toMatchObject({ status: 'preview', previousFailure: { code: 'FIGMA_API_ERROR', details: { cause: 'Setter failed' } } });
    expect(f.created).toHaveLength(1);
    f.source.clone = nativeClone;
    expect((await apply(f)).status).toBe('applied');
  });

  it('detects source changes across style awaits without overwriting user changes', async () => {
    const f = fixture(); const nativeClone = f.source.clone;
    f.source.clone = () => { const clone = nativeClone(); const setter = clone.setFillStyleIdAsync;
      clone.setFillStyleIdAsync = async (id: string) => { await setter(id); f.title.characters = 'Manual edit'; }; return clone; };
    await expect(apply(f)).rejects.toThrow('SOURCE_CHANGED');
    expect(f.title.characters).toBe('Manual edit'); expect(f.created[0].removed).toBe(true);
  });

  it('rejects lost slot content, main component links and altered unrequested text properties', async () => {
    for (const change of [(n: any) => n.children[0].children.pop(),
      (n: any) => n.getMainComponentAsync = async () => ({ id: 'other', key: 'other' }),
      (n: any) => n.children[0].children[0].characters = 'Lost content']) {
      const f = fixture(); const nativeClone = f.source.clone;
      f.source.clone = () => { const clone = nativeClone(); change(clone); return clone; };
      await expect(apply(f)).rejects.toThrow('SOURCE_CHANGED'); expect(f.created[0].removed).toBe(true);
    }
  });

  it('reports surviving new IDs on incomplete rollback and prevents another copy on retry', async () => {
    const f = fixture(); const nativeClone = f.source.clone;
    f.source.clone = () => { const clone = nativeClone(); clone.setFillStyleIdAsync.mockRejectedValueOnce(new Error('Setter failed'));
      clone.remove.mockImplementation(() => { throw new Error('Remove failed'); }); return clone; };
    await expect(apply(f)).rejects.toThrow(/ROLLBACK_INCOMPLETE.*remainingNodeIds/);
    await expect(duplicateNode(f.api, f.args)).rejects.toThrow('ROLLBACK_INCOMPLETE');
    expect(f.created).toHaveLength(1);
  });

  it('supports large Unicode receipts without exceeding the Figma per-entry limit', async () => {
    const f = fixture(); f.title.characters = 'Запрос😀'.repeat(1500);
    const result = await apply(f);
    expect(await duplicateNode(f.api, f.args)).toMatchObject({ status: 'replayed', nodeId: result.nodeId });
    for (const [key, value] of f.created[0].setPluginData.mock.calls) {
      expect(Buffer.byteLength(String(key) + String(value), 'utf8')).toBeLessThan(90_000);
    }
  });

  it('detects silent paint failures, style changes and parent changes during writes', async () => {
    for (const change of [(f: any, n: any) => n.setFillStyleIdAsync = async () => {},
      (f: any, n: any) => n.setFillStyleIdAsync = async () => { f.style.paints[0].color.r = 0; },
      (f: any, n: any) => n.setFillStyleIdAsync = async () => { f.parent.width++; }]) {
      const f = fixture(); const nativeClone = f.source.clone;
      f.source.clone = () => { const clone = nativeClone(); change(f, clone); return clone; };
      await expect(apply(f)).rejects.toThrow('SOURCE_CHANGED'); expect(f.created[0].removed).toBe(true);
    }
  });

  it('restores only copied constraints and prototype reactions lost by native cloning', async () => {
    const f = fixture(); f.source.reactions = [{ trigger: { type: 'ON_CLICK' }, action: { type: 'CLOSE' } }];
    const nativeClone = f.source.clone;
    f.source.clone = () => { const clone = nativeClone(); clone.constraints = { horizontal: 'MIN', vertical: 'MIN' }; clone.reactions = []; return clone; };
    await apply(f);
    expect(f.created[0].constraints).toEqual(f.source.constraints);
    expect(f.created[0].reactions).toEqual(f.source.reactions);
    expect(f.source.setReactionsAsync).not.toHaveBeenCalled();
  });

  it('rolls back on missing fonts, append or metadata failures', async () => {
    for (const failAt of ['font', 'append', 'metadata']) {
      const f = fixture();
      if (failAt === 'font') (f.api.loadFontAsync as any).mockRejectedValueOnce(new Error('Font unavailable'));
      if (failAt === 'append') f.parent.appendChild = () => { throw new Error('Append failed'); };
      if (failAt === 'metadata') { const nativeClone = f.source.clone; f.source.clone = () => {
        const clone = nativeClone(); clone.setPluginData.mockImplementation(() => { throw new Error('Receipt failed'); }); return clone; }; }
      await expect(apply(f)).rejects.toThrow();
      expect(f.created[0].removed).toBe(true); expect(f.parent.children).toEqual([f.source]);
    }
  });

  it('fails closed on unknown operation status and damaged copy receipt', async () => {
    const f = fixture(); await apply(f);
    f.created[0].setPluginData('codex-duplicate-v1-chunks', '0');
    await expect(duplicateNode(f.api, f.args)).rejects.toThrow('OPERATION_RESULT_CHANGED');
    expect(f.created).toHaveLength(1);
    f.created[0].setPluginData('codex-duplicate-v1-chunks', '1');
    f.created[0].setPluginData('codex-duplicate-v1-chunk-0', '{broken');
    await expect(duplicateNode(f.api, f.args)).rejects.toThrow('OPERATION_RESULT_CHANGED');
  });

  it('blocks a pending operation left by an interrupted plugin instead of creating another root', async () => {
    const f = fixture();
    f.document.setPluginData('codex-duplicate-v1-modal-light-v1', JSON.stringify({
      request: JSON.stringify(f.args), status: 'pending', nodeId: 'old-copy',
    }));
    // Different canonical request still fails closed rather than creating a replacement.
    await expect(duplicateNode(f.api, f.args)).rejects.toThrow('OPERATION_CONFLICT');
    const { stable } = await import('../src/plugin/variant-state.js');
    f.document.setPluginData('codex-duplicate-v1-modal-light-v1', JSON.stringify({
      request: stable({ ...f.args, layerStyles: f.args.layerStyles }), status: 'pending', nodeId: 'old-copy',
    }));
    await expect(duplicateNode(f.api, f.args)).rejects.toThrow('OPERATION_INCOMPLETE');
    expect(f.created).toHaveLength(0);
  });
});
