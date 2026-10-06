import { describe, expect, it } from 'vitest';
import { collect } from '../src/bridge/sync/collect.js';
import { differences, snapshot, type Tree } from '../src/bridge/sync/snapshot.js';

const tree = (): Tree => ({ id: 'set', name: 'Button', type: 'COMPONENT_SET', x: 10, y: 20, width: 200,
  childCount: 1, children: [{ id: 'variant', name: 'Light', type: 'COMPONENT', x: 30, y: 40, width: 100,
    properties: { paddingLeft: 8, absoluteTransform: [[1, 0, 40], [0, 1, 60]], relativeTransform: [[1, 0, 30], [0, 1, 40]] },
    childCount: 1, children: [{ id: 'text', name: 'Label', type: 'TEXT', x: 8, y: 0, characters: 'button', properties: { fontSize: 14 } }] }] });

describe('design comparison', () => {
  it('does not export SVG below a hidden parent and keeps the raw hidden subtree', async () => {
    const svgCalls: string[] = [];
    const result = await collect({ call: async (method, args) => {
      const id = (args as { nodeId?: string }).nodeId;
      if (method === 'styles.list') return { paints: [], texts: [], effects: [] };
      if (method === 'node.svg') { svgCalls.push(id!); throw new Error('No visible layers'); }
      if (id === 'set') return { id, name: 'Button', type: 'COMPONENT_SET', childCount: 1,
        children: [{ id: 'hidden', name: 'Hidden', type: 'INSTANCE' }] };
      if (id === 'hidden') return { id, name: 'Hidden', type: 'INSTANCE', properties: { visible: false }, childCount: 1,
        children: [{ id: 'vector', name: 'Icon', type: 'VECTOR' }] };
      return { id, name: 'Icon', type: 'VECTOR', properties: { visible: true }, warnings: ['VECTOR requires SVG or asset export for exact rendering'] };
    } }, [{ theme: 'light', componentSetId: 'set' }]);
    expect(svgCalls).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.data.assets).toEqual({ vector: { status: 'not-rendered' } });
    expect(result.data.nodes).toHaveProperty('vector');
  });
  it('returns an incomplete snapshot when a visible SVG cannot be exported', async () => {
    const result = await collect({ call: async (method) => {
      if (method === 'styles.list') return { paints: [], texts: [], effects: [] };
      if (method === 'node.svg') throw new Error('Export failed');
      return { id: 'vector', name: 'Icon', type: 'VECTOR', properties: { visible: true },
        warnings: ['VECTOR requires SVG or asset export for exact rendering'] };
    } }, [{ theme: 'light', componentSetId: 'vector' }]);
    expect(result.warnings).toContain('vector: SVG unavailable: Export failed');
  });
  it('ignores set and variant packing but preserves inner geometry and zero values', () => {
    const first = tree(); const second = tree();
    second.x = 700; second.width = 800;
    second.children![0].x = 60;
    second.children![0].properties!.absoluteTransform = [[1, 0, 760], [0, 1, 60]];
    second.children![0].properties!.relativeTransform = [[1, 0, 60], [0, 1, 40]];
    expect(snapshot({ light: first }).id).toBe(snapshot({ light: second }).id);
    second.children![0].properties!.paddingLeft = 0;
    expect(differences(snapshot({ light: first }).data, snapshot({ light: second }).data)).toEqual([
      { path: '/nodes/variant/properties/paddingLeft', kind: 'changed', before: 8, after: 0 },
    ]);
    second.children![0].children![0].x = 0;
    expect(snapshot({ light: first }).id).not.toBe(snapshot({ light: second }).id);
  });
  it('rejects incomplete data while recognising a fully merged paginated export', () => {
    const value = tree(); value.warnings = ['children omitted by depth limit; increase depth for complete design data'];
    expect(snapshot({ light: value }).warnings).toEqual([]);
    value.childCount = 2;
    expect(snapshot({ light: value }).warnings).toContain('set: incomplete descendants');
    value.childCount = 1;
    value.children![0].warnings = ['component property definitions unavailable'];
    expect(snapshot({ light: value }).warnings.length).toBe(1);
  });
  it('keeps missing distinct from zero and paint order significant; cancelled edits produce no diff', () => {
    expect(differences({}, { padding: 0 })).toEqual([{ path: '/padding', kind: 'added', after: 0 }]);
    expect(differences({ fills: [1, 2] }, { fills: [2, 1] })).toHaveLength(1);
    expect(differences({ padding: 8 }, { padding: 8 })).toEqual([]);
  });
  it('reads all children across root pagination without calling write methods', async () => {
    const calls: string[] = [];
    const result = await collect({ call: async (method, args) => {
      calls.push(method);
      if (method === 'styles.list') return { paints: [], texts: [], effects: [] };
      const { nodeId, offset } = args as { nodeId: string; offset: number };
      if (nodeId === 'set') return { id: 'set', name: 'Button', type: 'COMPONENT_SET', childCount: 2,
        children: [{ id: offset ? 'b' : 'a', name: 'child', type: 'COMPONENT' }], warnings: ['children omitted by node limit'] };
      return { id: nodeId, name: 'child', type: 'COMPONENT', childCount: 0, children: [] };
    } }, [{ theme: 'light', componentSetId: 'set' }]);
    expect(result.warnings).toEqual([]);
    expect(calls.every((method) => ['node.tree', 'styles.list'].includes(method))).toBe(true);
    expect((result.data.nodes as Record<string, unknown>)).toHaveProperty('b');
  });
});
