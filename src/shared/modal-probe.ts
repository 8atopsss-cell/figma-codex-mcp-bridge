import * as z from 'zod/v4';

export const modalProbeSchema = z.object({
  operationId: z.string().min(1).max(80).regex(/^[A-Za-z0-9_-]+$/),
  dryRun: z.boolean().default(true),
  expectedState: z.string().min(1).max(200).optional(),
}).strict().superRefine((args, ctx) => {
  if (!args.dryRun && !args.expectedState) ctx.addIssue({ code: 'custom', path: ['expectedState'], message: 'Apply requires preview expectedState' });
});
export type ModalProbeArgs = z.infer<typeof modalProbeSchema>;
export type ModalProbeCaseId = 'outside-optional' | 'legacy-reparent' | 'custom-title';
export interface ModalProbeCaseResult {
  id: ModalProbeCaseId; passed: boolean; nodeIds: string[];
  detail: string; evidence?: Record<string, unknown>;
  failure?: { code: string; message: string };
}
export interface ModalProbeResult {
  status: 'preview' | 'applied' | 'replayed' | 'partial'; operationId: string;
  draftName: string; expectedState?: string; pageId?: string; createdNodeIds: string[];
  containerId?: string; containerType?: 'FRAME';
  placement?: { x: number; y: number; width: number; height: number };
  recovery?: { attempt: 1; previousFailure: { code: string; message: string }; originalReceipt: string };
  plan: Array<{ id: ModalProbeCaseId; description: string }>;
  cases: ModalProbeCaseResult[]; capabilityOnly: true;
  failure?: { code: string; message: string };
}
