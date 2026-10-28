import { describe, expect, it } from 'vitest';
import { planThemeConversion } from '../src/plugin/theme-plan.js';
import { themeFixture } from './theme-fixture.js';

const args = { nodeId: 'window', libraryRootIds: ['kit'] };
const buttonMap = { sourceId: 'buttons-dark', targetId: 'buttons-light', valueMap: { size: { '32px': '32' } } };

describe('theme reuse plan', () => {
  it('reports existing-but-incompatible Modal and blocks nested substitutions instead of recoloring', async () => {
    const f = themeFixture();
    const plan = await planThemeConversion(f.api, { ...args, mappings: [{ sourceId: 'modal-dark', targetId: 'modal-light' }, buttonMap] });
    expect(plan).toMatchObject({ status: 'blocked', executable: false, source: { id: 'window' } });
    expect(plan.steps[0]).toMatchObject({ nodeId: 'window', action: 'alignment_required', targetComponentId: 'modal-light' });
    expect(plan.steps[0].issues.some((i: any) => i.code === 'SLOT_MISSING')).toBe(true);
    expect(plan.steps[1]).toMatchObject({ nodeId: 'button', action: 'reuse', targetComponentId: 'light-enable', blockedBy: ['window'] });
    expect(plan.steps[1]).toMatchObject({ provisional: true, requiresReplanAfterParent: true, parentInstanceId: 'window' });
    for (const node of f.registry.values()) { expect(node.swapComponent).not.toHaveBeenCalled(); expect(node.clone).not.toHaveBeenCalled(); expect(node.setPluginData).not.toHaveBeenCalled(); }
  });

  it('treats names as candidates and checks their slot conflicts without silently approving a swap', async () => {
    const f = themeFixture(); const plan = await planThemeConversion(f.api, args);
    expect(plan.steps[0]).toMatchObject({ action: 'alignment_required', evidence: 'name_candidate' });
    expect(plan.steps[0].candidates.map((c: any) => c.id)).toContain('modal-light');
  });

  it('preserves disabled state and explicit size mapping when selecting a target variant', async () => {
    const f = themeFixture(); f.button.componentProperties.state.value = 'disable'; f.button.variantProperties.state = 'disable';
    const plan = await planThemeConversion(f.api, { nodeId: 'button', libraryRootIds: ['kit'], mappings: [buttonMap] });
    expect(plan.steps[0]).toMatchObject({ action: 'reuse', targetComponentId: 'light-disable', mappedValues: { size: '32', state: 'disable' }, requiresTransferValidation: true });
    expect(plan.status).toBe('review'); expect(plan.executable).toBe(false);
  });

  it('reports ambiguity rather than picking the first same-name component', async () => {
    const f = themeFixture(); f.attach(f.kit, f.make('another-light-modal', 'COMPONENT', 'Modal light'));
    const plan = await planThemeConversion(f.api, args);
    expect(plan.steps[0]).toMatchObject({ action: 'mapping_required' });
    expect(plan.steps[0].candidates).toHaveLength(2);
  });

  it('uses same-set theme axes and reports a missing exact combination', async () => {
    const f = themeFixture();
    const set = f.make('themed', 'COMPONENT_SET', 'Button', { componentPropertyDefinitions: {
      theme: { type: 'VARIANT', defaultValue: 'dark', variantOptions: ['dark', 'light'] },
      state: { type: 'VARIANT', defaultValue: 'disable', variantOptions: ['enable', 'disable'] },
    } }); f.attach(f.kit, set);
    const dark = f.make('themed-dark', 'COMPONENT', 'theme=dark,state=disable', { variantProperties: { theme: 'dark', state: 'disable' } });
    const light = f.make('themed-light', 'COMPONENT', 'theme=light,state=disable', { variantProperties: { theme: 'light', state: 'disable' } }); f.attach(set, dark, light);
    dark.componentPropertyDefinitions = set.componentPropertyDefinitions;
    const node = f.instance('themed-instance', dark); f.attach(f.page, node);
    let plan = await planThemeConversion(f.api, { ...args, nodeId: node.id });
    expect(plan.steps[0]).toMatchObject({ action: 'reuse', evidence: 'same_set_theme_axis', targetComponentId: light.id });
    set.children.pop(); light.removed = true;
    plan = await planThemeConversion(f.api, { ...args, nodeId: node.id });
    expect(plan.steps[0]).toMatchObject({ action: 'missing_variant', targetSetId: set.id, proposedProperties: { theme: 'light', state: 'disable' } });
  });

  it('does not turn an inaccessible target or unknown schema into a creation fallback', async () => {
    const f = themeFixture();
    let plan = await planThemeConversion(f.api, { ...args, mappings: [{ sourceId: 'modal-dark', targetId: 'unavailable' }] });
    expect(plan.steps[0]).toMatchObject({ action: 'unknown' });
    Object.defineProperty(f.lightModal, 'componentPropertyDefinitions', { get() { throw new Error('Invalid schema'); } });
    plan = await planThemeConversion(f.api, args); expect(plan.steps[0].action).toBe('unknown');
  });

  it('uses explicit shared components and limits frame fallback to missing targets', async () => {
    const f = themeFixture();
    const master = f.make('common-icon', 'COMPONENT', 'icon/add'); f.attach(f.kit, master);
    const icon = f.instance('icon', master); f.attach(f.page, icon);
    const shared = await planThemeConversion(f.api, { ...args, nodeId: icon.id, sharedComponentIds: ['common-icon'] });
    expect(shared.steps.map((s: any) => s.action)).toEqual(['keep']);
    f.lightModal.name = 'Unrelated';
    const plan = await planThemeConversion(f.api, { ...args, frameFallbackNodeIds: ['window'] });
    expect(plan.steps[0]).toMatchObject({ action: 'missing_component', suggestedAction: 'create_frame', absenceConfirmed: false });
    f.lightModal.name = 'Modal light';
    const conflict = await planThemeConversion(f.api, { ...args, frameFallbackNodeIds: ['window'] });
    expect(conflict.steps[0].action).toBe('alignment_required');
  });

  it('does not let shared/fallback flags bypass an incompatible existing theme component', async () => {
    const f = themeFixture(); f.root.name = 'Modal light'; f.slot.children = [];
    const plan = await planThemeConversion(f.api, { ...args, sharedComponentIds: ['modal-dark'], frameFallbackNodeIds: ['window'] });
    expect(plan.steps[0].action).toBe('alignment_required');
    expect(plan.steps[0].sourceComponentId).toBe('modal-dark');
  });

  it('reports slot alignment before proposing a missing variant in an existing target set', async () => {
    const f = themeFixture();
    const lightSet = f.make('light-modals', 'COMPONENT_SET', 'Modal light', { componentPropertyDefinitions: {
      theme: { type: 'VARIANT', variantOptions: ['dark', 'light'], defaultValue: 'light' },
    } }); f.attach(f.kit, lightSet);
    const plan = await planThemeConversion(f.api, { ...args, mappings: [{ sourceId: 'modal-dark', targetId: lightSet.id }] });
    expect(plan.steps[0].action).toBe('alignment_required');
    expect(plan.steps[0].issues.some((issue: any) => issue.code === 'SLOT_MISSING')).toBe(true);
  });

  it('supports a frame composition and fails closed on catalog truncation or changing source', async () => {
    const f = themeFixture(); const frame = f.make('composition', 'FRAME', 'Dialog'); f.attach(f.page, frame); f.attach(frame, f.root);
    const plan = await planThemeConversion(f.api, { ...args, nodeId: frame.id });
    expect(plan.composition).toMatchObject({ action: 'compose_frame', nodeId: frame.id });
    await expect(planThemeConversion(f.api, { ...args, scanLimit: 1 })).rejects.toThrow('CATALOG_LIMIT_EXCEEDED');
    f.root.getMainComponentAsync.mockImplementation(async () => { f.root.width++; return f.darkModal; });
    await expect(planThemeConversion(f.api, args)).rejects.toThrow('SOURCE_CHANGED');
  });

  it('maps differently named theme axes while retaining the requested target theme in mapped values', async () => {
    const f = themeFixture();
    f.darkButtons.componentPropertyDefinitions.Theme = { type: 'VARIANT', variantOptions: ['dark', 'light'], defaultValue: 'dark' };
    f.darkButton.variantProperties.Theme = 'dark'; f.button.componentProperties.Theme = { type: 'VARIANT', value: 'dark' };
    f.lightButtons.componentPropertyDefinitions.theme = { type: 'VARIANT', variantOptions: ['dark', 'light'], defaultValue: 'light' };
    f.lightEnable.variantProperties.theme = 'light'; f.lightDisable.variantProperties.theme = 'light';
    const plan = await planThemeConversion(f.api, { nodeId: 'button', libraryRootIds: ['kit'],
      mappings: [{ ...buttonMap, propertyMap: { Theme: 'theme' } }] });
    expect(plan.steps[0]).toMatchObject({ action: 'reuse', mappedValues: { theme: 'light', size: '32' }, targetComponentId: 'light-enable' });
  });

  it('rejects local soft-deleted/orphan targets even when Figma still resolves their IDs', async () => {
    const f = themeFixture();
    f.lightButtons.children = f.lightButtons.children.filter((node: any) => node !== f.lightEnable); f.lightEnable.parent = null;
    const plan = await planThemeConversion(f.api, { nodeId: 'button', libraryRootIds: ['kit'],
      mappings: [{ ...buttonMap, targetId: f.lightEnable.id }] });
    expect(plan.steps[0].action).toBe('unknown');
    expect(plan.steps[0].issues.some((issue: any) => issue.code === 'TARGET_UNAVAILABLE')).toBe(true);
  });

  it('rejects a source whose local main component is no longer in the document', async () => {
    const f = themeFixture(); f.darkModal.parent = null;
    const plan = await planThemeConversion(f.api, args);
    expect(plan.steps[0].action).toBe('unknown');
  });

  it('invalidates a plan when the library changes during target inspection', async () => {
    const f = themeFixture(); let loads = 0;
    f.kit.loadAsync.mockImplementation(async () => {
      if (++loads === 2) f.lightButtons.componentPropertyDefinitions.state.variantOptions = ['different'];
    });
    await expect(planThemeConversion(f.api, { nodeId: 'button', libraryRootIds: ['kit'], mappings: [buttonMap] })).rejects.toThrow('SOURCE_CHANGED');
  });

  it('checks slot content limits before proposing a missing target combination', async () => {
    const f = themeFixture();
    f.darkButtons.componentPropertyDefinitions.content = { type: 'SLOT', defaultValue: '' };
    f.lightButtons.componentPropertyDefinitions.content = { type: 'SLOT', defaultValue: '', slotSettings: { maxChildren: 0 } };
    const slot = f.make('button-slot', 'SLOT', 'Content', { componentPropertyReferences: { slotContentId: 'content' } });
    f.attach(f.button, slot); f.attach(slot, f.make('slot-text', 'TEXT', 'Text', { characters: 'Keep' }));
    f.lightButtons.children = f.lightButtons.children.filter((n: any) => n !== f.lightEnable);
    const plan = await planThemeConversion(f.api, { nodeId: 'button', libraryRootIds: ['kit'], mappings: [buttonMap] });
    expect(plan.steps[0].action).toBe('alignment_required');
    expect(plan.steps[0].issues.some((issue: any) => issue.code === 'SLOT_CONTENT_LIMIT')).toBe(true);
  });

  it('invalidates slot attachment changes even if the property schema stays the same', async () => {
    const f = themeFixture();
    f.lightModal.componentPropertyDefinitions = { 'content#light': { type: 'SLOT', defaultValue: '' } };
    const lightSlot = f.make('light-slot', 'SLOT', 'Content', { componentPropertyReferences: { slotContentId: 'content#light' } }); f.attach(f.lightModal, lightSlot);
    let loads = 0; f.kit.loadAsync.mockImplementation(async () => { if (++loads === 3) lightSlot.componentPropertyReferences.slotContentId = 'other'; });
    await expect(planThemeConversion(f.api, { ...args, mappings: [{ sourceId: 'modal-dark', targetId: 'modal-light', propertyMap: { 'content#dark': 'content#light' } }] })).rejects.toThrow('SOURCE_CHANGED');
  });
});
