import { pluginRequestSchema } from '../shared/protocol.js';
import { getFileOverview, getLocalStyles, getNodePreview, getNodeTree } from './read.js';
import { createPage, createScreen, deleteNode, updateNode } from './write.js';

figma.showUI(__html__, { width: 320, height: 300, themeColors: true });

figma.ui.onmessage = async (message: unknown) => {
  const request = pluginRequestSchema.safeParse(message);
  if (!request.success) return;
  try {
    let value: unknown;
    switch (request.data.method) {
      case 'file.overview': value = getFileOverview(figma); break;
      case 'node.tree': value = await getNodeTree(figma, request.data.args); break;
      case 'node.preview': value = await getNodePreview(figma, request.data.args); break;
      case 'styles.list': value = await getLocalStyles(figma); break;
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
    const message = error instanceof Error ? error.message : '';
    const code = ['NODE_NOT_FOUND', 'UNSUPPORTED_NODE', 'FONT_UNAVAILABLE', 'PREVIEW_TOO_LARGE', 'INVALID_ARGUMENT']
      .includes(message) ? message : 'FIGMA_API_ERROR';
    figma.ui.postMessage({ type: 'plugin.error', requestId: request.data.requestId, code, message: code });
  }
};
