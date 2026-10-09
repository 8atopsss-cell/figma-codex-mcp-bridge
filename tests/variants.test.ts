import { describe, expect, it, vi } from 'vitest';
import { createComponentVariants } from '../src/plugin/variants.js';
import { createComponentVariantsSchema } from '../src/shared/protocol.js';

function fixture() {
  let nextId = 100;
  const registry = new Map<string, any>();
  const created: any[] = [];
  const style = { id: 'light-primary', type: 'PAINT', name: 'Light primary', paints: [{ type: 'SOLID', color: { r: 0.1, g: 0.2, b: 0.3 } }] };
  const page: any = { id: 'page', type: 'PAGE', loadAsync: vi.fn(async () => {}), children: [], appendChild(node: any) { attach(this, node); } };
  const document: any = { id: 'document', type: 'DOCUMENT', parent: null, children: [page] };
  page.parent = document;
  function attach(parent: any, node: any) {
    if (node.parent) node.parent.children.splice(node.parent.children.indexOf(node), 1);
    parent.children.push(node);
    node.parent = parent;
  }
  function make(id: string, type: string, name: string): any {
    const data = new Map<string, string>();
    const node: any = {
      id, type, name, removed: false, parent: null, remote: false,
      x: 0, y: 0, width: 24, height: type === 'VECTOR' ? 0 : 24,
      fills: [], strokes: [], strokeWeight: 2, strokeStyleId: 'dark-primary', fillStyleId: '',
      boundVariables: {}, explicitVariableModes: {}, resolvedVariableModes: {},
      getPluginData: (key: string) => data.get(key) ?? '',
      setPluginData: (key: string, value: string) => data.set(key, value),
      remove: vi.fn(() => { if (node.parent) node.parent.children.splice(node.parent.children.indexOf(node), 1); node.removed = true; }),
      setStrokeStyleIdAsync: vi.fn(async (value: string) => { node.strokeStyleId = value; node.strokes = style.paints; }),
      setFillStyleIdAsync: vi.fn(async (value: string) => { node.fillStyleId = value; node.fills = style.paints; }),
    };
    if (type === 'COMPONENT') {
      node.children = [];
      node.appendChild = (child: any) => attach(node, child);
      Object.defineProperty(node, 'variantProperties', { get: () => node.parent?.type === 'COMPONENT_SET' ? Object.fromEntries(node.name.split(', ').map((part: string) => part.split('='))) : null });
      node.clone = vi.fn(() => {
        const copy = make(String(nextId++), type, node.name);
        Object.assign(copy, { x: node.x, y: node.y, width: node.width, height: node.height });
        for (const child of node.children) {
          const clone = make(String(nextId++), child.type, child.name);
          Object.assign(clone, { x: child.x, y: child.y, width: child.width, height: child.height });
          copy.appendChild(clone);
        }
        page.appendChild(copy);
        created.push(copy);
        return copy;
      });
    }
    registry.set(id, node);
    return node;
  }
  const set: any = {
    id: 'set', type: 'COMPONENT_SET', name: 'Sort', remote: false, removed: false,
    parent: page, x: 0, y: 0, width: 120, height: 200, layoutMode: 'NONE', children: [],
    componentPropertyDefinitions: {
      theme: { type: 'VARIANT', defaultValue: 'dark', variantOptions: ['dark', 'light'] },
      state: { type: 'VARIANT', defaultValue: 'ascending', variantOptions: ['ascending', 'descending', 'none'] },
    },
    appendChild(node: any) { attach(this, node); },
  };
  registry.set(set.id, set);
  registry.set(page.id, page);
  page.children.push(set);
  const sources = ['descending', 'none'].map((state, index) => {
    const node = make(state, 'COMPONENT', `theme=dark, state=${state}`);
    node.x = 20; node.y = 64 + index * 44;
    for (let layer = 0; layer < 3; layer++) node.appendChild(make(`${state}-${layer}`, 'VECTOR', `Vector ${layer}`));
    set.appendChild(node);
    return node;
  });
  const args = {
    componentSetId: set.id, operationId: 'light-sort-v1', dryRun: true,
    variants: sources.map((source) => ({
      sourceComponentId: source.id, properties: { theme: 'light', state: source.id },
      position: { x: 75, y: source.y },
      layerStyles: source.children.map((layer: any) => ({ sourceNodeId: layer.id, strokeStyleId: style.id })),
    })),
  };
  const api = { mixed: Symbol('mixed'), getNodeByIdAsync: vi.fn(async (id: string) => registry.get(id) ?? null), getStyleByIdAsync: vi.fn(async (id: string) => id === style.id ? style : null) };
  return { api: api as unknown as Parameters<typeof createComponentVariants>[0], args, set, sources, style, created };
}

async function apply(f: ReturnType<typeof fixture>) {
  const preview = await createComponentVariants(f.api, f.args);
  return createComponentVariants(f.api, { ...f.args, dryRun: false, expectedState: preview.expectedState });
}

function expandingFixture() {
  const f = fixture();
  f.set.width = 50;
  const original = structuredClone(f.set.componentPropertyDefinitions);
  original.theme.variantOptions = ['dark'];
  Object.defineProperty(f.set, 'componentPropertyDefinitions', { configurable: true, get() {
    const definitions = structuredClone(original);
    for (const node of f.set.children) {
      for (const [key, value] of Object.entries(node.variantProperties)) {
        if (!definitions[key].variantOptions.includes(value)) definitions[key].variantOptions.push(value);
      }
    }
    return definitions;
  } });
  f.set.resizeWithoutConstraints = vi.fn((width: number, height: number) => { f.set.width = width; f.set.height = height; });
  return { ...f, original, args: { ...f.args, componentSetSize: { width: 120, height: 200 }, newVariantValues: { theme: ['light'] } } };
}

describe('explicit set dimensions and new variant values', () => {
  it('previews expansion without resizing and applies only declared values', async () => {
    const f = expandingFixture();
    const preview = await createComponentVariants(f.api, f.args);
    expect(preview).toMatchObject({ componentSetSize: { width: 120, height: 200 }, newVariantValues: { theme: ['light'] } });
    expect(f.set.resizeWithoutConstraints).not.toHaveBeenCalled();
    expect(f.set.width).toBe(50);
    const result = await createComponentVariants(f.api, { ...f.args, dryRun: false, expectedState: preview.expectedState });
    expect(result.status).toBe('applied');
    expect(f.set.resizeWithoutConstraints).toHaveBeenCalledExactlyOnceWith(120, 200);
    expect(f.set.componentPropertyDefinitions.theme).toEqual({ type: 'VARIANT', defaultValue: 'dark', variantOptions: ['dark', 'light'] });
    expect(f.sources.map((node) => [node.x, node.y, node.width, node.height])).toEqual([[20, 64, 24, 24], [20, 108, 24, 24]]);
    const replay = await createComponentVariants(f.api, f.args);
    expect(replay.status).toBe('replayed');
    expect(f.created).toHaveLength(2);
    f.set.width++;
    await expect(createComponentVariants(f.api, f.args)).rejects.toThrow('OPERATION_RESULT_CHANGED');
  });

  it('rejects undeclared, unknown-axis, redundant and unused new values', async () => {
    const f = expandingFixture();
    for (const newVariantValues of [undefined, { other: ['light'] }, { theme: ['dark', 'light'] }, { theme: ['light', 'unused'] }]) {
      await expect(createComponentVariants(f.api, { ...f.args, newVariantValues })).rejects.toThrow('INVALID_VARIANT_SCHEMA');
    }
    expect(createComponentVariantsSchema.safeParse({ ...f.args, newVariantValues: { theme: ['light', 'light'] } }).success).toBe(false);
    expect(createComponentVariantsSchema.safeParse({ ...f.args, componentSetSize: { width: 0, height: 200 } }).success).toBe(false);
    expect(f.created).toHaveLength(0);
  });

  it('rejects shrinking around existing variants and changing approved dimensions after preview', async () => {
    const f = expandingFixture();
    await expect(createComponentVariants(f.api, { ...f.args, componentSetSize: { width: 120, height: 100 } })).rejects.toThrow('INVALID_ARGUMENT');
    const preview = await createComponentVariants(f.api, f.args);
    await expect(createComponentVariants(f.api, { ...f.args, componentSetSize: { width: 130, height: 200 }, dryRun: false, expectedState: preview.expectedState })).rejects.toThrow('SOURCE_CHANGED');
    expect(f.created).toHaveLength(0);
  });

  it('restores dimensions and removes copies after append failure', async () => {
    const f = expandingFixture();
    const append = f.set.appendChild.bind(f.set);
    let calls = 0;
    f.set.appendChild = (node: any) => { if (++calls === 2) throw new Error('Append failed'); append(node); };
    await expect(apply(f)).rejects.toThrow('Append failed');
    expect([f.set.width, f.set.height]).toEqual([50, 200]);
    expect(f.set.children).toEqual(f.sources);
    expect(f.set.componentPropertyDefinitions).toEqual(f.original);
  });

  it('reports failed bounds restoration without overwriting a manual resize', async () => {
    for (const manual of [true, false]) {
      const f = expandingFixture();
      f.set.appendChild = () => { if (manual) f.set.width = 130; throw new Error('Append failed'); };
      if (!manual) f.set.resizeWithoutConstraints.mockImplementation((width: number, height: number) => {
        if (width === 50) throw new Error('Restore failed');
        f.set.width = width; f.set.height = height;
      });
      await expect(apply(f)).rejects.toThrow(/ROLLBACK_INCOMPLETE.*componentSetSizeRestored/);
      expect(f.set.width).toBe(manual ? 130 : 120);
      expect(f.created.every((node) => node.removed)).toBe(true);
    }
  });

  it('rejects native schema/default changes and replay schema changes', async () => {
    const f = expandingFixture();
    const append = f.set.appendChild.bind(f.set);
    f.set.appendChild = (node: any) => { append(node); f.original.theme.defaultValue = 'light'; };
    await expect(apply(f)).rejects.toThrow('SOURCE_CHANGED');
    expect(f.set.width).toBe(50);
    const g = expandingFixture();
    await apply(g);
    g.original.theme.defaultValue = 'light';
    await expect(createComponentVariants(g.api, g.args)).rejects.toThrow('OPERATION_RESULT_CHANGED');
  });

  it('supports new values without resize and resize without new values', async () => {
    const f = expandingFixture();
    f.set.width = 120;
    const { componentSetSize: _size, ...valuesOnly } = f.args;
    await createComponentVariants(f.api, { ...valuesOnly, dryRun: false, expectedState: (await createComponentVariants(f.api, valuesOnly)).expectedState });
    expect(f.set.resizeWithoutConstraints).not.toHaveBeenCalled();
    const g = fixture();
    g.set.resizeWithoutConstraints = vi.fn((width: number, height: number) => { g.set.width = width; g.set.height = height; });
    const sizeOnly = { ...g.args, componentSetSize: { width: 130, height: 200 } };
    const preview = await createComponentVariants(g.api, sizeOnly);
    await createComponentVariants(g.api, { ...sizeOnly, dryRun: false, expectedState: preview.expectedState });
    expect(g.set.width).toBe(130);
  });

  it('never resizes after a style failure and detects child changes during resize', async () => {
    const f = expandingFixture();
    const clone = f.sources[0].clone;
    f.sources[0].clone = () => {
      const node = clone();
      node.children[0].setStrokeStyleIdAsync.mockRejectedValueOnce(new Error('Setter failed'));
      return node;
    };
    await expect(apply(f)).rejects.toThrow('Setter failed');
    expect(f.set.resizeWithoutConstraints).not.toHaveBeenCalled();
    const g = expandingFixture();
    g.set.resizeWithoutConstraints.mockImplementation((width: number, height: number) => {
      g.set.width = width; g.set.height = height;
      if (width === 120) g.sources[0].width++;
    });
    await expect(apply(g)).rejects.toThrow('SOURCE_CHANGED');
    expect(g.set.width).toBe(50);
    expect(g.created.every((node) => node.removed)).toBe(true);
  });
});

describe('component variant creation', () => {
  it('defaults to preview and validates strict bounded input', () => {
    const f = fixture();
    const { dryRun: _dryRun, ...args } = f.args;
    expect(createComponentVariantsSchema.parse(args).dryRun).toBe(true);
    expect(createComponentVariantsSchema.safeParse({ ...args, unknown: true }).success).toBe(false);
    expect(createComponentVariantsSchema.safeParse({ ...args, variants: Array(21).fill(args.variants[0]) }).success).toBe(false);
    expect(createComponentVariantsSchema.safeParse({ ...args, dryRun: false }).success).toBe(false);
  });

  it('previews two missing combinations without cloning or writing', async () => {
    const f = fixture();
    const preview = await createComponentVariants(f.api, f.args);
    expect(preview.status).toBe('preview');
    expect(preview.variants.map((v) => v.name)).toEqual(['theme=light, state=descending', 'theme=light, state=none']);
    expect(f.set.children).toHaveLength(2);
    for (const source of f.sources) expect(source.clone).not.toHaveBeenCalled();
  });

  it('creates both styled variants with mapped IDs while preserving sources', async () => {
    const f = fixture();
    const result = await apply(f);
    expect(result.status).toBe('applied');
    expect(f.set.children).toHaveLength(4);
    expect(result.variants).toHaveLength(2);
    for (const [index, clone] of f.created.entries()) {
      expect(clone.parent).toBe(f.set);
      expect(clone.x).toBe(75);
      expect(clone.y).toBe(f.sources[index].y);
      expect(clone.children.every((n: any) => n.strokeStyleId === f.style.id)).toBe(true);
      expect(Object.keys(result.variants[index].nodeMap ?? {})).toHaveLength(4);
    }
    expect(f.sources.every((n) => n.children.every((child: any) => child.strokeStyleId === 'dark-primary'))).toBe(true);
    expect(f.set.width).toBe(120);
  });

  it('rejects changed source geometry and style values before clone', async () => {
    for (const change of ['node', 'style']) {
      const f = fixture();
      const preview = await createComponentVariants(f.api, f.args);
      if (change === 'node') f.sources[0].children[0].width++;
      else f.style.paints[0].color.r = 0.9;
      await expect(createComponentVariants(f.api, { ...f.args, dryRun: false, expectedState: preview.expectedState })).rejects.toThrow('SOURCE_CHANGED');
      expect(f.created).toHaveLength(0);
    }
  });

  it('rejects duplicate combinations and layers outside the source', async () => {
    const f = fixture();
    await expect(createComponentVariants(f.api, { ...f.args, variants: [f.args.variants[0], f.args.variants[0]] })).rejects.toThrow('VARIANT_ALREADY_EXISTS');
    await expect(createComponentVariants(f.api, { ...f.args, variants: [{ ...f.args.variants[0], properties: { theme: 'dark', state: 'descending' } }] })).rejects.toThrow('VARIANT_ALREADY_EXISTS');
    await expect(createComponentVariants(f.api, { ...f.args, variants: [{ ...f.args.variants[0], layerStyles: [{ sourceNodeId: 'none-0', strokeStyleId: f.style.id }] }] })).rejects.toThrow('INVALID_ARGUMENT');
    expect(f.created).toHaveLength(0);
  });

  it.each(['missing-style', 'wrong-style-type', 'layout', 'bounds', 'property'])('rejects %s during preparation', async (reason) => {
    const f = fixture();
    if (reason === 'missing-style') f.args.variants[0].layerStyles[0].strokeStyleId = 'missing';
    if (reason === 'wrong-style-type') (f.style as any).type = 'TEXT';
    if (reason === 'layout') f.set.layoutMode = 'HORIZONTAL';
    if (reason === 'bounds') f.args.variants[0].position.x = 110;
    if (reason === 'property') f.args.variants[0].properties.theme = 'unknown';
    await expect(createComponentVariants(f.api, f.args)).rejects.toThrow();
    expect(f.created).toHaveLength(0);
  });

  it('removes every new root when a later style setter fails', async () => {
    const f = fixture();
    const clone = f.sources[1].clone;
    f.sources[1].clone = vi.fn(() => {
      const node = clone();
      node.children[2].setStrokeStyleIdAsync.mockRejectedValueOnce(new Error('Style unavailable'));
      return node;
    });
    await expect(apply(f)).rejects.toThrow('Style unavailable');
    expect(f.set.children).toEqual(f.sources);
    expect(f.created).toHaveLength(2);
    expect(f.created.every((n) => n.removed)).toBe(true);
  });

  it('reports remaining IDs if rollback itself fails', async () => {
    const f = fixture();
    const clone = f.sources[0].clone;
    f.sources[0].clone = vi.fn(() => {
      const node = clone();
      node.remove.mockImplementation(() => { throw new Error('Removal failed'); });
      node.children[0].setStrokeStyleIdAsync.mockRejectedValueOnce(new Error('Setter failed'));
      return node;
    });
    await expect(apply(f)).rejects.toThrow(/ROLLBACK_INCOMPLETE.*remainingNodeIds/);
    expect(f.set.children).toEqual(f.sources);
  });

  it('cleans up both copies after a partially successful append', async () => {
    const f = fixture();
    const append = f.set.appendChild.bind(f.set);
    let calls = 0;
    f.set.appendChild = (node: any) => { if (++calls === 2) throw new Error('Append failed'); append(node); };
    await expect(apply(f)).rejects.toThrow('Append failed');
    expect(f.set.children).toEqual(f.sources);
    expect(f.created.every((n) => n.removed)).toBe(true);
  });

  it('finishes rollback when removing a variant first detaches it onto the page', async () => {
    const f = fixture();
    const append = f.set.appendChild.bind(f.set);
    let calls = 0;
    f.set.appendChild = (node: any) => { if (++calls === 2) throw new Error('Append failed'); append(node); };
    const clone = f.sources[0].clone;
    f.sources[0].clone = () => {
      const node = clone();
      const remove = node.remove.getMockImplementation()!;
      node.remove.mockImplementation(() => {
        if (node.parent === f.set) {
          f.set.children.splice(f.set.children.indexOf(node), 1);
          node.parent = f.set.parent;
          node.parent.children.push(node);
          node.name = 'Sort/light descending';
        } else remove();
      });
      return node;
    };
    await expect(apply(f)).rejects.toThrow('Append failed');
    expect(f.created.every((node) => node.removed)).toBe(true);
    expect(f.sources.every((node) => !node.removed && node.parent === f.set)).toBe(true);
  });

  it('reports the exact source, clone and unrequested property changed by native cloning', async () => {
    const f = fixture();
    f.sources[0].children[0].opacity = 1;
    const clone = f.sources[0].clone;
    f.sources[0].clone = () => {
      const node = clone();
      node.children[0].opacity = 0.5;
      return node;
    };
    await expect(apply(f)).rejects.toMatchObject({
      code: 'SOURCE_CHANGED',
      details: {
        stage: 'readback', sourceNodeId: 'descending-0', nodeId: '101',
        field: 'properties.opacity', expected: 1, actual: 0.5,
      },
    });
    expect(f.created.every((node) => node.removed)).toBe(true);
  });

  it('preserves prototype reactions and layer constraints lost by native cloning', async () => {
    const f = fixture();
    const reactions = [{ trigger: { type: 'ON_CLICK' }, actions: [{ type: 'NODE', navigation: 'CHANGE_TO', destinationId: 'none' }] }];
    f.sources[0].reactions = reactions;
    f.sources[0].children[0].constraints = { horizontal: 'SCALE', vertical: 'SCALE' };
    const clone = f.sources[0].clone;
    f.sources[0].clone = () => {
      const node = clone();
      node.reactions = [];
      node.setReactionsAsync = vi.fn(async (value: any) => {
        expect(node.parent).toBe(f.set);
        node.reactions = value;
      });
      node.children[0].constraints = { horizontal: 'MIN', vertical: 'SCALE' };
      return node;
    };
    const result = await apply(f);
    expect(result.status).toBe('applied');
    expect(f.created[0].reactions).toEqual(reactions);
    expect(f.created[0].children[0].constraints).toEqual(f.sources[0].children[0].constraints);
    expect(f.sources[0].reactions).toBe(reactions);
  });

  it('does not report an inaccessible deleted component as an incomplete rollback', async () => {
    const f = fixture();
    const clone = f.sources[0].clone;
    f.sources[0].clone = () => {
      const node = clone();
      node.remove.mockImplementation(() => {
        node.parent.children.splice(node.parent.children.indexOf(node), 1);
        node.parent = { id: 'deleted', type: 'PAGE', parent: null, children: [node] };
        // Figma can retain the component object after removal for library references.
        node.removed = false;
      });
      node.children[0].setStrokeStyleIdAsync.mockRejectedValueOnce(new Error('Setter failed'));
      return node;
    };
    try { await apply(f); throw new Error('Expected failure'); }
    catch (error: any) {
      expect(error.code).toBe('FIGMA_API_ERROR');
      expect(error.message).toContain('Setter failed');
    }
    expect(f.set.children).toEqual(f.sources);
  });

  it('stops after a manual source edit during an asynchronous setter', async () => {
    const f = fixture();
    const clone = f.sources[0].clone;
    f.sources[0].clone = vi.fn(() => {
      const node = clone();
      node.children[0].setStrokeStyleIdAsync.mockImplementationOnce(async () => {
        node.children[0].strokeStyleId = f.style.id;
        f.sources[0].children[0].width++;
      });
      return node;
    });
    await expect(apply(f)).rejects.toThrow('SOURCE_CHANGED');
    expect(f.created.every((n) => n.removed)).toBe(true);
    expect(f.set.children).toEqual(f.sources);
  });

  it('fails closed on a source getter error instead of treating it as missing', async () => {
    const f = fixture();
    Object.defineProperty(f.sources[0].children[0], 'vectorPaths', { get() { throw new Error('Vector unavailable'); } });
    await expect(createComponentVariants(f.api, f.args)).rejects.toThrow(/vectorPaths.*Vector unavailable/);
    expect(f.created).toHaveLength(0);
  });

  it('replays a successful operation across calls and rejects conflicting payloads or edited results', async () => {
    const f = fixture();
    const preview = await createComponentVariants(f.api, f.args);
    const args = { ...f.args, dryRun: false, expectedState: preview.expectedState };
    const first = await createComponentVariants(f.api, args);
    const replay = await createComponentVariants(f.api, args);
    expect(replay.status).toBe('replayed');
    expect(replay.variants.map((v) => v.nodeId)).toEqual(first.variants.map((v) => v.nodeId));
    expect(f.created).toHaveLength(2);
    await expect(createComponentVariants(f.api, { ...args, variants: [{ ...args.variants[0], position: { x: 76, y: 64 } }] })).rejects.toThrow('OPERATION_ID_CONFLICT');
    f.created[0].children[0].strokeStyleId = 'edited';
    await expect(createComponentVariants(f.api, args)).rejects.toThrow('OPERATION_RESULT_CHANGED');
  });
});
