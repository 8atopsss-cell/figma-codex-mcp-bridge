import { describe, expect, it } from 'vitest';
import { compareThemeCompatibility } from '../src/plugin/theme-compatibility.js';

const content = [{ propertyId: 'body#dark', nodeId: 'slot', children: [{ id: 'text', type: 'TEXT' }] }];
const source = { 'body#dark': { type: 'SLOT', defaultValue: '' } };
const target = { 'body#light': { type: 'SLOT', defaultValue: '' } };

describe('component/slot compatibility', () => {
  it('requires alignment when the existing light component has no compatible slots', () => {
    const result = compareThemeCompatibility({ sourceDefinitions: source, targetDefinitions: {}, slots: content, targetSlotPropertyIds: [] });
    expect(result).toMatchObject({ alignmentRequired: true, compatible: false });
    expect(result.issues[0]).toMatchObject({ code: 'SLOT_MISSING', message: 'Светлый и тёмный компоненты необходимо привести в соответствие', sourceProperty: 'body#dark', affectedNodeIds: ['text'] });
  });

  it('requires explicit full-ID mapping even when labels match', () => {
    const result = compareThemeCompatibility({ sourceDefinitions: source, targetDefinitions: target, slots: content, targetSlotPropertyIds: ['body#light'] });
    expect(result.issues[0].code).toBe('PROPERTY_MAPPING_REQUIRED');
    const mapped = compareThemeCompatibility({ sourceDefinitions: source, targetDefinitions: target, slots: content,
      targetSlotPropertyIds: ['body#light'], propertyMap: { 'body#dark': 'body#light' } });
    expect(mapped.compatible).toBe(true);
  });

  it('checks slot attachment, content count, type and preferred values without repairing masters', () => {
    const base = { sourceDefinitions: source, propertyMap: { 'body#dark': 'body#light' }, slots: content, targetSlotPropertyIds: ['body#light'] };
    for (const [definition, code] of [
      [{ type: 'BOOLEAN', defaultValue: true }, 'SLOT_TYPE_MISMATCH'],
      [{ type: 'SLOT', slotSettings: { maxChildren: 0 } }, 'SLOT_CONTENT_LIMIT'],
      [{ type: 'SLOT', slotSettings: { allowPreferredValuesOnly: true }, preferredValues: [] }, 'SLOT_CONTENT_NOT_ALLOWED'],
    ] as const) {
      const result = compareThemeCompatibility({ ...base, targetDefinitions: { 'body#light': definition } as any });
      expect(result.alignmentRequired).toBe(true); expect(result.issues.some((i: any) => i.code === code)).toBe(true);
    }
    expect(compareThemeCompatibility({ ...base, targetDefinitions: target, targetSlotPropertyIds: [] }).issues[0].code).toBe('SLOT_NOT_ATTACHED');
  });

  it('preserves mapped property values and validates variant value aliases', () => {
    const result = compareThemeCompatibility({ sourceDefinitions: {
      'label#dark': { type: 'TEXT' }, size: { type: 'VARIANT', variantOptions: ['32px'] },
    }, targetDefinitions: { 'label#light': { type: 'TEXT' }, size: { type: 'VARIANT', variantOptions: ['32'] } },
      propertyValues: { 'label#dark': { type: 'TEXT', value: 'Save' }, size: { type: 'VARIANT', value: '32px' } },
      propertyMap: { 'label#dark': 'label#light' }, valueMap: { size: { '32px': '32' } } });
    expect(result).toMatchObject({ compatible: true, mappedValues: { 'label#light': 'Save', size: '32' } });
  });

  it('rejects mapping collisions and required empty target slots', () => {
    expect(compareThemeCompatibility({ sourceDefinitions: { a: { type: 'BOOLEAN' }, b: { type: 'BOOLEAN' } }, targetDefinitions: { c: { type: 'BOOLEAN' } }, propertyMap: { a: 'c', b: 'c' } }).compatible).toBe(false);
    expect(compareThemeCompatibility({ sourceDefinitions: {}, targetDefinitions: { slot: { type: 'SLOT', slotSettings: { minChildren: 1 } } }, targetSlotPropertyIds: ['slot'] }).alignmentRequired).toBe(true);
  });

  it('reports missing empty slots and foreign property IDs rather than permitting fallback', () => {
    const empty = [{ ...content[0], children: [] }];
    const conflict = compareThemeCompatibility({ sourceDefinitions: source, targetDefinitions: {}, slots: empty });
    expect(conflict.issues[0].code).toBe('SLOT_MISSING'); expect(conflict.alignmentRequired).toBe(true);
    const foreign = compareThemeCompatibility({ sourceDefinitions: source, targetDefinitions: target,
      propertyMap: { unrelated: 'body#light' }, slots: empty, targetSlotPropertyIds: ['body#light'] });
    expect(foreign.issues.some(issue => issue.code === 'PROPERTY_MAP_INVALID')).toBe(true);
  });

  it('rejects duplicated source or target slot attachment', () => {
    const base = { sourceDefinitions: source, targetDefinitions: target, propertyMap: { 'body#dark': 'body#light' }, slots: content };
    expect(compareThemeCompatibility({ ...base, targetSlotPropertyIds: ['body#light', 'body#light'] }).issues[0].code).toBe('SLOT_ATTACHMENT_AMBIGUOUS');
    expect(compareThemeCompatibility({ ...base, slots: [content[0], { ...content[0], nodeId: 'second-slot' }], targetSlotPropertyIds: ['body#light'] }).issues[0].code).toBe('SOURCE_SLOT_AMBIGUOUS');
  });

  it('validates slot constraints with deferred attachment without declaring full compatibility', () => {
    const result = compareThemeCompatibility({ sourceDefinitions: source, targetDefinitions: target,
      propertyMap: { 'body#dark': 'body#light' }, slots: content, attachmentStatus: 'deferred' });
    expect(result).toMatchObject({ compatible: false, attachmentDeferred: true, alignmentRequired: false, issues: [] });
  });
});
