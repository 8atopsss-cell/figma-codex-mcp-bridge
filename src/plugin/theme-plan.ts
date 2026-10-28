import { themePlanSchema, type ComponentDescriptor, type ThemeMapping, type ThemePlan, type ThemePlanArgs, type ThemeStep } from '../shared/theme-conversion.js';
import { boundedResult, collectComponents, describeComponent, loadNodePage } from './component-catalog.js';
import { compareThemeCompatibility } from './theme-compatibility.js';
import { assertThemeSourceUnchanged, readThemeSource, type SourceInstance, type ThemeSourceApi } from './theme-source.js';
import { readFileKey } from './file-identity.js';
import { describeError } from './errors.js';
import { fail, isInDocument, jsonValue, stable } from './variant-state.js';

type PlanApi = ThemeSourceApi & Pick<typeof figma, 'root'> & { fileKey?: string };
const themeWord = (value: string, theme: string) => new RegExp(`(^|[\\s_/-])${theme}(?=$|[\\s_/-])`, 'i').test(value);
const familyName = (name: string) => name.toLowerCase().replace(/(^|[\s_/-])(dark|light)(?=$|[\s_/-])/g, '$1').replace(/[\s_/-]+/g, ' ').trim();

function problem(step: ThemeStep, code: string, message: string) {
  step.issues.push({ code, message, severity: 'error' });
}

function targetSlots(node: ComponentNode): string[] {
  const ids: string[] = []; let count = 0;
  function visit(current: SceneNode, depth: number) {
    if (++count > 2000 || depth > 16) fail('LIMIT_EXCEEDED', { stage: 'target-slots', nodeId: node.id });
    if (current.type === 'INSTANCE') return;
    const refs = (current as unknown as { componentPropertyReferences?: { slotContentId?: string } }).componentPropertyReferences;
    if (current.type === 'SLOT' && refs?.slotContentId) ids.push(refs.slotContentId);
    if ('children' in current) current.children.forEach(child => visit(child, depth + 1));
  }
  visit(node, 0); return ids;
}

export async function planThemeConversion(api: PlanApi, input: unknown): Promise<ThemePlan> {
  const args = themePlanSchema.parse(input);
  const source = await readThemeSource(api, args.nodeId);
  const catalog = await collectComponents(api, args.libraryRootIds, args.scanLimit);
  const descriptors = new Map(catalog.components.map(c => [c.id, c]));
  const slotEvidence = new Map<string, { node: ComponentNode; propertyIds: string[] }>();
  const recordSlots = (node: ComponentNode, propertyIds: string[]) => {
    const previous = slotEvidence.get(node.id);
    if (previous && stable(previous.propertyIds) !== stable(propertyIds)) fail('SOURCE_CHANGED', { stage: 'theme-target-slots', nodeId: node.id });
    slotEvidence.set(node.id, { node, propertyIds });
  };
  async function getDescriptor(id: string): Promise<ComponentDescriptor | undefined> {
    if (descriptors.has(id)) return descriptors.get(id);
    const node = await api.getNodeByIdAsync(id);
    if (!node || node.removed || (node.type !== 'COMPONENT' && node.type !== 'COMPONENT_SET') || (!node.remote && !isInDocument(node))) return;
    await loadNodePage(node);
    const value = describeComponent(node, api.mixed); descriptors.set(id, value); return value;
  }
  const steps: ThemeStep[] = [];
  for (const instance of source.instances) {
    const step: ThemeStep = { nodeId: instance.node.id,
      ...(instance.component ? { sourceComponentId: instance.component.id, sourceName: instance.component.name } : {}),
      ...(instance.owner?.type === 'COMPONENT_SET' ? { sourceSetId: instance.owner.id } : {}),
      ...(instance.parentInstanceId ? { parentInstanceId: instance.parentInstanceId } : {}),
      action: 'unknown', evidence: 'scope_search', candidates: [], issues: [], blockedBy: [],
      provisional: !!instance.parentInstanceId, requiresReplanAfterParent: !!instance.parentInstanceId,
      requiresTransferValidation: true,
      preservation: { textNodes: instance.texts, slots: instance.slots,
        currentProperties: jsonValue(instance.properties, api.mixed) as Record<string, unknown>,
        overrideFields: jsonValue(instance.node.overrides, api.mixed), width: instance.node.width, height: instance.node.height },
    };
    try { await resolveStep(instance, step, args, catalog.components, getDescriptor, api, recordSlots); }
    catch (error) { step.action = 'unknown'; problem(step, 'TARGET_INSPECTION_FAILED', describeError(error)); }
    let ancestor = instance.parentInstanceId;
    while (ancestor) {
      const parent = steps.find(s => s.nodeId === ancestor);
      if (!parent) break;
      if (!['reuse', 'keep'].includes(parent.action) || parent.issues.some(i => i.severity === 'error')) step.blockedBy.push(parent.nodeId);
      ancestor = parent.parentInstanceId;
    }
    steps.push(step);
  }
  await assertThemeSourceUnchanged(source, api);
  const currentCatalog = await collectComponents(api, args.libraryRootIds, args.scanLimit);
  if (currentCatalog.scopeSnapshot !== catalog.scopeSnapshot) fail('SOURCE_CHANGED', { stage: 'theme-catalog', rootNodeIds: args.libraryRootIds });
  const catalogIds = new Set(catalog.components.map(c => c.id));
  for (const descriptor of descriptors.values()) {
    if (catalogIds.has(descriptor.id)) continue;
    const current = await api.getNodeByIdAsync(descriptor.id);
    if (!current || current.removed || (current.type !== 'COMPONENT' && current.type !== 'COMPONENT_SET')
      || (!current.remote && !isInDocument(current)) || stable(describeComponent(current, api.mixed)) !== stable(descriptor)) {
      fail('SOURCE_CHANGED', { stage: 'theme-target-schema', nodeId: descriptor.id });
    }
  }
  for (const { node, propertyIds } of slotEvidence.values()) {
    if (node.removed || (!node.remote && !isInDocument(node)) || stable(targetSlots(node)) !== stable(propertyIds)) {
      fail('SOURCE_CHANGED', { stage: 'theme-target-slots', nodeId: node.id });
    }
  }
  await assertThemeSourceUnchanged(source, api);
  const fileKey = readFileKey(api);
  return boundedResult({ status: steps.some(step => !['reuse', 'keep'].includes(step.action) || step.issues.some(i => i.severity === 'error')) ? 'blocked' : 'review',
    executable: false, targetTheme: args.targetTheme, source: { id: source.root.id, name: source.root.name, type: source.root.type },
    fileName: api.root.name, ...(fileKey ? { fileKey } : {}), scopeRootIds: catalog.scopeRootIds, scopeComplete: true,
    sourceSnapshot: source.stamp, scopeSnapshot: catalog.scopeSnapshot,
    ...(source.root.type === 'FRAME' ? { composition: { action: 'compose_frame' as const, nodeId: source.root.id } } : {}),
    steps, limitations: [
      'Read-only, non-executable plan. Compatible schemas do not prove text, override, geometry or slot-content transfer.',
      'Name matches are candidates only. Creation proposals are not proof of global absence outside the scanned local roots.',
      'Nested steps are provisional and must be replanned after any parent substitution.',
    ],
  } satisfies ThemePlan);
}

async function resolveStep(instance: SourceInstance, step: ThemeStep, args: ThemePlanArgs, catalog: ComponentDescriptor[],
  get: (id: string) => Promise<ComponentDescriptor | undefined>, api: PlanApi,
  recordSlots: (node: ComponentNode, propertyIds: string[]) => void) {
  const main = instance.component, owner = instance.owner;
  if (instance.error || !main || !owner || main.schemaStatus !== 'available' || owner.schemaStatus !== 'available') {
    problem(step, 'SOURCE_SCHEMA_UNAVAILABLE', instance.error ?? [...(main?.warnings ?? []), ...(owner?.warnings ?? [])].join('; ')); return;
  }
  const pair = args.mappings.find(m => m.sourceId === main.id) ?? args.mappings.find(m => m.sourceId === owner.id);
  const namedCandidates = catalog.filter(c => (c.type === 'COMPONENT_SET' || c.definitionSource.id === c.id)
    && themeWord(c.name, args.targetTheme) && familyName(c.name) === familyName(owner.name));
  if (!pair && (args.sharedComponentIds.includes(main.id) || args.sharedComponentIds.includes(owner.id))
    && owner.definitions[args.themeProperty]?.type !== 'VARIANT'
    && !themeWord(owner.name, 'dark') && !themeWord(owner.name, 'light') && !namedCandidates.length) {
    step.action = 'keep'; step.evidence = 'explicit_shared'; step.requiresTransferValidation = false; return;
  }
  let mapping: ThemeMapping = pair ?? { sourceId: owner.id, targetId: '', propertyMap: {}, valueMap: {} };
  let target: ComponentDescriptor | undefined;
  if (pair) { step.evidence = 'explicit_mapping'; target = await get(pair.targetId); }
  else if (owner.type === 'COMPONENT_SET' && owner.definitions[args.themeProperty]?.type === 'VARIANT') {
    step.evidence = 'same_set_theme_axis';
    const current = instance.properties[args.themeProperty]?.value ?? main.variantProperties?.[args.themeProperty];
    if (current === args.targetTheme) { step.action = 'keep'; step.requiresTransferValidation = false; return; }
    target = owner; mapping = { ...mapping, targetId: owner.id,
      valueMap: { [args.themeProperty]: { [String(current)]: args.targetTheme } } };
  } else {
    const candidates = namedCandidates;
    step.candidates = candidates.map(c => ({ id: c.id, name: c.name, type: c.type }));
    if (!candidates.length) {
      step.action = 'missing_component'; step.absenceConfirmed = false;
      step.suggestedAction = args.frameFallbackNodeIds.includes(instance.node.id) ? 'create_frame' : owner.type === 'COMPONENT_SET' ? 'create_variant' : 'create_component';
      problem(step, 'TARGET_NOT_FOUND_IN_SCOPE', 'Светлое соответствие не найдено в указанной области. Проверить другие страницы, библиотеки и общий компонент перед созданием.'); return;
    }
    step.evidence = 'name_candidate';
    if (candidates.length !== 1) { step.action = 'mapping_required'; problem(step, 'AMBIGUOUS_TARGET', 'Найдено несколько кандидатов; требуется явная карта компонентов'); return; }
    target = candidates[0]; mapping = { ...mapping, targetId: target.id };
  }
  if (!target) { problem(step, 'TARGET_UNAVAILABLE', `Целевой компонент ${mapping.targetId} недоступен; отсутствие не подтверждено`); return; }
  if (target.schemaStatus !== 'available') { problem(step, 'TARGET_SCHEMA_UNAVAILABLE', target.warnings.join('; ')); return; }
  if (target.type === 'COMPONENT_SET') step.targetSetId = target.id;
  const sourceDefinitions = { ...owner.definitions }, propertyValues = { ...instance.properties };
  if (pair && sourceDefinitions[args.themeProperty]?.type === 'VARIANT' && !target.definitions[mapping.propertyMap[args.themeProperty] ?? args.themeProperty]) {
    delete sourceDefinitions[args.themeProperty]; delete propertyValues[args.themeProperty];
    const { [args.themeProperty]: _themeValue, ...restValues } = mapping.valueMap;
    const { [args.themeProperty]: _themeProperty, ...restProperties } = mapping.propertyMap;
    mapping = { ...mapping, valueMap: restValues, propertyMap: restProperties };
  }
  // Compare property definitions before proposing any missing combination. Slot
  // attachment is checked only on the exact target master selected below.
  const schemaCheck = compareThemeCompatibility({ sourceDefinitions, targetDefinitions: target.definitions,
    propertyMap: mapping.propertyMap, valueMap: mapping.valueMap, slots: instance.slots, attachmentStatus: 'deferred' });
  const schemaIssues = schemaCheck.issues;
  if (schemaIssues.length) {
    step.targetComponentId = target.type === 'COMPONENT' ? target.id : undefined;
    step.issues.push(...schemaIssues);
    step.action = schemaCheck.alignmentRequired ? 'alignment_required' : 'mapping_required';
    return;
  }
  const projected: Record<string, string> = {};
  for (const [sourceId, definition] of Object.entries(owner.definitions)) {
    if (definition.type !== 'VARIANT') continue;
    const targetId = mapping.propertyMap[sourceId] ?? sourceId;
    const current = instance.properties[sourceId]?.value ?? main.variantProperties?.[sourceId];
    if (typeof current !== 'string') { problem(step, 'VARIANT_VALUE_UNAVAILABLE', `Недоступно значение ${sourceId}`); continue; }
    if (target.definitions[targetId]?.type === 'VARIANT') {
      projected[targetId] = targetId === args.themeProperty ? args.targetTheme : mapping.valueMap[sourceId]?.[current] ?? current;
      if (targetId === args.themeProperty) mapping = { ...mapping, valueMap: { ...mapping.valueMap,
        [sourceId]: { ...mapping.valueMap[sourceId], [current]: args.targetTheme } } };
    }
  }
  if (target.definitions[args.themeProperty]?.type === 'VARIANT') {
    projected[args.themeProperty] = args.targetTheme;
    const old = instance.properties[args.themeProperty]?.value;
    if (typeof old === 'string') mapping = { ...mapping, valueMap: { ...mapping.valueMap, [args.themeProperty]: { ...mapping.valueMap[args.themeProperty], [old]: args.targetTheme } } };
  }
  for (const [id, def] of Object.entries(target.definitions)) {
    if (def.type === 'VARIANT' && (!projected[id] || (!def.variantOptions?.includes(projected[id]) && id !== args.themeProperty))) {
      problem(step, 'VARIANT_VALUE_MAPPING_REQUIRED', `Требуется явное сопоставление значения ${id}`);
    }
  }
  if (step.issues.length) { step.action = 'mapping_required'; return; }
  if (target.type === 'COMPONENT_SET') {
    const children = (await Promise.all((target.variantIds ?? []).map(get))).filter((c): c is ComponentDescriptor => !!c);
    if (children.length !== target.variantIds?.length || children.some(c => c.schemaStatus !== 'available')) {
      problem(step, 'TARGET_SCHEMA_UNAVAILABLE', 'Не все варианты целевого набора доступны'); return;
    }
    const matches = children.filter(c => c.variantProperties && Object.keys(c.variantProperties).length === Object.keys(projected).length
      && Object.entries(projected).every(([key, value]) => c.variantProperties?.[key] === value));
    if (matches.length > 1) { problem(step, 'INVALID_VARIANT_SCHEMA', 'Найдены дубли целевой комбинации вариантов'); return; }
    if (!matches.length) { step.action = 'missing_variant'; step.proposedProperties = projected; step.suggestedAction = 'create_variant'; step.absenceConfirmed = false;
      problem(step, 'TARGET_VARIANT_MISSING', 'Точная комбинация вариантов отсутствует; создание требует отдельного согласования и проверки схемы'); return; }
    target = matches[0];
  } else if (target.variantProperties && Object.entries(projected).some(([key, value]) => target!.variantProperties?.[key] !== value)) {
    step.action = 'mapping_required'; problem(step, 'TARGET_VARIANT_MISMATCH', 'Выбранный вариант не сохраняет состояние или размер исходного'); return;
  }
  step.targetComponentId = target.id; step.targetName = target.name;
  if (target.definitionSource.type === 'COMPONENT_SET') step.targetSetId = target.definitionSource.id;
  const actual = await api.getNodeByIdAsync(target.id);
  if (!actual || actual.type !== 'COMPONENT' || actual.removed || (!actual.remote && !isInDocument(actual))) {
    problem(step, 'TARGET_UNAVAILABLE', 'Целевой master недоступен или удалён'); return;
  }
  await loadNodePage(actual);
  const slotProperties = targetSlots(actual);
  recordSlots(actual, slotProperties);
  // Separate themed sets may encode theme in family identity instead of an axis.
  const compatibility = compareThemeCompatibility({ sourceDefinitions, targetDefinitions: target.definitions,
    propertyMap: mapping.propertyMap, valueMap: mapping.valueMap, propertyValues,
    slots: instance.slots, targetSlotPropertyIds: slotProperties });
  step.issues.push(...compatibility.issues); step.mappedValues = compatibility.mappedValues;
  step.action = compatibility.alignmentRequired ? 'alignment_required' : compatibility.compatible && step.evidence !== 'name_candidate' ? 'reuse' : 'mapping_required';
  if (step.evidence === 'name_candidate' && compatibility.compatible) problem(step, 'COMPONENT_MAPPING_REQUIRED', 'Подтвердить соответствие компонентов; совпадение названий является только подсказкой');
}
