import { vi } from 'vitest';

// Native API-shaped mock: swap replaces descendants, instance IDs retain exact
// master lineage, SLOT.clone() deliberately returns FRAME.
export function copyFixture() {
  let seq = 0;
  const nodes = new Map<string, any>();
  function make(id: string, type: string, values: Record<string, any> = {}) {
    const data = new Map<string, string>();
    const n: any = { id, type, name: id, parent: null, removed: false, visible: true,
      x: 0, y: 0, width: 100, height: 32, ...values,
      getPluginData: vi.fn((k: string) => data.get(k) ?? ''),
      setPluginData: vi.fn((k: string, v: string) => { data.set(k, v); }),
      remove: vi.fn(() => {
        function mark(node: any) { node.removed = true; for (const child of node.children ?? []) mark(child); }
        if (n.parent) n.parent.children.splice(n.parent.children.indexOf(n), 1); n.parent = null; mark(n);
      }),
      resize: vi.fn((w: number, h: number) => { n.width = w; n.height = h; }),
    };
    if (['DOCUMENT', 'PAGE', 'FRAME', 'COMPONENT', 'COMPONENT_SET', 'INSTANCE', 'SLOT'].includes(type)) {
      n.children = [];
      n.appendChild = vi.fn((c: any) => attach(n, c));
    }
    if (type === 'PAGE') n.loadAsync = vi.fn(async () => {});
    if (type === 'COMPONENT') {
      n.key = `key-${id}`; n.remote = false;
      n.componentPropertyDefinitions ??= {}; n.variantProperties ??= null;
    }
    if (type === 'TEXT') {
      n.characters ??= ''; n.fontName ??= { family: 'Inter', style: 'Regular' };
      n.getStyledTextSegments = vi.fn(() => [{ characters: n.characters, start: 0, end: n.characters.length, fontName: n.fontName }]);
      n.getRangeAllFontNames = vi.fn(() => [n.fontName]);
    }
    if (type === 'SLOT') n.limitViolations ??= [];
    n.clone = vi.fn(() => {
      const c = clone(n, `copy-${++seq}`);
      if (n.parent) attach(n.parent, c);
      return c;
    });
    if (type === 'INSTANCE') {
      n.componentProperties ??= {}; n.overrides ??= []; n.scaleFactor ??= 1;
      n.getMainComponentAsync = vi.fn(async () => n.main);
      n.setProperties = vi.fn((props: Record<string, any>) => {
        for (const [k, v] of Object.entries(props)) {
          const d = n.main.componentPropertyDefinitions[k];
          if (!d || d.type === 'SLOT') throw new Error('Invalid property');
          n.componentProperties[k] = { type: d.type, value: v };
        }
      });
      n.swapComponent = vi.fn((main: any) => {
        n.main = main;
        for (const c of [...n.children]) c.remove();
        for (const c of main.children) attach(n, clone(c, `I${n.id};${c.id}`, true));
        n.componentProperties = Object.fromEntries(Object.entries(main.componentPropertyDefinitions).map(([k, d]: any) => [k, { type: d.type, value: d.defaultValue }]));
      });
    }
    nodes.set(id, n); return n;
  }
  function attach(p: any, c: any) {
    if (c.parent) c.parent.children.splice(c.parent.children.indexOf(c), 1);
    p.children.push(c); c.parent = p;
  }
  function clone(n: any, id: string, master = false, direct = true): any {
    const values = Object.fromEntries(Object.entries(n).filter(([k, v]) => !['id', 'type', 'parent', 'children', 'removed'].includes(k) && typeof v !== 'function'));
    if (values.componentProperties) values.componentProperties = JSON.parse(JSON.stringify(values.componentProperties));
    const c = make(id, n.type === 'SLOT' && !master && direct ? 'FRAME' : n.type, values);
    for (const child of n.children ?? []) attach(c, clone(child, master ? `I${id};${child.id}` : `I${id};${child.id.split(';').at(-1)}`, master, false));
    return c;
  }
  const document = make('doc', 'DOCUMENT'), page = make('page', 'PAGE'), kit = make('kit', 'PAGE');
  attach(document, page); attach(document, kit);
  const defs = { 'label#d': { type: 'TEXT', defaultValue: 'Button' }, 'show#d': { type: 'BOOLEAN', defaultValue: true } };
  const dark = make('dark', 'COMPONENT', { componentPropertyDefinitions: defs });
  const light = make('light', 'COMPONENT', { componentPropertyDefinitions: {
    'label#l': { type: 'TEXT', defaultValue: 'Light' }, 'show#l': { type: 'BOOLEAN', defaultValue: true },
  } });
  attach(kit, dark); attach(kit, light);
  const darkText = make('dark-text', 'TEXT', { characters: 'Button', componentPropertyReferences: { characters: 'label#d', visible: 'show#d' } });
  const lightText = make('light-text', 'TEXT', { characters: 'Light', componentPropertyReferences: { characters: 'label#l', visible: 'show#l' } });
  attach(dark, darkText); attach(light, lightText);
  const source = make('source', 'INSTANCE', { main: dark, componentProperties: {
    'label#d': { type: 'TEXT', value: 'Save edited' }, 'show#d': { type: 'BOOLEAN', value: false },
  } }); attach(page, source);
  const text = make('Isource;dark-text', 'TEXT', { characters: 'Save edited', visible: false, componentPropertyReferences: darkText.componentPropertyReferences }); attach(source, text);
  const api: any = { root: document, mixed: Symbol('mixed'), getNodeByIdAsync: vi.fn(async (id: string) => nodes.get(id) ?? null), loadFontAsync: vi.fn(async () => {}) };
  const input = { nodeId: source.id, libraryRootIds: ['kit'], mappings: [{ sourceId: 'dark', targetId: 'light', propertyMap: { 'label#d': 'label#l', 'show#d': 'show#l' } }],
    operationId: 'copy-button', name: 'Light copy', position: { x: 150, y: 10 }, layerMap: { [text.id]: lightText.id } };
  return { api, nodes, document, page, kit, source, text, dark, light, darkText, lightText, input, make, attach };
}

export function slotCopyFixture() {
  const f = copyFixture();
  f.dark.componentPropertyDefinitions = { content: { type: 'SLOT', defaultValue: '', slotSettings: {} } };
  f.light.componentPropertyDefinitions = { content: { type: 'SLOT', defaultValue: '', slotSettings: {} } };
  f.source.componentProperties = { content: { type: 'SLOT', value: '' } };
  f.text.remove(); f.darkText.remove(); f.lightText.remove();
  const ds = f.make('dark-slot', 'SLOT', { componentPropertyReferences: { slotContentId: 'content' } }); f.attach(f.dark, ds);
  const ts = f.make('light-slot', 'SLOT', { componentPropertyReferences: { slotContentId: 'content' } }); f.attach(f.light, ts);
  const slot = f.make('Isource;dark-slot', 'SLOT', { componentPropertyReferences: { slotContentId: 'content' } }); f.attach(f.source, slot);
  const vector = f.make('slot-vector', 'VECTOR', { vectorPaths: [{ windingRule: 'NONZERO', data: 'M0 0 L10 10' }], fills: [] }); f.attach(slot, vector);
  const afterSlot = f.make('after-slot', 'TEXT', { characters: 'After slot' }); f.attach(f.source, afterSlot);
  const targetAfter = f.make('target-after-slot', 'TEXT', { characters: 'After slot' }); f.attach(f.light, targetAfter);
  const input = { ...f.input, mappings: [{ sourceId: 'dark', targetId: 'light' }], layerMap: { [slot.id]: ts.id, [afterSlot.id]: targetAfter.id } };
  return { ...f, slot, vector, afterSlot, ts, targetAfter, input };
}
