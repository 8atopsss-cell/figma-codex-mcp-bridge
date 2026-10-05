import { describe, expect, it } from 'vitest';
import { pluginRequestSchema, screenSpecSchema, updateNodeSchema } from '../src/shared/protocol.js';

const rectangle = { type: 'rectangle', name: 'Card', x: 0, y: 0, width: 100, height: 50, fill: '#ffffff' };

describe('bridge protocol', () => {
  it('accepts an editable screen and rejects invalid dimensions or colors', () => {
    const screen = { pageId: '1:2', name: 'Home', x: 0, y: 0, width: 1440, height: 900, children: [rectangle] };
    expect(screenSpecSchema.safeParse(screen).success).toBe(true);
    expect(screenSpecSchema.safeParse({ ...screen, width: -1 }).success).toBe(false);
    expect(screenSpecSchema.safeParse({ ...screen, children: [{ ...rectangle, fill: 'red' }] }).success).toBe(false);
  });

  it('caps total nodes and nesting', () => {
    const screen = { pageId: '1:2', name: 'Home', x: 0, y: 0, width: 1440, height: 900 };
    expect(screenSpecSchema.safeParse({ ...screen, children: Array.from({ length: 201 }, () => rectangle) }).success).toBe(false);
    let nested: unknown = rectangle;
    for (let i = 0; i < 9; i++) nested = { type: 'frame', name: 'Group', x: 0, y: 0, width: 100, height: 100, children: [nested] };
    expect(screenSpecSchema.safeParse({ ...screen, children: [nested] }).success).toBe(false);
  });

  it('rejects empty updates and unknown commands', () => {
    expect(updateNodeSchema.safeParse({ nodeId: '1:2', patch: {} }).success).toBe(false);
    expect(updateNodeSchema.safeParse({ nodeId: '1:2', patch: { name: 'New' } }).success).toBe(true);
    expect(pluginRequestSchema.safeParse({ type: 'plugin.call', requestId: 'r1', method: 'shell.exec', args: {} }).success).toBe(false);
  });

  it('validates bounded variable reads and rejects mutation fields', () => {
    const request = { type: 'plugin.call', requestId: 'r1', method: 'variables.list', args: { nodeId: '3:1', variableIds: ['V:1'], offset: 0, limit: 100 } };
    expect(pluginRequestSchema.safeParse(request).success).toBe(true);
    expect(pluginRequestSchema.safeParse({ ...request, args: { ...request.args, limit: 501 } }).success).toBe(false);
    expect(pluginRequestSchema.safeParse({ ...request, args: { ...request.args, setValue: 20 } }).success).toBe(false);
  });

  it('accepts variant previews through the shared message protocol and rejects direct writes without a snapshot', () => {
    const request = {
      type: 'plugin.call', requestId: 'r-variants', method: 'component.variants.create',
      args: { componentSetId: '1:2', operationId: 'op-1', variants: [{ sourceComponentId: '1:3', properties: { theme: 'light' }, position: { x: 10, y: 10 } }] },
    };
    expect(pluginRequestSchema.parse(request).args).toMatchObject({ dryRun: true });
    expect(pluginRequestSchema.safeParse({ ...request, args: { ...request.args, dryRun: false } }).success).toBe(false);
    expect(pluginRequestSchema.safeParse({ ...request, args: { ...request.args, dryRun: false, expectedState: '{}' } }).success).toBe(true);
  });
});
