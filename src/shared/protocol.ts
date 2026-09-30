import * as z from 'zod/v4';

const id = z.string().min(1).max(128);
const name = z.string().min(1).max(200);
const position = z.number().finite().min(-100_000).max(100_000);
const size = z.number().finite().min(1).max(10_000);
const fill = z.string().regex(/^#[0-9a-fA-F]{6}$/);

const nodeBase = {
  name,
  x: position,
  y: position,
  width: size,
  height: size,
  fill: fill.optional(),
};

export type NodeSpec = {
  type: 'frame' | 'text' | 'rectangle';
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  fill?: string;
  children?: NodeSpec[];
  layoutMode?: 'NONE' | 'HORIZONTAL' | 'VERTICAL';
  itemSpacing?: number;
  paddingLeft?: number;
  paddingRight?: number;
  paddingTop?: number;
  paddingBottom?: number;
  characters?: string;
  fontSize?: number;
  fontFamily?: string;
  fontStyle?: string;
  cornerRadius?: number;
};

export const nodeSpecSchema: z.ZodType<NodeSpec> = z.lazy(() => z.discriminatedUnion('type', [
  z.object({
    ...nodeBase,
    type: z.literal('frame'),
    children: z.array(nodeSpecSchema).optional(),
    layoutMode: z.enum(['NONE', 'HORIZONTAL', 'VERTICAL']).optional(),
    itemSpacing: z.number().finite().min(0).max(1_000).optional(),
    paddingLeft: z.number().finite().min(0).max(1_000).optional(),
    paddingRight: z.number().finite().min(0).max(1_000).optional(),
    paddingTop: z.number().finite().min(0).max(1_000).optional(),
    paddingBottom: z.number().finite().min(0).max(1_000).optional(),
  }).strict(),
  z.object({
    ...nodeBase,
    type: z.literal('text'),
    characters: z.string().max(20_000),
    fontSize: z.number().finite().min(1).max(1_000).optional(),
    fontFamily: z.string().min(1).max(100).optional(),
    fontStyle: z.string().min(1).max(100).optional(),
  }).strict(),
  z.object({
    ...nodeBase,
    type: z.literal('rectangle'),
    cornerRadius: z.number().finite().min(0).max(5_000).optional(),
  }).strict(),
]));

export const screenSpecSchema = z.object({
  pageId: id,
  name,
  x: position,
  y: position,
  width: size,
  height: size,
  fill: fill.optional(),
  layoutMode: z.enum(['NONE', 'HORIZONTAL', 'VERTICAL']).optional(),
  itemSpacing: z.number().finite().min(0).max(1_000).optional(),
  children: z.array(nodeSpecSchema).max(200),
}).strict().superRefine((screen, context) => {
  let count = 0;
  const visit = (nodes: NodeSpec[], depth: number): void => {
    for (const node of nodes) {
      count++;
      if (count > 200) {
        context.addIssue({ code: 'custom', message: 'Screen exceeds 200 child nodes' });
        return;
      }
      if (depth > 8) {
        context.addIssue({ code: 'custom', message: 'Screen exceeds 8 nesting levels' });
        return;
      }
      if (node.children) visit(node.children, depth + 1);
    }
  };
  visit(screen.children, 1);
});

export const updateNodeSchema = z.object({
  nodeId: id,
  patch: z.object({
    name: name.optional(),
    x: position.optional(),
    y: position.optional(),
    width: size.optional(),
    height: size.optional(),
    fill: fill.optional(),
    characters: z.string().max(20_000).optional(),
    fontSize: z.number().finite().min(1).max(1_000).optional(),
    layoutMode: z.enum(['NONE', 'HORIZONTAL', 'VERTICAL']).optional(),
    itemSpacing: z.number().finite().min(0).max(1_000).optional(),
  }).strict().refine((patch) => Object.keys(patch).length > 0, 'Patch must not be empty'),
}).strict();

const call = <M extends string, A extends z.ZodType>(method: M, args: A) => z.object({
  type: z.literal('plugin.call'),
  requestId: id,
  method: z.literal(method),
  args,
}).strict();

export const pluginRequestSchema = z.discriminatedUnion('method', [
  call('file.overview', z.object({}).strict()),
  call('node.tree', z.object({ nodeId: id, depth: z.number().int().min(0).max(8), offset: z.number().int().min(0), limit: z.number().int().min(1).max(100) }).strict()),
  call('node.preview', z.object({ nodeId: id, scale: z.number().min(0.1).max(4) }).strict()),
  call('styles.list', z.object({}).strict()),
  call('page.create', z.object({ name }).strict()),
  call('screen.create', screenSpecSchema),
  call('node.update', updateNodeSchema),
  call('node.delete', z.object({ nodeId: id }).strict()),
]);

export const pluginReplySchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('plugin.result'), requestId: id, value: z.unknown() }).strict(),
  z.object({ type: z.literal('plugin.error'), requestId: id, code: z.string().min(1).max(80), message: z.string().max(500) }).strict(),
]);

export type ScreenSpec = z.infer<typeof screenSpecSchema>;
export type UpdateNodeSpec = z.infer<typeof updateNodeSchema>;
export type PluginRequest = z.infer<typeof pluginRequestSchema>;
export type PluginReply = z.infer<typeof pluginReplySchema>;
