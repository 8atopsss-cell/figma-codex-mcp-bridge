import { describe, expect, it } from 'vitest';
import { pluginRequestSchema, screenSpecSchema, updateNodeSchema } from '../src/shared/protocol.js';

const rectangle = { type: 'rectangle', name: 'Card', x: 0, y: 0, width: 100, height: 50, fill: '#ffffff' };

describe('bridge protocol', () => {
  it('accepts source frame composition previews and rejects unsealed or arbitrary writes', () => {
    const args = { operationId: 'compose-1', nodeId: 'source', name: 'Light frame', position: { x: 0, y: 500 }, frameNodeIds: [], componentMappings: [], layerStyles: [] };
    const request = { type: 'plugin.call', requestId: 'compose', method: 'theme.frame.compose', args };
    expect(pluginRequestSchema.safeParse(request).success).toBe(true);
    expect(pluginRequestSchema.parse(request).args).toMatchObject({ dryRun: true });
    expect(pluginRequestSchema.safeParse({ ...request, args: { ...args, dryRun: false } }).success).toBe(false);
    expect(pluginRequestSchema.safeParse({ ...request, args: { ...args, script: 'arbitrary' } }).success).toBe(false);
  });
  it('accepts only a fixed scratch probe and requires preview state for creation', () => {
    const request = { type: 'plugin.call', requestId: 'probe', method: 'component.modal.probe', args: { operationId: 'probe-1' } };
    expect(pluginRequestSchema.safeParse(request).success).toBe(true);
    expect(pluginRequestSchema.parse(request).args).toMatchObject({ dryRun: true });
    expect(pluginRequestSchema.safeParse({ ...request, args: { operationId: 'probe-1', dryRun: false } }).success).toBe(false);
    expect(pluginRequestSchema.safeParse({ ...request, args: { operationId: 'probe-1', dryRun: false, expectedState: 'state' } }).success).toBe(true);
    expect(pluginRequestSchema.safeParse({ ...request, args: { operationId: 'probe-1', sourceComponentId: 'finished' } }).success).toBe(false);
  });
  it('accepts bounded orphan-reference repairs and requires expectedState for apply', () => {
    const args = { instanceId: 'icon', expectedMainComponentId: 'orphan', replacementComponentId: 'wrapper', operationId: 'repair-1' };
    const request = { type: 'plugin.call', requestId: 'repair', method: 'component.reference.repair', args };
    expect(pluginRequestSchema.safeParse(request).success).toBe(true);
    expect(pluginRequestSchema.parse(request).args).toMatchObject({ dryRun: true });
    expect(pluginRequestSchema.safeParse({ ...request, args: { ...args, dryRun: false } }).success).toBe(false);
    expect(pluginRequestSchema.safeParse({ ...request, args: { ...args, dryRun: false, expectedState: 'state' } }).success).toBe(true);
    expect(pluginRequestSchema.safeParse({ ...request, args: { ...args, deleteNode: true } }).success).toBe(false);
  });
  it('accepts explicit schema alignment previews and rejects writes without state or arbitrary patch fields', () => {
    const args = { sourceComponentId: 'dark', targetComponentId: 'light', operationId: 'align-1', bindings: [{ sourcePropertyId: 'title#d', targetNodeIds: ['light-title'] }] };
    const request = { type: 'plugin.call', requestId: 'align', method: 'component.schema.align', args };
    expect(pluginRequestSchema.safeParse(request).success).toBe(true);
    expect(pluginRequestSchema.parse(request).args).toMatchObject({ dryRun: true, fields: [] });
    expect(pluginRequestSchema.safeParse({ ...request, args: { ...args, dryRun: false, expectedState: 'approved-state' } }).success).toBe(true);
    for (const patch of [{ dryRun: false }, { operationId: '../unsafe' }, { deleteProperties: ['anything'] }, { bindings: [] },
      { fields: [{ sourceNodeId: 'dark-body', targetNodeId: 'light-body', fields: ['fills'] }] },
      { fields: [{ sourceNodeId: 'dark-body', targetNodeId: 'light-body', fields: ['mainComponent'] }] }]) {
      expect(pluginRequestSchema.safeParse({ ...request, args: { ...args, ...patch } }).success).toBe(false);
    }
  });
  it('requires a preview snapshot for a theme component copy and rejects implicit destructive options', () => {
    const args = { nodeId: 'instance', libraryRootIds: ['kit'], operationId: 'theme-copy-1', name: 'Light copy', position: { x: 700, y: 200 }, layerMap: { label: 'light-label' } };
    const request = { type: 'plugin.call', requestId: 'theme-copy', method: 'theme.copy', args };
    expect(pluginRequestSchema.safeParse(request).success).toBe(true);
    expect(pluginRequestSchema.parse(request).args).toMatchObject({ dryRun: true, layerMap: args.layerMap });
    expect(pluginRequestSchema.safeParse({ ...request, args: { ...args, dryRun: false, expectedState: 'fresh-state' } }).success).toBe(true);
    for (const patch of [{ dryRun: false }, { detach: true }, { resetOverrides: true }, { frameFallbackNodeIds: ['instance'] }, { operationId: '../copy' }, { layerMap: { a: 'same', b: 'same' } }]) {
      expect(pluginRequestSchema.safeParse({ ...request, args: { ...args, ...patch } }).success).toBe(false);
    }
  });
  it('accepts bounded read-only catalog/theme plans and rejects writes or conflicting maps', () => {
    const request = { type: 'plugin.call', requestId: 'theme', method: 'theme.plan', args: { nodeId: 'window', libraryRootIds: ['kit'] } };
    expect(pluginRequestSchema.parse(request).args).toMatchObject({ targetTheme: 'light', mappings: [] });
    for (const patch of [{ dryRun: false }, { apply: true }, { libraryRootIds: [] }, { mappings: [
      { sourceId: 'dark', targetId: 'light' }, { sourceId: 'dark', targetId: 'other' },
    ] }, { mappings: [{ sourceId: 'dark', targetId: 'light', propertyMap: { a: 'c', b: 'c' } }] }]) {
      expect(pluginRequestSchema.safeParse({ ...request, args: { ...request.args, ...patch } }).success).toBe(false);
    }
    expect(pluginRequestSchema.parse({ ...request, method: 'components.list', args: { rootNodeId: 'kit', limit: 100 } }).args).toMatchObject({ offset: 0, limit: 100 });
    expect(pluginRequestSchema.safeParse({ ...request, method: 'components.list', args: { rootNodeId: 'kit', limit: 101 } }).success).toBe(false);
  });
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

  it('accepts duplicate previews and rejects unapproved apply, unknown fields and unsafe operation IDs', () => {
    const args = { sourceNodeId: '1:2', operationId: 'copy-light-v1', name: 'Light copy', position: { x: 700, y: 200 } };
    const request = { type: 'plugin.call', requestId: 'copy', method: 'node.duplicate', args };
    expect(pluginRequestSchema.parse(request).args).toMatchObject({ dryRun: true, layerStyles: [] });
    for (const patch of [{ dryRun: false }, { detach: true }, { operationId: '../secret' }, { parentId: 'other' }]) {
      expect(pluginRequestSchema.safeParse({ ...request, args: { ...args, ...patch } }).success).toBe(false);
    }
  });
});
