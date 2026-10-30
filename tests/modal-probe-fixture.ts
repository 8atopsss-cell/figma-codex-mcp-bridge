import { vi } from 'vitest';

// Models native automatic parenting, FRAME->SLOT conversion, immutable inherited
// topology, and the native prohibition on property bindings beneath SLOT.
export function modalProbeFixture() {
  const nodes = new Map<string, any>(); let seq = 0;
  const state = { denyLegacyReparent: false, failCreateAt: 0, creates: 0, pageLimit: false };
  let api: any;
  function make(type: string, id = `new:${++seq}`): any {
    const data = new Map<string, string>(); let refs: any = {};
    const n: any = { id, type, name: type, parent: null, removed: false, visible: true, x: 0, y: 0,
      width: 100, height: 30, fills: [], componentPropertyDefinitions: {}, children: [], limitViolations: [],
      resize: vi.fn((width: number, height: number) => { n.width = width; n.height = height; }),
      ...(type === 'PAGE' ? { backgrounds: [], guides: [], flowStartingPoints: [], prototypeBackgrounds: [], exportSettings: [], explicitVariableModes: {}, resolvedVariableModes: {}, prototypeStartNode: null } : {}),
      getPluginData: vi.fn((k: string) => data.get(k) ?? ''), getPluginDataKeys: vi.fn(() => [...data.keys()]),
      setPluginData: vi.fn((k: string, v: string) => { if (Buffer.byteLength(k + v) >= 100_000) throw Error('pluginData limit'); data.set(k, v); }),
      appendChild: vi.fn((child: any) => {
        if (state.denyLegacyReparent && child.parent?.type === 'SLOT' && child.characters === 'Legacy optional') throw Error('native reparent restriction');
        if (n.type === 'INSTANCE') throw Error('inherited children immutable');
        if (child.parent) child.parent.children = child.parent.children.filter((c: any) => c !== child);
        n.children.push(child); child.parent = n;
      }),
      addComponentProperty: vi.fn((name: string, kind: string, value: unknown) => {
        const key = `${name}#${++seq}`; n.componentPropertyDefinitions[key] = kind === 'SLOT' ? { type: kind } : { type: kind, defaultValue: value }; return key;
      }),
      getStyledTextSegments: vi.fn(() => [{ characters: n.characters, fontName: n.fontName, fontSize: n.fontSize }]),
      getMainComponentAsync: vi.fn(async () => n.main),
      setProperties: vi.fn((properties: any) => {
        for (const [key, value] of Object.entries(properties)) {
          if (n.main.componentPropertyDefinitions[key]?.type === 'SLOT') throw Error('cannotSetSlotProperty');
          n.componentProperties[key] = { type: 'BOOLEAN', value };
          const visit = (node: any) => { if (node.componentPropertyReferences.visible === key) node.visible = value; node.children.forEach(visit); }; visit(n);
        }
      }),
      createInstance: vi.fn(() => {
        const copy = (source: any, root = false): any => {
          const c = make(root ? 'INSTANCE' : source.type); c.name = source.name; c.characters = source.characters; c.visible = source.visible;
          c.fontName = source.fontName; c.fontSize = source.fontSize;
          c.componentPropertyReferences = { ...source.componentPropertyReferences };
          c.children = source.children.map((child: any) => { const inner = copy(child); inner.parent = c; return inner; }); return c;
        };
        const instance = copy(n, true); instance.main = n; instance.componentProperties = Object.fromEntries(Object.entries(n.componentPropertyDefinitions).map(([k, d]: [string, any]) => [k, { type: d.type, value: d.defaultValue }]));
        api.currentPage.appendChild(instance); return instance;
      }),
      remove: vi.fn(() => { throw Error('probe must never delete'); }),
    };
    Object.defineProperty(n, 'componentPropertyReferences', { get: () => refs, set: (value: any) => {
      let parent = n.parent; while (parent) { if (parent.type === 'SLOT' && Object.keys(value).length) throw Error('Cannot bind a sublayer of a slot'); parent = parent.parent; }
      refs = value; if (value.slotContentId && n.type === 'FRAME') n.type = 'SLOT';
    } });
    nodes.set(n.id, n); return n;
  }
  const root = make('DOCUMENT', 'doc'); const page = make('PAGE', 'user-page'); root.appendChild(page);
  const user = make('TEXT', 'user-text'); user.characters = 'Untouched'; page.appendChild(user); page.selection = [user];
  api = { root, currentPage: page, fileKey: 'file', mixed: Symbol('mixed'),
    getNodeByIdAsync: vi.fn(async (id: string) => nodes.get(id) ?? null),
    loadFontAsync: vi.fn(async () => {}),
  };
  for (const [method, type] of [['createPage', 'PAGE'], ['createComponent', 'COMPONENT'], ['createFrame', 'FRAME'], ['createText', 'TEXT']]) {
    api[method] = vi.fn(() => {
      if (type === 'PAGE' && state.pageLimit) throw Error('in createPage: The Starter plan only comes with 3 pages. Upgrade to Professional for unlimited pages: https://www.figma.com/pricing');
      if (++state.creates === state.failCreateAt) throw Error('native create failed');
      const n = make(type); (type === 'PAGE' ? root : api.currentPage).appendChild(n); return n;
    });
  }
  return { api, root, page, user, nodes, state, make };
}
