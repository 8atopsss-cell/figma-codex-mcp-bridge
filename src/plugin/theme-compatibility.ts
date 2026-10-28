import type { SlotContent, ThemeDefinitions, ThemeIssue } from '../shared/theme-conversion.js';
export interface CompatibilityInput {
  sourceDefinitions: ThemeDefinitions; targetDefinitions: ThemeDefinitions;
  propertyMap?: Record<string, string>; valueMap?: Record<string, Record<string, string>>;
  propertyValues?: Record<string, { type: string; value?: string | boolean }>;
  slots?: SlotContent[]; targetSlotPropertyIds?: string[];
  attachmentStatus?: 'known' | 'deferred';
}
export const ALIGNMENT_MESSAGE = 'Светлый и тёмный компоненты необходимо привести в соответствие';
const label = (key: string) => key.split('#')[0].trim().toLowerCase().replace(/\s+/g, ' ');

export function compareThemeCompatibility(input: CompatibilityInput): { compatible: boolean; alignmentRequired: boolean; attachmentDeferred: boolean; issues: ThemeIssue[]; mappedValues: Record<string, string | boolean> } {
  const issues: ThemeIssue[] = [], mappedValues: Record<string, string | boolean> = {};
  const map = input.propertyMap ?? {}, used = new Set<string>();
  let alignmentRequired = false;
  function issue(code: string, sourceProperty?: string, targetProperty?: string, alignment = false, correction?: string, candidates?: string[]) {
    alignmentRequired ||= alignment;
    issues.push({ code, message: alignment ? ALIGNMENT_MESSAGE : 'Требуется явное сопоставление свойств или значений компонентов', severity: 'error',
      ...(sourceProperty ? { sourceProperty } : {}), ...(targetProperty ? { targetProperty } : {}),
      affectedNodeIds: (input.slots ?? []).filter(s => s.propertyId === sourceProperty).flatMap(s => s.children.map(c => c.id)),
      ...(correction ? { correction } : {}), ...(candidates ? { candidates } : {}) });
  }
  for (const [sourceId, targetId] of Object.entries(map)) {
    if (!input.sourceDefinitions[sourceId] || !input.targetDefinitions[targetId]) issue('PROPERTY_MAP_INVALID', sourceId, targetId);
  }
  for (const sourceId of Object.keys(input.valueMap ?? {})) {
    if (input.sourceDefinitions[sourceId]?.type !== 'VARIANT') issue('VALUE_MAP_INVALID', sourceId);
  }
  for (const [sourceId, source] of Object.entries(input.sourceDefinitions)) {
    const targetId = map[sourceId] ?? sourceId;
    const target = input.targetDefinitions[targetId];
    if (!target) {
      const candidates = Object.keys(input.targetDefinitions).filter(key => label(key) === label(sourceId));
      if (candidates.length) issue('PROPERTY_MAPPING_REQUIRED', sourceId, undefined, false, 'Сопоставить полные ID свойств явно; одинакового названия недостаточно', candidates);
      else issue(source.type === 'SLOT' ? 'SLOT_MISSING' : 'PROPERTY_MISSING', sourceId, undefined, true,
        `Добавить соответствующее ${source.type}-свойство в целевой компонент после согласования`);
      continue;
    }
    if (used.has(targetId)) { issue('PROPERTY_MAP_COLLISION', sourceId, targetId); continue; }
    used.add(targetId);
    if (source.type !== target.type) {
      issue(source.type === 'SLOT' ? 'SLOT_TYPE_MISMATCH' : 'PROPERTY_TYPE_MISMATCH', sourceId, targetId, true,
        `Привести тип целевого свойства ${targetId} к ${source.type}`); continue;
    }
    const current = input.propertyValues?.[sourceId];
    if (current && current.type !== source.type) issue('CURRENT_PROPERTY_TYPE_MISMATCH', sourceId, targetId);
    if (current?.value !== undefined && source.type !== 'SLOT') {
      const value = source.type === 'VARIANT' && typeof current.value === 'string'
        ? input.valueMap?.[sourceId]?.[current.value] ?? current.value : current.value;
      if (source.type === 'VARIANT' && (typeof value !== 'string' || !target.variantOptions?.includes(value))) {
        issue('VARIANT_VALUE_MAPPING_REQUIRED', sourceId, targetId, false, 'Указать соответствующее целевое значение варианта');
      } else mappedValues[targetId] = value;
    }
    if (source.type !== 'SLOT') continue;
    if (input.attachmentStatus !== 'deferred' && !input.targetSlotPropertyIds?.includes(targetId)) {
      issue('SLOT_NOT_ATTACHED', sourceId, targetId, true, 'Связать SLOT-свойство с реальным слоем слота в целевом компоненте'); continue;
    }
    if (input.attachmentStatus !== 'deferred' && input.targetSlotPropertyIds?.filter(id => id === targetId).length !== 1) {
      issue('SLOT_ATTACHMENT_AMBIGUOUS', sourceId, targetId, true, 'Согласовать однозначную привязку целевого слота'); continue;
    }
    const slots = (input.slots ?? []).filter(s => s.propertyId === sourceId);
    if (!slots.length) { issue('SOURCE_SLOT_UNAVAILABLE', sourceId, targetId, true, 'Проверить привязку исходного слота и его содержимое'); continue; }
    if (slots.length !== 1) { issue('SOURCE_SLOT_AMBIGUOUS', sourceId, targetId, true, 'Согласовать однозначную привязку исходного слота'); continue; }
    for (const slot of slots) {
      const count = slot.children.length, settings = target.slotSettings ?? {};
      if (count < (settings.minChildren ?? 0) || count > (settings.maxChildren ?? Infinity)) {
        issue('SLOT_CONTENT_LIMIT', sourceId, targetId, true, 'Согласовать ограничения целевого слота с сохраняемым содержимым');
      }
      if (settings.allowPreferredValuesOnly && slot.children.some(child => !(target.preferredValues ?? []).some(value =>
        value.type === 'COMPONENT' ? value.key === child.componentKey : value.type === 'COMPONENT_SET' && value.key === child.componentSetKey))) {
        issue('SLOT_CONTENT_NOT_ALLOWED', sourceId, targetId, true, 'Согласовать preferredValues/ограничения целевого слота с сохраняемыми компонентами');
      }
    }
  }
  for (const [targetId, target] of Object.entries(input.targetDefinitions)) {
    if (target.type === 'SLOT' && !used.has(targetId) && (target.slotSettings?.minChildren ?? 0) > 0) {
      issue('TARGET_SLOT_REQUIRES_CONTENT', undefined, targetId, true, 'Согласовать наполнение обязательного целевого слота');
    }
  }
  const attachmentDeferred = input.attachmentStatus === 'deferred' && Object.values(input.sourceDefinitions).some(def => def.type === 'SLOT');
  return { compatible: !attachmentDeferred && !issues.some(i => i.severity === 'error'), alignmentRequired, attachmentDeferred, issues, mappedValues };
}
