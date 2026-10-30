import { expect, it, vi } from 'vitest';
import { getNodeTree } from '../src/plugin/read.js';

type MockNode = Record<string, any>;
function fixture() {
  const document: MockNode = { id: '0:0', name: 'Document', type: 'DOCUMENT', parent: null, children: [] };
  const page: MockNode = { id: '0:1', name: 'Page', type: 'PAGE', parent: document, children: [], loadAsync: vi.fn(async () => {}) };
  document.children.push(page);
  const component: MockNode = { id: '1:1', name: 'Modal', type: 'COMPONENT', key: 'modal-key', remote: false, removed: false, parent: page, children: [], componentPropertyDefinitions: {} };
  page.children.push(component);
  const instance = (id: string): MockNode => {
    const node = { id, name: 'Modal instance', type: 'INSTANCE', removed: false, parent: page, children: [], overrides: [], getMainComponentAsync: vi.fn(async () => component) };
    page.children.push(node);
    return node;
  };
  let instances = [instance('2:2'), instance('2:1')];
  component.getInstancesAsync = vi.fn(async () => instances);
  const read = (node: MockNode = component, depth = 0) => getNodeTree({ getNodeByIdAsync: vi.fn(async () => node) } as unknown as Parameters<typeof getNodeTree>[0], { nodeId: node.id, depth, offset: 0, limit: 100 });
  return { document, page, component, instance, get instances() { return instances; }, set instances(value) { instances = value; }, read };
}

it('exports native instance override IDs and fields without mutation', async () => {
  const f = fixture(), node = f.instances[0];
  node.overrides = [{ id: 'I2:2;1:4', overriddenFields: ['characters', 'visible'] }];
  const before = JSON.stringify(node.overrides);
  const tree = await f.read(node);
  expect(tree.properties?.overrides).toEqual(node.overrides);
  expect(JSON.stringify(node.overrides)).toBe(before);
  expect(tree).not.toHaveProperty('instanceInventory');
  expect(f.component.getInstancesAsync).not.toHaveBeenCalled();
});

it('preserves override getter failures as ordinary property warnings', async () => {
  const f = fixture(), node = f.instances[0];
  Object.defineProperty(node, 'overrides', { get() { throw new Error('native overrides unavailable'); } });
  const tree = await f.read(node);
  expect(tree.properties).not.toHaveProperty('overrides');
  expect(tree.warnings?.join(' ')).toContain(`overrides unavailable on ${node.id}: native overrides unavailable`);
});

it('exports complete sorted root component membership with bounded digest', async () => {
  const f = fixture();
  const tree = await f.read();
  expect(tree.instanceInventory).toEqual({ complete: true, count: 2, instanceIds: ['2:1', '2:2'], snapshot: expect.stringMatching(/^instance-membership-v1:sha256:[a-f0-9]{64}$/) });
  expect(f.component.getInstancesAsync).toHaveBeenCalledTimes(2);
  expect(f.instances[0].getMainComponentAsync).toHaveBeenCalled();
  const snapshot = tree.instanceInventory?.snapshot;
  f.instances.reverse();
  expect((await f.read()).instanceInventory?.snapshot).toBe(snapshot);
  f.component.key = 'changed-key';
  expect((await f.read()).instanceInventory?.snapshot).not.toBe(snapshot);
});

it('confirms empty membership only after successful native enumeration and recheck', async () => {
  const f = fixture(); f.instances = [];
  expect((await f.read()).instanceInventory).toMatchObject({ complete: true, count: 0, instanceIds: [], snapshot: expect.any(String) });
});

it('accepts the full 1000 instance bound without any synchronous mainComponent reads', async () => {
  const f = fixture();
  f.instances = Array.from({ length: 1000 }, (_, i) => f.instance(`3:${i}`));
  for (const node of f.instances) Object.defineProperty(node, 'mainComponent', { get() { throw new Error('dynamic-page synchronous access forbidden'); } });
  expect((await f.read()).instanceInventory).toMatchObject({ complete: true, count: 1000 });
});

it('bounds async link work even when the native array changes during an await', async () => {
  const f = fixture();
  let extra: MockNode;
  f.instances[0].getMainComponentAsync = vi.fn(async () => {
    extra = f.instance('9:9');
    f.instances.push(extra);
    return f.component;
  });
  expect((await f.read()).instanceInventory).toMatchObject({ complete: false });
  expect(extra!.getMainComponentAsync).not.toHaveBeenCalled();
});

it('does not enumerate nested components, component sets or referenced instance mains', async () => {
  const f = fixture();
  const set: MockNode = { id: '1:0', name: 'Modal set', type: 'COMPONENT_SET', key: 'set-key', parent: f.page, children: [f.component], componentPropertyDefinitions: {} };
  f.page.children = [set, ...f.instances]; f.component.parent = set;
  const tree = await f.read(set, 1);
  expect(tree).not.toHaveProperty('instanceInventory');
  expect(tree.children?.[0]).not.toHaveProperty('instanceInventory');
  expect(f.component.getInstancesAsync).not.toHaveBeenCalled();
  await f.read(f.instances[0]);
  expect(f.component.getInstancesAsync).not.toHaveBeenCalled();
});

it.each(['remote', 'detached'] as const)('does not enumerate %s root components', async (state) => {
  const f = fixture();
  if (state === 'remote') f.component.remote = true;
  else f.page.children = f.instances;
  expect(await f.read()).not.toHaveProperty('instanceInventory');
  expect(f.component.getInstancesAsync).not.toHaveBeenCalled();
});

it.each(['missing', 'throwing', 'duplicate', 'detached', 'wrong-main', 'main-unavailable', 'truncated', 'membership-drift', 'late-detach', 'owner-drift', 'final-owner-detach', 'final-enumeration-error'] as const)('fails closed for %s inventory', async (state) => {
  const f = fixture();
  if (state === 'missing') delete f.component.getInstancesAsync;
  if (state === 'throwing') f.component.getInstancesAsync = vi.fn(async () => { throw new Error('native inventory failed'); });
  if (state === 'duplicate') f.instances = [f.instances[0], f.instances[0]];
  if (state === 'detached') f.page.children = [f.component, f.instances[1]];
  if (state === 'wrong-main') f.instances[0].getMainComponentAsync = vi.fn(async () => ({ ...f.component, id: '9:9' }));
  if (state === 'main-unavailable') f.instances[0].getMainComponentAsync = vi.fn(async () => { throw new Error('main unavailable'); });
  if (state === 'truncated') f.instances = Array.from({ length: 1001 }, (_, i) => f.instance(`3:${i}`));
  if (state === 'membership-drift') f.component.getInstancesAsync = vi.fn().mockResolvedValueOnce(f.instances).mockResolvedValue([f.instances[0]]);
  if (state === 'late-detach') f.instances[1].getMainComponentAsync = vi.fn(async () => { f.page.children = [f.component, f.instances[1]]; return f.component; });
  if (state === 'owner-drift') f.instances[1].getMainComponentAsync = vi.fn(async () => { f.component.key = 'new-key'; return f.component; });
  if (state === 'final-owner-detach') f.component.getInstancesAsync = vi.fn().mockResolvedValueOnce(f.instances).mockImplementation(async () => { f.page.children = f.instances; return f.instances; });
  if (state === 'final-enumeration-error') f.component.getInstancesAsync = vi.fn().mockResolvedValueOnce(f.instances).mockRejectedValue(new Error('final enumeration failed'));
  const tree = await f.read();
  expect(tree.instanceInventory).toMatchObject({ complete: false, reason: expect.any(String), instanceIds: expect.any(Array) });
  expect(tree.instanceInventory?.instanceIds.length).toBeLessThanOrEqual(1000);
  expect(tree.instanceInventory).not.toHaveProperty('snapshot');
  expect(tree.warnings?.join(' ')).toContain('instance inventory incomplete');
});

it('rechecks membership after all tree traversal awaits', async () => {
  const f = fixture();
  const child = { ...f.instances[0], id: 'I1:1;2:2', parent: f.component, getMainComponentAsync: vi.fn(async () => { f.instances = [f.instances[0]]; return f.component; }) };
  f.component.children = [child];
  const tree = await f.read(f.component, 1);
  expect(tree.instanceInventory).toMatchObject({ complete: true, count: 1, instanceIds: ['2:2'] });
});
