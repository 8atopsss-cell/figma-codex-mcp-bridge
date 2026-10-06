import { expect, it } from 'vitest';
import { snapshot, differences, type Tree } from '../src/bridge/sync/snapshot.js';
import { previewVariants } from '../src/bridge/sync/preview.js';

function fixture(x: number, width = 112) {
  const root: Tree = { id: 'set', name: 'button dark', type: 'COMPONENT_SET', children: [
    { id: 'variant', name: 'primary', type: 'COMPONENT', width, height: 32,
      properties: { variantProperties: { type: 'primary', state: 'enable', size: '32px' } }, children: [
        { id: 'icon', name: 'icon wrapper', type: 'INSTANCE', width: 16, height: 16,
          properties: { relativeTransform: [[1, 0, x], [0, 1, 8]] }, children: [
            { id: 'vector', name: 'plus', type: 'VECTOR', width: 14, height: 14, properties: { fillStyleId: 'shared' } },
          ] },
      ] },
    { id: 'untouched', name: 'secondary', type: 'COMPONENT', width: 112, height: 32, children: [] },
  ] };
  return snapshot({ dark: root }, { assets: { vector: '<svg><path/></svg>' }, styles: { shared: { paints: [] } } });
}

it('returns only changed variants with actual before/after geometry, context and exact SVG', () => {
  const before = fixture(16), after = fixture(20, 120);
  const result = previewVariants(before, after, differences(before.data, after.data));
  expect(result.variants).toHaveLength(1);
  expect(result.variants[0]).toMatchObject({ id: 'variant', context: { theme: 'dark', variant: { type: 'primary' } },
    before: { nodes: { variant: { width: 112 }, icon: { properties: { relativeTransform: [[1, 0, 16], [0, 1, 8]] } } }, assets: { vector: '<svg><path/></svg>' } },
    after: { nodes: { variant: { width: 120 }, icon: { properties: { relativeTransform: [[1, 0, 20], [0, 1, 8]] } } } } });
  expect(result.variants[0].before?.nodes.untouched).toBeUndefined();
  expect(result.contexts.icon.variantId).toBe('variant');
});

it('finds actual consumers of a shared style change', () => {
  const before = fixture(16), after = fixture(16);
  const result = previewVariants(before, after, [{ path: '/styles/shared/paints', kind: 'changed', before: [], after: ['new'] }]);
  expect(result.variants.map(variant => variant.id)).toEqual(['variant']);
  expect(result.variants[0].changedNodeIds).toContain('vector');
});

it('represents removed variants without substituting a fabricated after image', () => {
  const before = fixture(16), after = snapshot({ dark: { id: 'set', name: 'Button', type: 'COMPONENT_SET', children: [] } });
  const result = previewVariants(before, after, differences(before.data, after.data));
  const variant = result.variants.find(item => item.id === 'variant');
  expect(variant?.before?.rootId).toBe('variant');
  expect(variant?.after).toBeNull();
});
