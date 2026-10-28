import * as z from 'zod/v4';
import { themePlanSchema, type ThemePlan, type ThemeStep } from './theme-conversion.js';

const id = z.string().min(1).max(128);
export const themeCopySchema = themePlanSchema.omit({ frameFallbackNodeIds: true }).extend({
  operationId: z.string().min(1).max(80).regex(/^[A-Za-z0-9_-]+$/),
  name: z.string().min(1).max(200),
  position: z.object({ x: z.number().finite().min(-100_000).max(100_000), y: z.number().finite().min(-100_000).max(100_000) }).strict(),
  layerMap: z.record(id, id).default({}).refine(map => new Set(Object.values(map)).size === Object.keys(map).length, 'Target layers must be distinct'),
  dryRun: z.boolean().default(true), expectedState: z.string().min(1).max(262_144).optional(),
}).strict().superRefine((args, ctx) => {
  if (!args.dryRun && !args.expectedState) ctx.addIssue({ code: 'custom', path: ['expectedState'], message: 'Apply requires preview expectedState' });
  if (Object.keys(args.layerMap).length > 2000) ctx.addIssue({ code: 'custom', path: ['layerMap'], message: 'At most 2000 mapped layers' });
});
export type ThemeCopyArgs = z.infer<typeof themeCopySchema>;
export interface ThemeCopyInventory {
  instances: Array<{ nodeId: string; mainComponentId?: string; parentInstanceId?: string; textNodes: Array<{ id: string; characters: string }>; slots: unknown[]; error?: string }>;
}
export interface ThemeCopyResult {
  status: 'preview' | 'applied' | 'replayed'; operationId: string; sourceNodeId: string; parentId: string;
  name: string; position: { x: number; y: number }; stage: 'parent_only';
  nodeId?: string; nodeMap?: Record<string, string>; expectedState?: string;
  plan: ThemePlan; rootStep: ThemeStep;
  pendingDescendantSteps: Array<ThemeStep & { status: 'pending' }>;
  freshInventory: ThemeCopyInventory; followupRequired: boolean;
  remainingEvidence: string[];
  preservationRestores: Array<{ sourceNodeId: string; targetMasterNodeId: string; originalMainComponentId: string }>;
  previousFailure?: { code: string; details: Record<string, unknown> };
}
