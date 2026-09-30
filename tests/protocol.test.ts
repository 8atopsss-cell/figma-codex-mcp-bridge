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
});
