import { buildSync } from 'esbuild';
import { runInNewContext } from 'node:vm';
import { expect, it, vi } from 'vitest';

it('passes binding provenance and consumer values through the actual plugin message handler', async () => {
  const primary = {
    id: 'V:primary', key: 'primary-key', name: 'color.action.primary', resolvedType: 'COLOR',
    variableCollectionId: 'C:theme', remote: false, description: '', scopes: ['ALL_SCOPES'], codeSyntax: {},
    valuesByMode: { light: { type: 'VARIABLE_ALIAS', id: 'V:orange' }, dark: { type: 'VARIABLE_ALIAS', id: 'V:orange' } },
    resolveForConsumer: vi.fn(() => ({ value: { r: 1, g: 0.34, b: 0.13, a: 1 }, resolvedType: 'COLOR' })),
  };
  const orange = {
    ...primary, id: 'V:orange', name: 'orange.500',
    valuesByMode: { light: { r: 1, g: 0.34, b: 0.13, a: 1 }, dark: { r: 1, g: 0.34, b: 0.13, a: 1 } },
  };
  const theme = {
    id: 'C:theme', name: 'Theme', key: 'theme-key', defaultModeId: 'light', isExtension: false,
    modes: [{ modeId: 'light', name: 'Light' }, { modeId: 'dark', name: 'Dark' }], variableIds: ['V:primary', 'V:orange'], remote: false,
  };
  const node = {
    id: '3:1', name: 'Button', type: 'COMPONENT', key: 'button-key',
    boundVariables: { fills: [{ type: 'VARIABLE_ALIAS', id: 'V:primary' }] },
    fills: [{ type: 'SOLID', color: { r: 1, g: 0.34, b: 0.13 }, boundVariables: { color: { type: 'VARIABLE_ALIAS', id: 'V:primary' } } }],
    explicitVariableModes: {}, resolvedVariableModes: { 'C:theme': 'dark' },
    componentPropertyDefinitions: { size: { type: 'VARIANT', defaultValue: '32', variantOptions: ['32', '40'] } },
    variantProperties: { size: '40' },
  };
  const messages: Array<{ requestId: string; type: string; value?: any }> = [];
  const api = {
    showUI: vi.fn(),
    ui: { onmessage: undefined as unknown as (message: unknown) => Promise<void>, postMessage: (message: unknown) => messages.push(JSON.parse(JSON.stringify(message))) },
    getNodeByIdAsync: vi.fn(async () => node),
    variables: {
      getLocalVariablesAsync: vi.fn(async () => [primary, orange]),
      getLocalVariableCollectionsAsync: vi.fn(async () => [theme]),
    },
  };
  const compiled = buildSync({ entryPoints: ['src/plugin/main.ts'], bundle: true, write: false, platform: 'browser', format: 'iife', target: 'es2020' });
  runInNewContext(compiled.outputFiles![0].text, { figma: api, __html__: '' });
  await api.ui.onmessage({ type: 'plugin.call', requestId: 'tree', method: 'node.tree', args: { nodeId: node.id, depth: 0, offset: 0, limit: 10 } });
  await api.ui.onmessage({ type: 'plugin.call', requestId: 'tokens', method: 'variables.list', args: { variableIds: [primary.id], nodeId: node.id } });
  expect(messages.map((m) => m.type)).toEqual(['plugin.result', 'plugin.result']);
  expect(messages[0].value.properties).toMatchObject({
    boundVariables: node.boundVariables, resolvedVariableModes: node.resolvedVariableModes,
    componentPropertyDefinitions: node.componentPropertyDefinitions, variantProperties: { size: '40' },
  });
  expect(messages[1].value.nodeResolutions[0]).toMatchObject({
    status: 'resolved', resolvedForConsumer: { value: { r: 1, g: 0.34, b: 0.13, a: 1 } },
    chain: [{ name: 'color.action.primary', modeId: 'dark' }, { name: 'orange.500', modeId: 'dark' }],
  });
  expect(messages[1].value.variables[0].valuesByMode.dark).toEqual({ type: 'VARIABLE_ALIAS', id: orange.id });
});
