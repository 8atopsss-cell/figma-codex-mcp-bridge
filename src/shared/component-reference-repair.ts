import * as z from 'zod/v4';
const id = z.string().min(1).max(128);
export const componentReferenceRepairSchema = z.object({
  instanceId: id, expectedMainComponentId: id, replacementComponentId: id,
  operationId: z.string().min(1).max(80).regex(/^[A-Za-z0-9_-]+$/),
  dryRun: z.boolean().default(true), expectedState: z.string().min(1).max(524_288).optional(),
}).strict().superRefine((args, ctx) => {
  if (!args.dryRun && !args.expectedState) ctx.addIssue({ code: 'custom', path: ['expectedState'], message: 'Apply requires preview expectedState' });
  if (args.expectedMainComponentId === args.replacementComponentId) ctx.addIssue({ code: 'custom', message: 'Distinct old and replacement main components required' });
});
export type ComponentReferenceRepairArgs = z.infer<typeof componentReferenceRepairSchema>;
export interface ComponentReferenceRepairResult {
  status: 'preview' | 'applied' | 'replayed'; operationId: string;
  instanceId: string; ownerComponentId: string; expectedMainComponentId: string; replacementComponentId: string;
  expectedState?: string;
  instanceImpact: { count: number; nodeIds: string[] };
  nativeLayoutChanges: Array<{ nodeId: string; field: string; before: unknown; after: unknown }>;
  nodeMap?: Array<{ beforeId: string; afterId: string; path: string }>;
  restoredNestedInstanceIds?: string[]; changedNodeIds?: string[]; preservationPolicy: string;
}
