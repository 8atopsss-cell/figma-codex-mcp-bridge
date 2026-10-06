import { pluginRequestSchema } from '../shared/protocol.js';
import { getFileOverview, getLocalStyles, getNodePreview, getNodeSvg, getNodeTree } from './read.js';
import { getVariables } from './variables.js';
import { describeError } from './errors.js';
import { createPage, createScreen, deleteNode, updateNode } from './write.js';
import { createComponentVariants } from './variants.js';
import { VariantError } from './variant-state.js';
import { readFileKey } from './file-identity.js';

figma.showUI(__html__, { width: 320, height: 300, themeColors: true });

let writeTail = Promise.resolve();
const writeMethods = new Set(['page.create', 'screen.create', 'node.update', 'node.delete', 'component.variants.create']);
function serializeWrite<T>(action: () => Promise<T>): Promise<T> {
  const next = writeTail.then(action, action);
  writeTail = next.then(() => undefined, () => undefined);
  return next;
}

figma.ui.onmessage = async (message: unknown) => {
  if (message && typeof message === 'object' && 'type' in message) {
    if (message.type === 'pairing.load') {
      const fileKey = readFileKey(figma);
      const file = { fileName: figma.root.name, ...(fileKey ? { fileKey } : {}) };
      try {
        const token: unknown = await figma.clientStorage.getAsync('bridge-pairing-token');
        figma.ui.postMessage({ type: 'pairing.saved', token: typeof token === 'string' && /^[a-f0-9]{64}$/.test(token) ? token : null, ...file });
      } catch {
        figma.ui.postMessage({ type: 'pairing.saved', token: null, ...file });
      }
      return;
    }
    if (message.type === 'pairing.save' && 'token' in message && typeof message.token === 'string' && /^[a-f0-9]{64}$/.test(message.token)) {
      await figma.clientStorage.setAsync('bridge-pairing-token', message.token);
      return;
    }
    if (message.type === 'pairing.clear') {
      await figma.clientStorage.deleteAsync('bridge-pairing-token');
      return;
    }
  }
  const request = pluginRequestSchema.safeParse(message);
  if (!request.success) return;
  try {
    const execute = async () => {
      switch (request.data.method) {
        case 'file.overview': return getFileOverview(figma);
        case 'node.tree': return getNodeTree(figma, request.data.args);
        case 'node.preview': return getNodePreview(figma, request.data.args);
        case 'node.svg': return getNodeSvg(figma, request.data.args);
        case 'styles.list': return getLocalStyles(figma);
        case 'variables.list': return getVariables(figma, request.data.args);
        case 'page.create': return createPage(figma, request.data.args.name);
        case 'screen.create': return createScreen(figma, request.data.args);
        case 'node.update': return updateNode(figma, request.data.args);
        case 'component.variants.create': return createComponentVariants(figma, request.data.args);
        case 'node.delete': return deleteNode(figma, request.data.args.nodeId);
        default: throw new Error('UNSUPPORTED_METHOD');
      }
    };
    const value = writeMethods.has(request.data.method) ? await serializeWrite(execute) : await execute();
    figma.ui.postMessage({
      type: 'plugin.result',
      requestId: request.data.requestId,
      value,
    });
  } catch (error) {
    const message = describeError(error);
    const code = error instanceof VariantError ? error.code : ['NODE_NOT_FOUND', 'UNSUPPORTED_NODE', 'FONT_UNAVAILABLE', 'PREVIEW_TOO_LARGE', 'SVG_TOO_LARGE', 'INVALID_ARGUMENT', 'COLLECTION_NOT_FOUND', 'VARIABLES_TOO_LARGE']
      .includes(message) ? message : 'FIGMA_API_ERROR';
    const nodeId = 'nodeId' in request.data.args ? ` ${request.data.args.nodeId}` : '';
    const detail = code === 'FIGMA_API_ERROR' || error instanceof VariantError ? `${request.data.method}${nodeId}: ${message}`.slice(0, 500) : code;
    console.error(`[Figma Bridge] ${request.data.method}${nodeId}`, error);
    figma.ui.postMessage({ type: 'plugin.error', requestId: request.data.requestId, code, message: detail,
      ...(error instanceof VariantError ? { details: error.details } : {}),
    });
  }
};
