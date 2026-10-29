import { vi } from 'vitest';
import { copyFixture } from './theme-copy-fixture.js';

export function alignmentFixture() {
  const f = copyFixture();
  f.source.remove(); f.darkText.remove(); f.lightText.remove();
  f.dark.componentPropertyDefinitions = {
    'Optional label#1': { type: 'BOOLEAN', defaultValue: true },
    'body copy#2': { type: 'BOOLEAN', defaultValue: true },
    'button bar#3': { type: 'BOOLEAN', defaultValue: true },
    'Title #4': { type: 'SLOT', defaultValue: '', description: 'Title slot', slotSettings: { maxChildren: 2 } },
    'content #5': { type: 'SLOT', defaultValue: '', preferredValues: [], slotSettings: {} },
  };
  f.light.componentPropertyDefinitions = {};
  for (const n of f.nodes.values()) {
    n.getPluginDataKeys = vi.fn(() => [...data(n).keys()]);
    n.getSharedPluginDataKeys = vi.fn(() => []);
  }
  function data(n: any): Map<string, string> {
    if (n._alignmentData) return n._alignmentData;
    const d = new Map<string, string>(); n._alignmentData = d;
    const previous = n.setPluginData.getMockImplementation();
    n.setPluginData.mockImplementation((k: string, v: string) => { if (v) d.set(k, v); else d.delete(k); previous(k, v); });
    return d;
  }
  const create = (id: string, type: string, props: any = {}) => {
    const n = f.make(id, type, { componentPropertyReferences: {}, fills: [{ type: 'SOLID', color: { r: 1, g: 1, b: 1 } }], ...props });
    n.getPluginDataKeys = vi.fn(() => [...data(n).keys()]);
    if (type === 'TEXT') n.setTextStyleIdAsync = vi.fn(async (value: string) => { n.textStyleId = value; });
    // Native slot assignment converts existing FRAME in place.
    let refs = n.componentPropertyReferences;
    Object.defineProperty(n, 'componentPropertyReferences', { configurable: true, enumerable: true,
      get: () => refs, set: (next: any) => { refs = next; if (next?.slotContentId && n.type === 'FRAME') n.type = 'SLOT'; } });
    return n;
  };
  const ds = create('dark-title', 'SLOT', { width: 384, layoutMode: 'VERTICAL', layoutSizingHorizontal: 'FIXED', layoutGrow: 0, componentPropertyReferences: { slotContentId: 'Title #4' } });
  const db = create('dark-body', 'SLOT', { componentPropertyReferences: { slotContentId: 'content #5', visible: 'body copy#2' } });
  const dt = create('dark-text', 'TEXT', { characters: 'Body', fontSize: 16, paragraphSpacing: 10, textStyleId: 'dark-style', textAutoResize: 'WIDTH_AND_HEIGHT', layoutAlign: 'INHERIT', layoutSizingHorizontal: 'HUG', componentPropertyReferences: { visible: 'Optional label#1' } });
  const bar = create('dark-bar', 'FRAME', { componentPropertyReferences: { visible: 'button bar#3' } });
  const ls = create('light-title', 'FRAME', { width: 392, layoutMode: 'VERTICAL', layoutSizingHorizontal: 'FILL', layoutGrow: 1 });
  const lb = create('light-body', 'FRAME');
  const lt = create('light-text', 'TEXT', { characters: 'Body light', fontSize: 14, paragraphSpacing: 0, textStyleId: 'light-style', textAutoResize: 'HEIGHT', layoutAlign: 'STRETCH', layoutSizingHorizontal: 'FILL', fillStyleId: 'light-paint' });
  const lbar = create('light-bar', 'FRAME');
  for (const n of [ds, db, bar]) f.attach(f.dark, n);
  f.attach(ds, dt);
  for (const n of [ls, lb, lbar]) f.attach(f.light, n);
  f.attach(ls, lt);
  f.dark.getInstancesAsync = vi.fn(async () => []);
  f.light.getInstancesAsync = vi.fn(async () => []);
  let seq = 0;
  f.light.addComponentProperty = vi.fn((name: string, type: string, defaultValue: any, options: any = {}) => {
    const id = `${name}#new${++seq}`;
    f.light.componentPropertyDefinitions[id] = { type, defaultValue, ...structuredClone(options) };
    return id;
  });
  f.light.deleteComponentProperty = vi.fn((id: string) => { delete f.light.componentPropertyDefinitions[id]; });
  const input = { sourceComponentId: f.dark.id, targetComponentId: f.light.id, operationId: 'align-modal', bindings: [
    { sourcePropertyId: 'Optional label#1', targetNodeIds: [lt.id] },
    { sourcePropertyId: 'body copy#2', targetNodeIds: [lb.id] },
    { sourcePropertyId: 'button bar#3', targetNodeIds: [lbar.id] },
    { sourcePropertyId: 'Title #4', targetNodeIds: [ls.id] },
    { sourcePropertyId: 'content #5', targetNodeIds: [lb.id] },
  ], fields: [
    { sourceNodeId: ds.id, targetNodeId: ls.id, fields: ['width', 'layoutGrow', 'layoutSizingHorizontal'] },
    { sourceNodeId: dt.id, targetNodeId: lt.id, fields: ['characters', 'typography', 'textAutoResize', 'layoutAlign', 'layoutSizingHorizontal'] },
  ] };
  return { ...f, input, create, ds, db, dt, bar, ls, lb, lt, lbar };
}
