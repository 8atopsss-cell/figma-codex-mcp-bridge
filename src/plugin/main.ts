import { pluginRequestSchema } from '../shared/protocol.js';
import { getFileOverview, getLocalStyles, getNodePreview, getNodeTree } from './read.js';

figma.showUI(__html__, { width: 320, height: 220, themeColors: true });

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
      default: throw new Error('UNSUPPORTED_METHOD');
    }
    figma.ui.postMessage({
      type: 'plugin.result',
      requestId: request.data.requestId,
      value,
    });
  } catch (error) {
    const code = error instanceof Error ? error.message : 'FIGMA_API_ERROR';
    figma.ui.postMessage({ type: 'plugin.error', requestId: request.data.requestId, code, message: code });
  }
};
