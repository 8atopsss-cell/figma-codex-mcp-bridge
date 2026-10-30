import * as z from 'zod/v4';
const id = z.string().min(1).max(128);
const map = z.record(id, id).refine(v => Object.keys(v).length <= 500 && new Set(Object.values(v)).size === Object.keys(v).length, 'At most 500 distinct target mappings');
export const frameCompositionSchema = z.object({
  operationId: z.string().min(1).max(80).regex(/^[A-Za-z0-9_-]+$/), nodeId: id, name: z.string().min(1).max(200),
  position: z.object({ x: z.number().finite().min(-100000).max(100000), y: z.number().finite().min(-100000).max(100000) }).strict(),
  frameNodeIds: z.array(id).max(500).default([]),
  componentMappings: z.array(z.object({ sourceNodeId: id, targetComponentId: id, propertyMap: map.default({}), layerMap: map.default({}), valueMap: z.record(id, z.record(z.string().max(200), z.string().max(200))).default({}).refine(v => Object.keys(v).length <= 100 && Object.values(v).every(m => Object.keys(m).length <= 100), 'Bounded variant value maps') }).strict()).max(500).default([]),
  layerStyles: z.array(z.object({ nodeId: id, fillStyleId: id.optional(), strokeStyleId: id.optional(), textStyleId: id.optional(), effectStyleId: id.optional() }).strict()).max(500).default([]),
  dryRun: z.boolean().default(true), expectedState: z.string().regex(/^compose-v1:sha256:[a-f0-9]{64}$/).optional(),
}).strict().superRefine((v, c) => { if (!v.dryRun && !v.expectedState) c.addIssue({ code: 'custom', path: ['expectedState'], message: 'Apply requires preview expectedState' }); });
export type FrameCompositionArgs = z.infer<typeof frameCompositionSchema>;
export interface FrameCompositionResult {
  status: 'preview' | 'applied' | 'replayed' | 'partial'; operationId: string; sourceNodeId: string; parentId: string;
  expectedState: string; nodeId?: string; nodeMap?: Record<string, string>; remainingNodeIds?: string[]; error?: { code: string; message: string };
}
