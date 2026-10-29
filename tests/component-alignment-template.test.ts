import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { alignmentFixture } from './component-alignment-fixture.js';
import { alignComponent } from '../src/plugin/component-alignment.js';

// Exact reviewed request. API-shaped fixture keeps source/target IDs, SLOT
// getter omission, nested light mains, extra hidden icon and seven field pairs.
function modalFixture() {
  const f = alignmentFixture();
  const input = JSON.parse(readFileSync('docs/superpowers/plans/2026-10-28-modal-light-alignment.request.json', 'utf8'));
  const rename = (n: any, id: string) => { f.nodes.delete(n.id); n.id = id; f.nodes.set(id, n); };
  for (const [n, id] of [[f.dark, '2046:48406'], [f.light, '4745:44256'], [f.ds, '2046:48403'], [f.ls, '4745:44237'],
    [f.db, '2043:48379'], [f.lb, '4745:44241'], [f.dt, '2046:48404'], [f.lt, '4745:44238'], [f.bar, '2043:48397'], [f.lbar, '4745:44243']] as const) rename(n, id);
  const propertyIds: Record<string, string> = { 'Optional label#1': 'Optional label#2046:0', 'body copy#2': 'body copy#2674:0', 'button bar#3': 'button bar#2046:2', 'Title #4': 'Title #12705:1', 'content #5': 'content #12416:0' };
  f.dark.componentPropertyDefinitions = Object.fromEntries(Object.entries(f.dark.componentPropertyDefinitions).map(([id, d]: any) => {
    const def = { ...d }; if (def.type === 'SLOT') delete def.defaultValue; return [propertyIds[id], def];
  }));
  for (const n of [f.ds, f.db, f.dt, f.bar]) n.componentPropertyReferences = Object.fromEntries(Object.entries(n.componentPropertyReferences).map(([key, id]: any) => [key, propertyIds[id]]));
  const dh = f.create('2418:60886', 'FRAME', { paddingRight: 56, layoutMode: 'HORIZONTAL' }); f.attach(f.dark, dh); f.attach(dh, f.ds);
  const lh = f.create('4745:44236', 'FRAME', { paddingRight: 48, layoutMode: 'HORIZONTAL' }); f.attach(f.light, lh); f.attach(lh, f.ls);
  const title = f.create('2046:48405', 'TEXT', { characters: 'Modal title' }); f.attach(f.ds, title);
  const lightTitle = f.create('4745:44239', 'TEXT', { characters: 'modal title' }); f.attach(f.ls, lightTitle);
  const body = f.create('2043:48383', 'TEXT', { characters: 'Body copy', fontSize: 16, paragraphSpacing: 10, textStyleId: 'dark-body-style', textWrapStyle: 'AUTO', openTypeFeatures: { LIGA: true } }); f.attach(f.db, body);
  const lightBody = f.create('4745:44242', 'TEXT', { characters: 'Body copy', fontSize: 14, paragraphSpacing: 0, textStyleId: 'light-body-style', textWrapStyle: 'BALANCE', openTypeFeatures: {}, fillStyleId: 'light-body-paint' }); f.attach(f.lb, lightBody);
  let features = {};
  Object.defineProperty(lightBody, 'openTypeFeatures', { configurable: true, enumerable: true, get: () => features });
  lightBody.setTextStyleIdAsync.mockImplementation(async (id: string) => {
    lightBody.textStyleId = id;
    if (id === body.textStyleId) { lightBody.fontSize = body.fontSize; lightBody.paragraphSpacing = body.paragraphSpacing; lightBody.textWrapStyle = body.textWrapStyle; features = structuredClone(body.openTypeFeatures); }
  });
  const buttons: any[] = [];
  for (const row of [
    ['2043:48387', '4936:44979', '1900:45136', '4391:92075', '4391:92073', 'отменить'],
    ['2043:48392', '4936:45014', '1900:44763', '4391:92048', '4391:92046', 'сохранить'],
  ]) {
    const [darkId, lightId, darkLabelId, lightLabelId, lightMainId, label] = row;
    const darkMain = f.create(`main-${darkId}`, 'COMPONENT', { key: `dark-key-${darkId}`, remote: false, componentPropertyDefinitions: {} }); f.attach(f.kit, darkMain);
    const lightMain = f.create(lightMainId, 'COMPONENT', { key: `light-key-${lightMainId}`, remote: false, componentPropertyDefinitions: {} }); f.attach(f.kit, lightMain);
    const d = f.create(darkId, 'INSTANCE', { main: darkMain, layoutSizingHorizontal: 'HUG' }); f.attach(f.bar, d);
    const l = f.create(lightId, 'INSTANCE', { main: lightMain, layoutSizingHorizontal: 'HUG' }); f.attach(f.lbar, l);
    const dt = f.create(`I${darkId};${darkLabelId}`, 'TEXT', { characters: label }); f.attach(d, dt);
    const lt = f.create(`I${lightId};${lightLabelId}`, 'TEXT', { characters: 'button', fillStyleId: 'light-button-paint' }); f.attach(l, lt);
    buttons.push(l);
  }
  const extra = f.create('hidden-light-trailing-icon', 'VECTOR', { visible: false }); f.attach(buttons[1], extra);
  const add = f.light.addComponentProperty.getMockImplementation()!;
  f.light.addComponentProperty.mockImplementation((...args: any[]) => { const id = add(...args); if (args[1] === 'SLOT') delete f.light.componentPropertyDefinitions[id].defaultValue; return id; });
  return { ...f, input, body, lightBody, lightTitle, buttons, extra, lh };
}

describe('reviewed Modal dark/light template request', () => {
  it('applies seven exact field pairs and five native schema properties, preserving light mains and extra icon', async () => {
    const f = modalFixture();
    const before = f.light.children.map((n: any) => n.id), extraParent = f.extra.parent;
    const p = await alignComponent(f.api, f.input);
    expect(p.plan.properties.map(pr => pr.sourcePropertyId)).toEqual(f.input.bindings.map((b: any) => b.sourcePropertyId));
    const r = await alignComponent(f.api, { ...f.input, dryRun: false, expectedState: p.expectedState });
    expect(r.status).toBe('applied'); expect(f.lh.paddingRight).toBe(56); expect(f.ls.width).toBe(384);
    expect(f.lightTitle.characters).toBe('Modal title'); expect(f.lightBody.fontSize).toBe(16); expect(f.lightBody.fillStyleId).toBe('light-body-paint');
    expect(f.buttons.map(b => b.children[0].characters)).toEqual(['отменить', 'сохранить']);
    expect((await f.buttons[0].getMainComponentAsync()).id).toBe('4391:92073'); expect((await f.buttons[1].getMainComponentAsync()).id).toBe('4391:92046');
    expect(f.extra.parent).toBe(extraParent); expect(f.extra.visible).toBe(false); expect(f.light.children.map((n: any) => n.id)).toEqual(before);
    expect(f.lbar.type).toBe('FRAME'); expect(Object.keys(f.light.componentPropertyDefinitions)).toHaveLength(5);
    expect(Object.keys(f.light.componentPropertyDefinitions).some(id => id.includes('content_1'))).toBe(false);
  });
});
