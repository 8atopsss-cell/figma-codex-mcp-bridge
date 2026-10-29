import * as z from 'zod/v4';

const id = z.string().min(1).max(128);
export const componentAlignmentFieldSchema = z.enum(['paddingRight', 'width', 'layoutGrow', 'layoutAlign', 'layoutSizingHorizontal', 'textAutoResize', 'characters', 'typography']);
export type ComponentAlignmentField = z.infer<typeof componentAlignmentFieldSchema>;
export const componentAlignmentSchema = z.object({
  sourceComponentId: id, targetComponentId: id,
  operationId: z.string().min(1).max(80).regex(/^[A-Za-z0-9_-]+$/),
  bindings: z.array(z.object({ sourcePropertyId: id, targetNodeIds: z.array(id).min(1).max(100) }).strict()).min(1).max(100),
  fields: z.array(z.object({ sourceNodeId: id, targetNodeId: id, fields: z.array(componentAlignmentFieldSchema).min(1).max(8) }).strict()).max(200).default([]),
  dryRun: z.boolean().default(true), expectedState: z.string().min(1).max(262_144).optional(),
}).strict().superRefine((args, ctx) => {
  if (!args.dryRun && !args.expectedState) ctx.addIssue({ code: 'custom', path: ['expectedState'], message: 'Apply requires preview expectedState' });
  if (args.sourceComponentId === args.targetComponentId) ctx.addIssue({ code: 'custom', message: 'Distinct source and target required' });
});
export type ComponentAlignmentArgs = z.infer<typeof componentAlignmentSchema>;
export interface ComponentAlignmentPlan {
  properties: Array<{ sourcePropertyId: string; name: string; type: 'BOOLEAN' | 'SLOT'; defaultValue: boolean | string;
    options: { description?: string; preferredValues?: unknown[]; slotSettings?: Record<string, unknown> };
    sourceNodeIds: string[]; targetNodeIds: string[] }>;
  fields: Array<{ sourceNodeId: string; targetNodeId: string; field: ComponentAlignmentField; before: unknown; after: unknown }>;
  nativeGeometryChanges: Array<{ nodeId: string; sourceNodeId: string; field: string; before: number; after: number; reason: string }>;
}
export interface ComponentAlignmentResult {
  status: 'preview' | 'applied' | 'replayed'; operationId: string; sourceComponentId: string; targetComponentId: string;
  expectedState?: string; plan: ComponentAlignmentPlan;
  instanceImpact: { source: { count: number; nodeIds: string[] }; target: { count: number; nodeIds: string[] } };
  propertyMap?: Record<string, string>; changedNodeIds?: string[];
  preservationPolicy: string;
  executionOrder?: ['properties', 'slotBindings', 'fields', 'booleanBindings'];
  recovery?: { requiresApproval: true; cause?: string; completedSteps: string[]; remainingSteps: string[];
    cleanupErrors: unknown[]; attempt: number };
}
