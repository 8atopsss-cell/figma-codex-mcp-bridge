import * as z from 'zod/v4';

const id = z.string().min(1).max(128);
const ids = z.array(id).max(200).refine(values => new Set(values).size === values.length, 'Duplicate ID');
const propertyMap = z.record(id, id).refine(map => new Set(Object.values(map)).size === Object.keys(map).length, 'Target properties must be distinct');
export const themeMappingSchema = z.object({
  sourceId: id, targetId: id,
  propertyMap: propertyMap.default({}),
  valueMap: z.record(id, z.record(z.string().min(1).max(200), z.string().min(1).max(200))).default({}),
}).strict();
export const listComponentsSchema = z.object({
  rootNodeId: id, query: z.string().max(200).optional(),
  offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(100).default(50),
  scanLimit: z.number().int().min(1).max(20_000).default(20_000),
  expectedScopeSnapshot: z.string().min(1).max(262_144).optional(),
}).strict();
export const themePlanSchema = z.object({
  nodeId: id, libraryRootIds: z.array(id).min(1).max(8).refine(values => new Set(values).size === values.length, 'Duplicate root'),
  targetTheme: z.enum(['light', 'dark']).default('light'), themeProperty: z.string().min(1).max(100).default('theme'),
  mappings: z.array(themeMappingSchema).max(200).default([]).refine(values => new Set(values.map(v => v.sourceId)).size === values.length, 'Duplicate source mapping'),
  sharedComponentIds: ids.default([]), frameFallbackNodeIds: ids.default([]),
  scanLimit: z.number().int().min(1).max(20_000).default(20_000),
}).strict();
export type ThemeMapping = z.infer<typeof themeMappingSchema>;
export type ThemePlanArgs = z.infer<typeof themePlanSchema>;

export interface ThemeProperty {
  type: string; defaultValue?: string | boolean;
  variantOptions?: string[]; preferredValues?: Array<{ type: string; key: string }>;
  slotSettings?: { minChildren?: number | null; maxChildren?: number | null; allowPreferredValuesOnly?: boolean; [key: string]: unknown };
  [key: string]: unknown;
}
export type ThemeDefinitions = Record<string, ThemeProperty>;
export interface ComponentDescriptor {
  id: string; name: string; type: 'COMPONENT' | 'COMPONENT_SET'; key: string; remote: boolean;
  parentId?: string;
  definitionSource: { id: string; name: string; type: 'COMPONENT' | 'COMPONENT_SET' };
  definitions: ThemeDefinitions; schemaStatus: 'available' | 'unavailable'; warnings: string[];
  variantProperties: Record<string, string> | null; variantIds?: string[];
}
export interface ThemeIssue {
  code: string; message: string; severity: 'error' | 'warning';
  sourceProperty?: string; targetProperty?: string; affectedNodeIds?: string[];
  candidates?: string[]; correction?: string;
}
export interface SlotContent {
  propertyId: string; nodeId: string;
  children: Array<{ id: string; type: string; componentKey?: string; componentSetKey?: string }>;
}
export interface ThemeStep {
  nodeId: string; sourceComponentId?: string; sourceSetId?: string; sourceName?: string;
  parentInstanceId?: string;
  targetComponentId?: string; targetSetId?: string; targetName?: string;
  action: 'reuse' | 'keep' | 'mapping_required' | 'alignment_required' | 'missing_variant' | 'missing_component' | 'unknown';
  evidence: 'explicit_mapping' | 'same_set_theme_axis' | 'name_candidate' | 'explicit_shared' | 'scope_search';
  candidates: Array<{ id: string; name: string; type: string }>;
  issues: ThemeIssue[]; blockedBy: string[];
  provisional: boolean; requiresReplanAfterParent: boolean;
  requiresTransferValidation: boolean; mappedValues?: Record<string, string | boolean>;
  proposedProperties?: Record<string, string>; suggestedAction?: 'create_variant' | 'create_component' | 'create_frame';
  absenceConfirmed?: false;
  preservation?: { textNodes: Array<{ id: string; characters: string }>; slots: SlotContent[]; currentProperties: Record<string, unknown>; overrideFields: unknown; width: number; height: number };
}
export interface ThemePlan {
  status: 'blocked' | 'review'; executable: false; targetTheme: string;
  source: { id: string; name: string; type: string }; fileName: string; fileKey?: string;
  scopeRootIds: string[]; scopeComplete: true;
  sourceSnapshot: string; scopeSnapshot: string;
  composition?: { action: 'compose_frame'; nodeId: string };
  steps: ThemeStep[]; limitations: string[];
}
