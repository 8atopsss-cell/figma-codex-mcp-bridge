import { vi } from 'vitest';

export function themeFixture() {
  const registry = new Map<string, any>();
  function make(id: string, type: string, name: string, values: Record<string, any> = {}): any {
    const node: any = { id, type, name, parent: null, removed: false, visible: true,
      clone: vi.fn(() => { throw new Error('Unexpected write'); }),
      setPluginData: vi.fn(() => { throw new Error('Unexpected metadata write'); }),
      swapComponent: vi.fn(() => { throw new Error('Unexpected swap'); }), ...values };
    if (['DOCUMENT', 'PAGE', 'SECTION', 'FRAME', 'COMPONENT', 'COMPONENT_SET', 'INSTANCE', 'SLOT'].includes(type)) node.children = [];
    if (type === 'PAGE') node.loadAsync = vi.fn(async () => {});
    if (type === 'COMPONENT' || type === 'COMPONENT_SET') {
      node.key = `key-${id}`; node.remote = false;
      node.componentPropertyDefinitions ??= {};
      node.variantProperties ??= null;
    }
    registry.set(id, node); return node;
  }
  function attach(parent: any, ...children: any[]) {
    for (const child of children) { if (child.parent) child.parent.children.splice(child.parent.children.indexOf(child), 1); parent.children.push(child); child.parent = parent; }
  }
  function instance(id: string, main: any, values: Record<string, any> = {}) {
    const properties = Object.fromEntries(Object.entries(main.componentPropertyDefinitions).map(([key, def]: [string, any]) => [key, { type: def.type, value: def.defaultValue }]));
    return make(id, 'INSTANCE', id, { width: 506, height: 365, x: 10, y: 20,
      componentProperties: properties, variantProperties: main.variantProperties, overrides: [],
      getMainComponentAsync: vi.fn(async () => main), ...values });
  }
  const document = make('doc', 'DOCUMENT', 'SD Enterprice');
  const page = make('page', 'PAGE', 'Screens'), kit = make('kit', 'PAGE', 'UI kit'); attach(document, page, kit);
  const darkModal = make('modal-dark', 'COMPONENT', 'Modal dark', { componentPropertyDefinitions: {
    'content#dark': { type: 'SLOT', defaultValue: '', slotSettings: {} },
  } });
  const lightModal = make('modal-light', 'COMPONENT', 'Modal light'); attach(kit, darkModal, lightModal);
  const root = instance('window', darkModal); attach(page, root);
  const slot = make('slot', 'SLOT', 'Content', { componentPropertyReferences: { slotContentId: 'content#dark' } }); attach(root, slot);
  const text = make('title', 'TEXT', 'Title', { characters: 'License request' }); attach(slot, text);
  const darkButtons = make('buttons-dark', 'COMPONENT_SET', 'Button dark', { componentPropertyDefinitions: {
    type: { type: 'VARIANT', defaultValue: 'primary', variantOptions: ['primary', 'secondary'] },
    state: { type: 'VARIANT', defaultValue: 'enable', variantOptions: ['enable', 'disable'] },
    size: { type: 'VARIANT', defaultValue: '32px', variantOptions: ['32px', '40px'] },
  } });
  const lightButtons = make('buttons-light', 'COMPONENT_SET', 'Button light', { componentPropertyDefinitions: {
    type: { type: 'VARIANT', defaultValue: 'primary', variantOptions: ['primary', 'secondary'] },
    state: { type: 'VARIANT', defaultValue: 'enable', variantOptions: ['enable', 'disable'] },
    size: { type: 'VARIANT', defaultValue: '32', variantOptions: ['32', '40'] },
  } }); attach(kit, darkButtons, lightButtons);
  const darkButton = make('dark-enable', 'COMPONENT', 'type=primary,state=enable,size=32px', { variantProperties: { type: 'primary', state: 'enable', size: '32px' } }); attach(darkButtons, darkButton);
  const lightEnable = make('light-enable', 'COMPONENT', 'type=primary,state=enable,size=32', { variantProperties: { type: 'primary', state: 'enable', size: '32' } });
  const lightDisable = make('light-disable', 'COMPONENT', 'type=primary,state=disable,size=32', { variantProperties: { type: 'primary', state: 'disable', size: '32' } }); attach(lightButtons, lightEnable, lightDisable);
  // Variants expose their set's definitions through the catalog's schema owner.
  darkButton.componentPropertyDefinitions = darkButtons.componentPropertyDefinitions;
  lightEnable.componentPropertyDefinitions = lightButtons.componentPropertyDefinitions;
  lightDisable.componentPropertyDefinitions = lightButtons.componentPropertyDefinitions;
  const button = instance('button', darkButton); attach(slot, button);
  const api = { root: document, mixed: Symbol('mixed'), getNodeByIdAsync: vi.fn(async (id: string) => registry.get(id) ?? null) };
  return { api: api as any, registry, document, page, kit, root, darkModal, lightModal, slot, text,
    darkButtons, lightButtons, darkButton, lightEnable, lightDisable, button, make, attach, instance };
}
