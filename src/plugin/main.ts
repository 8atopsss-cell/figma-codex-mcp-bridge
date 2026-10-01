import { pluginRequestSchema } from '../shared/protocol.js';
import { getFileOverview, getLocalStyles, getNodePreview, getNodeSvg, getNodeTree } from './read.js';
import { getVariables } from './variables.js';
import { describeError } from './errors.js';
import { createPage, createScreen, deleteNode, updateNode } from './write.js';

figma.showUI(__html__, { width: 320, height: 300, themeColors: true });

figma.ui.onmessage = async (message: unknown) => {
  if (message && typeof message === 'object' && 'type' in message) {
    if (message.type === 'pairing.load') {
      try {
        const token: unknown = await figma.clientStorage.getAsync('bridge-pairing-token');
        figma.ui.postMessage({ type: 'pairing.saved', token: typeof token === 'string' && /^[a-f0-9]{64}$/.test(token) ? token : null, fileName: figma.root.name });
      } catch {
        figma.ui.postMessage({ type: 'pairing.saved', token: null, fileName: figma.root.name });
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
    let value: unknown;
    switch (request.data.method) {
      case 'file.overview': value = getFileOverview(figma); break;
      case 'node.tree': value = await getNodeTree(figma, request.data.args); break;
      case 'node.preview': value = await getNodePreview(figma, request.data.args); break;
      case 'node.svg': value = await getNodeSvg(figma, request.data.args); break;
      case 'styles.list': value = await getLocalStyles(figma); break;
      case 'variables.list': value = await getVariables(figma, request.data.args); break;
      case 'page.create': value = createPage(figma, request.data.args.name); break;
      case 'screen.create': value = await createScreen(figma, request.data.args); break;
      case 'node.update': value = await updateNode(figma, request.data.args); break;
      case 'node.delete': value = await deleteNode(figma, request.data.args.nodeId); break;
      default: throw new Error('UNSUPPORTED_METHOD');
    }
    figma.ui.postMessage({
      type: 'plugin.result',
      requestId: request.data.requestId,
      value,
    });
  } catch (error) {
    const message = describeError(error);
    const code = ['NODE_NOT_FOUND', 'UNSUPPORTED_NODE', 'FONT_UNAVAILABLE', 'PREVIEW_TOO_LARGE', 'SVG_TOO_LARGE', 'INVALID_ARGUMENT', 'COLLECTION_NOT_FOUND', 'VARIABLES_TOO_LARGE']
      .includes(message) ? message : 'FIGMA_API_ERROR';
    const nodeId = 'nodeId' in request.data.args ? ` ${request.data.args.nodeId}` : '';
    const detail = code === 'FIGMA_API_ERROR' ? `${request.data.method}${nodeId}: ${message}`.slice(0, 500) : code;
    console.error(`[Figma Bridge] ${request.data.method}${nodeId}`, error);
    figma.ui.postMessage({ type: 'plugin.error', requestId: request.data.requestId, code, message: detail });
  }
};
