import { modalProbeSchema, type ModalProbeArgs, type ModalProbeCaseId, type ModalProbeCaseResult, type ModalProbeResult } from '../shared/modal-probe.js';
import { describeError } from './errors.js';
import { snapshotDigest } from './snapshot-digest.js';
import { fail, jsonValue, snapshot, stable, utf8Length, VariantError } from './variant-state.js';

type Api = Pick<typeof figma, 'root' | 'currentPage' | 'mixed' | 'createPage' | 'createComponent' | 'createFrame' | 'createText' | 'loadFontAsync' | 'getNodeByIdAsync'> & { fileKey?: string };
type Obj = Record<string, any>;
const prefix = 'modal-probe-v1-';
const ownerKey = `${prefix}owner`;
const draftName = 'Codex / Modal API probe';
const maxNodes = 240, maxState = 4_194_304, maxResult = 524_288;
const pageLimitMessage = 'in createPage: The Starter plan only comes with 3 pages. Upgrade to Professional for unlimited pages: https://www.figma.com/pricing';
const plan: ModalProbeResult['plan'] = [
  { id: 'outside-optional', description: 'Create vertical header: Optional TEXT outside Title SLOT; BOOLEAN true/false new instances retain linked Title.' },
  { id: 'legacy-reparent', description: 'Create legacy-shaped draft; move owned Optional from Title SLOT into new wrapper, bind BOOLEAN outside. Native restrictions are explicit failures.' },
  { id: 'custom-title', description: 'Insert custom Title content on new instance; verify IDs/content/order/visibility through BOOLEAN toggle, then replace content while retaining displaced owned nodes.' },
];
const obj = (n: unknown) => n as Obj;
function bounded(text: string, stage: string, limit = maxState) {
  if (utf8Length(text) > limit) fail('LIMIT_EXCEEDED', { stage, maxBytes: limit }); return text;
}
function failure(error: unknown) {
  return { code: error instanceof VariantError ? error.code : 'FIGMA_API_ERROR', message: describeError(error).slice(0, 2000) };
}
function metadata(n: BaseNode) {
  return Object.fromEntries(n.getPluginDataKeys().sort().map(k => [k, n.getPluginData(k)]));
}
function identity(api: Api, requestHash: string) {
  // This operation has no existing layer inputs. Page topology and editor context
  // identify its document; only the new owned page is subsequently mutated.
  const context = { documentId: api.root.id, documentName: api.root.name, fileKey: api.fileKey ?? null,
    pages: api.root.children.map(p => ({ id: p.id, name: p.name })),
    currentPageId: api.currentPage.id, selectionIds: api.currentPage.selection.map(n => n.id) };
  return `modal-probe-preview-v1:sha256:${snapshotDigest(`${requestHash}\0${bounded(stable(context), 'document-context')}`)}`;
}
interface Receipt {
  version: 1; requestHash: string; phase: 'running' | 'complete' | 'partial';
  pageId?: string; createdNodeIds: string[]; chunks?: number; payloadHash?: string;
  failure?: ReturnType<typeof failure>;
  containerId?: string; containerType?: 'FRAME'; recovery?: ModalProbeResult['recovery'];
}
// Recovery is deliberately restricted to the observed pre-creation native error.
// The original serialized receipt is immutable evidence, including any unknown fields.
function recoverable(receipt: Receipt) {
  return receipt.phase === 'partial' && receipt.pageId == null && receipt.containerId == null
    && receipt.containerType == null && receipt.recovery == null && receipt.chunks == null && receipt.payloadHash == null
    && Array.isArray(receipt.createdNodeIds) && receipt.createdNodeIds.length === 0
    && receipt.failure?.code === 'FIGMA_API_ERROR' && receipt.failure.message === pageLimitMessage;
}
function assertNoArtifacts(api: Api, key: string, marker: string, operationId: string) {
  const seen = new Set<string>();
  function inspect(n: BaseNode) {
    if (seen.size >= 2200 || seen.has(n.id) || n.removed) fail('LIMIT_EXCEEDED', { stage: 'recovery-artifact-roots' });
    seen.add(n.id);
    if (n.getPluginDataKeys().some(k => k.startsWith(`${key}-`))) fail('OPERATION_INCOMPLETE', { reason: 'Existing result chunks', nodeId: n.id });
    const owner = n.getPluginData(ownerKey); let sameOperation = owner === marker;
    if (owner) { try { sameOperation ||= JSON.parse(owner)?.operationId === operationId; } catch { fail('OPERATION_INCOMPLETE', { reason: 'Unreadable ownership marker', nodeId: n.id }); } }
    if (sameOperation) fail('OPERATION_INCOMPLETE', { reason: 'Existing owned draft', nodeId: n.id });
  }
  // Eligible v1 failed in createPage before any owned scene node could exist.
  // Its possible artifact root is a PAGE, never an arbitrary legacy descendant.
  // Inspect current-page direct children as well to reject an adopted FRAME;
  // never demand-load other pages or traverse unrelated component content.
  inspect(api.root);
  for (const page of api.root.children) inspect(page);
  for (const child of api.currentPage.children) inspect(child);
}
function recoveryContext(api: Api) {
  const page = api.currentPage;
  if (page.removed || page.parent !== api.root || !api.root.children.includes(page) || page.children.length > 2000) fail('LIMIT_EXCEEDED', { stage: 'recovery-page-context' });
  const bound = 1_000_000;
  const finite = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= bound;
  const geometry = page.children.map(n => {
    if (n.removed || n.parent !== page || ![n.x, n.y, n.width, n.height].every(finite) || n.width < 0 || n.height < 0) fail('LIMIT_EXCEEDED', { stage: 'recovery-top-level-geometry', nodeId: n.id });
    const box = n.absoluteBoundingBox;
    if (box && (![box.x, box.y, box.width, box.height].every(finite) || box.width < 0 || box.height < 0)) fail('LIMIT_EXCEEDED', { stage: 'recovery-bounds', nodeId: n.id });
    if (!box && (('rotation' in n && n.rotation !== 0) || ('relativeTransform' in n && (n.relativeTransform[0][1] !== 0 || n.relativeTransform[1][0] !== 0)))) fail('LIMIT_EXCEEDED', { stage: 'recovery-unavailable-bounds', nodeId: n.id });
    return { id: n.id, type: n.type, parentId: page.id, x: n.x, y: n.y, width: n.width, height: n.height,
      rotation: 'rotation' in n ? n.rotation : null, bounds: box ?? null, transform: 'relativeTransform' in n ? n.relativeTransform : null };
  });
  if (new Set(geometry.map(n => n.id)).size !== geometry.length) fail('LIMIT_EXCEEDED', { stage: 'recovery-membership' });
  const x = Math.min(0, ...geometry.map(n => n.bounds?.x ?? n.x));
  const y = Math.max(0, ...geometry.map(n => (n.bounds?.y ?? n.y) + (n.bounds?.height ?? n.height))) + 200;
  const placement = { x, y, width: 2600, height: 1200 };
  if (![x, y, x + placement.width, y + placement.height].every(finite)) fail('LIMIT_EXCEEDED', { stage: 'recovery-placement' });
  return { pageId: page.id, geometry, placement };
}
function write(root: BaseNode, key: string, value: unknown) {
  const text = stable(value); bounded(key + text, 'receipt-entry', 100_000); root.setPluginData(key, text);
}
function collect(page: PageNode | FrameNode): BaseNode[] {
  const nodes: BaseNode[] = []; const seen = new Set<string>();
  function visit(n: BaseNode, depth: number) {
    if (nodes.length >= maxNodes || depth > 12 || seen.has(n.id) || n.removed) fail('LIMIT_EXCEEDED', { stage: 'owned-tree', nodeId: n.id });
    seen.add(n.id); nodes.push(n); if ('children' in n) for (const c of obj(n).children as BaseNode[]) visit(c, depth + 1);
  }
  visit(page, 0); return nodes;
}
async function capture(api: Api, page: PageNode | FrameNode, ids: string[], marker: string, expectedLinks?: Map<string, string>, parentPageId?: string) {
  function local() {
    const attached = page.type === 'PAGE' ? page.parent === api.root && api.root.children.includes(page)
      : page.parent?.type === 'PAGE' && page.parent.id === parentPageId && page.parent.parent === api.root && api.root.children.includes(page.parent) && page.parent.children.includes(page);
    if (page.removed || !attached || page.getPluginData(ownerKey) !== marker) fail('OPERATION_RESULT_CHANGED', { reason: 'Owned container/marker changed', pageId: page.id });
    const nodes = collect(page);
    if (stable(nodes.map(n => n.id).sort()) !== stable([...ids].sort())) fail('OPERATION_RESULT_CHANGED', { reason: 'Owned node membership changed', pageId: page.id });
    const trees = page.children.map(n => snapshot(n, api.mixed));
    const extra = nodes.map(n => ({ id: n.id, metadata: metadata(n),
      schema: n.type === 'COMPONENT' ? jsonValue(n.componentPropertyDefinitions, api.mixed) : null,
      slotSettings: 'slotSettings' in n ? jsonValue(obj(n).slotSettings, api.mixed) : null,
      limitViolations: n.type === 'SLOT' ? jsonValue(n.limitViolations, api.mixed) : null,
      remote: 'remote' in n ? obj(n).remote : null,
    }));
    const pageSettings = Object.fromEntries([
      'backgrounds', 'guides', 'flowStartingPoints', 'prototypeBackgrounds', 'exportSettings',
      'explicitVariableModes', 'resolvedVariableModes',
    ].filter(field => field in page).map(field => [field, jsonValue(obj(page)[field], api.mixed)]));
    if ('prototypeStartNode' in page) pageSettings.prototypeStartNodeId = page.prototypeStartNode?.id ?? null;
    // Preserve the original PAGE snapshot shape for already completed receipts.
    return { pageId: page.id, name: page.name, metadata: metadata(page), pageSettings, trees, extra,
      ...(page.type === 'FRAME' ? { container: snapshot(page, api.mixed, false), parentPageId } : {}) };
  }
  const before = local(); const raw = bounded(stable(before), 'owned-snapshot');
  const links: Record<string, string> = {};
  for (const n of collect(page)) if (n.type === 'INSTANCE') {
    const main = await n.getMainComponentAsync();
    if (!main || main.type !== 'COMPONENT' || main.removed || !ids.includes(main.id)) fail('OPERATION_RESULT_CHANGED', { nodeId: n.id, reason: 'Main component is not owned' });
    if (expectedLinks && expectedLinks.get(n.id) !== main.id) fail('OPERATION_RESULT_CHANGED', { nodeId: n.id, reason: 'Unexpected main component', expectedMainId: expectedLinks.get(n.id), actualMainId: main.id });
    links[n.id] = main.id;
  }
  if (bounded(stable(local()), 'owned-snapshot') !== raw) fail('OPERATION_RESULT_CHANGED', { reason: 'Draft changed while reading main links' });
  for (const n of collect(page)) if (n.type === 'INSTANCE' && (await n.getMainComponentAsync())?.id !== links[n.id]) fail('OPERATION_RESULT_CHANGED', { nodeId: n.id, reason: 'Main link changed while reading' });
  if (bounded(stable(local()), 'owned-snapshot') !== raw) fail('OPERATION_RESULT_CHANGED', { reason: 'Draft changed while reading main links' });
  const result = { ...before, links }; bounded(stable(result), 'owned-snapshot'); return result;
}

export async function probeModalStructure(api: Api, input: unknown): Promise<ModalProbeResult> {
  const args: ModalProbeArgs = modalProbeSchema.parse(input);
  const requestHash = snapshotDigest(stable({ operationId: args.operationId, version: 1, plan }));
  const key = `${prefix}operation-${args.operationId}`;
  const marker = stable({ operationId: args.operationId, requestHash, version: 1 });
  const rawReceipt = api.root.getPluginData(key);
  let previousReceipt: Receipt | undefined;
  if (rawReceipt) {
    let receipt: Receipt;
    try { receipt = JSON.parse(bounded(rawReceipt, 'receipt-entry', 100_000)); }
    catch { fail('OPERATION_CONFLICT', { operationId: args.operationId, reason: 'Unreadable receipt' }); }
    if (!receipt || typeof receipt !== 'object' || receipt.version !== 1 || receipt.requestHash !== requestHash) fail('OPERATION_CONFLICT', { operationId: args.operationId });
    if (receipt.phase !== 'complete') {
      if (!recoverable(receipt)) fail('OPERATION_INCOMPLETE', { operationId: args.operationId, pageId: receipt.pageId, createdNodeIds: receipt.createdNodeIds, failure: receipt.failure, recovery: receipt.recovery });
      assertNoArtifacts(api, key, marker, args.operationId); previousReceipt = receipt;
    } else {
    if (!receipt.pageId || !Array.isArray(receipt.createdNodeIds) || receipt.createdNodeIds.length > maxNodes || !Number.isInteger(receipt.chunks) || receipt.chunks! < 1 || receipt.chunks! > 128) fail('OPERATION_RESULT_CHANGED', { reason: 'Malformed completed receipt' });
    let payload = '';
    for (let i = 0; i < receipt.chunks!; i++) {
      const part = api.root.getPluginData(`${key}-${i}`); if (!part) fail('OPERATION_RESULT_CHANGED', { reason: 'Missing result chunk' });
      bounded(`${key}-${i}` + part, 'receipt-entry', 100_000); payload += part; bounded(payload, 'receipt-result', maxState + maxResult);
    }
    if (snapshotDigest(payload) !== receipt.payloadHash) fail('OPERATION_RESULT_CHANGED', { reason: 'Result receipt hash mismatch' });
    let stored: { result: ModalProbeResult; state: Awaited<ReturnType<typeof capture>> };
    try { stored = JSON.parse(payload); } catch { fail('OPERATION_RESULT_CHANGED', { reason: 'Unreadable saved result' }); }
    if (!stored.result || stored.result.status !== 'applied' || stored.result.pageId !== receipt.pageId || stored.result.operationId !== args.operationId || stable(stored.result.createdNodeIds) !== stable(receipt.createdNodeIds)) fail('OPERATION_RESULT_CHANGED', { reason: 'Saved result identity mismatch' });
    if (receipt.containerType != null && receipt.containerType !== 'FRAME') fail('OPERATION_RESULT_CHANGED', { reason: 'Invalid container type' });
    const isFrame = receipt.containerType === 'FRAME';
    if (isFrame && (!receipt.containerId || stored.result.containerId !== receipt.containerId || stored.result.containerType !== 'FRAME'
      || stable(stored.result.recovery) !== stable(receipt.recovery) || !receipt.recovery || receipt.recovery.attempt !== 1)) fail('OPERATION_RESULT_CHANGED', { reason: 'Saved frame identity mismatch' });
    if (!isFrame && (receipt.containerId != null || stored.result.containerId != null || stored.result.containerType != null)) fail('OPERATION_RESULT_CHANGED', { reason: 'Unexpected frame identity' });
    const page = await api.getNodeByIdAsync(isFrame ? receipt.containerId! : receipt.pageId);
    if (!page || (isFrame ? page.type !== 'FRAME' : page.type !== 'PAGE')) fail('OPERATION_RESULT_CHANGED', { pageId: receipt.pageId });
    const state = await capture(api, page as PageNode | FrameNode, receipt.createdNodeIds, marker, undefined, isFrame ? receipt.pageId : undefined);
    if (stable(state) !== stable(stored.state)) fail('OPERATION_RESULT_CHANGED', { pageId: page.id, reason: 'Draft result edited' });
    return { ...stored.result, status: 'replayed' };
    }
  }
  // Do not overwrite orphan markers, incomplete receipts or result chunks.
  if (!previousReceipt) {
    if (api.root.getPluginDataKeys().some(k => k.startsWith(`${key}-`))) fail('OPERATION_CONFLICT', { reason: 'Orphan result chunks', operationId: args.operationId });
    if (api.root.children.some(p => p.getPluginData(ownerKey) === marker)) fail('OPERATION_INCOMPLETE', { reason: 'Owned page without complete receipt', operationId: args.operationId });
  }
  const recovery = previousReceipt ? { attempt: 1 as const, previousFailure: previousReceipt.failure!, originalReceipt: rawReceipt } : undefined;
  const placementContext = previousReceipt ? recoveryContext(api) : undefined;
  const stateIdentity = () => previousReceipt
    ? `modal-probe-preview-v1:sha256:${snapshotDigest(bounded(stable({ document: identity(api, requestHash), rawReceipt: api.root.getPluginData(key), context: recoveryContext(api) }), 'recovery-preview'))}`
    : identity(api, requestHash);
  const expectedState = stateIdentity();
  const result: ModalProbeResult = { status: 'preview', operationId: args.operationId, draftName, expectedState, createdNodeIds: [], plan, cases: [], capabilityOnly: true };
  if (recovery) { result.recovery = recovery; result.pageId = placementContext!.pageId; result.containerType = 'FRAME'; result.placement = placementContext!.placement; }
  if (args.dryRun) return result;
  if (args.expectedState !== expectedState) fail('SOURCE_CHANGED', { stage: 'before-font' });
  await api.loadFontAsync({ family: 'Inter', style: 'Regular' });
  try {
    if (stateIdentity() !== expectedState || api.root.getPluginData(key) !== rawReceipt) fail('SOURCE_CHANGED', { stage: 'after-font' });
    if (previousReceipt) assertNoArtifacts(api, key, marker, args.operationId);
  } catch (error) { fail('SOURCE_CHANGED', { stage: 'after-font', cause: failure(error) }); }

  let page: PageNode | FrameNode | undefined;
  const owned = new Map<string, BaseNode>();
  const expectedLinks = new Map<string, string>();
  const receipt: Receipt = { version: 1, requestHash, phase: 'running', createdNodeIds: [], ...(recovery ? { recovery, containerType: 'FRAME' as const } : {}) };
  function checkpoint() {
    receipt.createdNodeIds = [...owned.keys()]; receipt.pageId = placementContext?.pageId ?? page?.id;
    if (recovery) receipt.containerId = page?.id;
    write(api.root, key, receipt);
  }
  function track(n: BaseNode) {
    function visit(node: BaseNode, depth: number) {
      if (owned.has(node.id)) return;
      if (owned.size >= maxNodes || depth > 12) fail('LIMIT_EXCEEDED', { stage: 'created-nodes' });
      owned.set(node.id, node);
      if ('children' in node) for (const child of obj(node).children as BaseNode[]) visit(child, depth + 1);
    }
    visit(n, 0);
  }
  function move(parent: BaseNode, child: SceneNode) {
    if (!owned.has(parent.id) || !owned.has(child.id)) fail('OWNERSHIP_ERROR', { parentId: parent.id, nodeId: child.id });
    obj(parent).appendChild(child);
  }
  function create<T extends SceneNode>(factory: () => T): T {
    let n: T;
    try { n = factory(); }
    catch (error) { fail('PROBE_CREATION_FAILED', { cause: failure(error) }); }
    track(n); move(page!, n); checkpoint(); return n;
  }
  function text(name: string, value: string) {
    const n = create(() => api.createText()); n.name = name;
    n.fontName = { family: 'Inter', style: 'Regular' }; n.fontSize = 16; n.characters = value; return n;
  }
  function frame(name: string) { const n = create(() => api.createFrame()); n.name = name; n.layoutMode = 'VERTICAL'; return n; }
  function component(name: string, y: number) {
    const n = create(() => api.createComponent()); n.name = name; n.layoutMode = 'VERTICAL'; n.x = 0; n.y = y; return n;
  }
  function bindSlot(master: ComponentNode, slot: FrameNode) {
    const property = master.addComponentProperty('Title', 'SLOT', ''); obj(slot).componentPropertyReferences = { slotContentId: property };
    if (obj(slot).type !== 'SLOT' || obj(slot).componentPropertyReferences?.slotContentId !== property) fail('CAPABILITY_NOT_SUPPORTED', { reason: 'FRAME did not become linked SLOT' });
    return property;
  }
  function bindOptional(master: ComponentNode, optional: TextNode) {
    const property = master.addComponentProperty('Optional', 'BOOLEAN', true); optional.componentPropertyReferences = { visible: property };
    if (optional.componentPropertyReferences.visible !== property) fail('CAPABILITY_NOT_SUPPORTED', { reason: 'BOOLEAN reference not retained' }); return property;
  }
  function instance(master: ComponentNode, x: number) {
    const n = create(() => master.createInstance()); expectedLinks.set(n.id, master.id); n.name = `${master.name} instance`; n.x = x; n.y = master.y; return n;
  }
  function find(n: SceneNode, predicate: (node: SceneNode) => boolean): SceneNode {
    const matches: SceneNode[] = [];
    function visit(node: SceneNode) { if (predicate(node)) matches.push(node); if ('children' in node) node.children.forEach(visit); }
    visit(n); if (matches.length !== 1) fail('CAPABILITY_NOT_SUPPORTED', { reason: 'Expected one physical descendant', nodeId: n.id, count: matches.length }); return matches[0];
  }
  function verifyInstance(n: InstanceNode, booleanId: string, slotId: string, value: boolean) {
    n.setProperties({ [booleanId]: value });
    const optional = find(n, child => obj(child).componentPropertyReferences?.visible === booleanId);
    const title = find(n, child => child.type === 'SLOT' && obj(child).componentPropertyReferences?.slotContentId === slotId);
    if (optional.visible !== value || !title.visible || n.componentProperties[booleanId]?.value !== value || !('children' in title) || !title.children.length) fail('CAPABILITY_NOT_SUPPORTED', { reason: 'BOOLEAN/Title readback failed', nodeId: n.id });
    return { instanceId: n.id, mainComponentId: expectedLinks.get(n.id), optionalId: optional.id, optionalVisible: optional.visible, titleId: title.id, titleVisible: title.visible, titlePropertyId: obj(title).componentPropertyReferences?.slotContentId, titleChildIds: title.children.map(c => c.id) };
  }
  function run(id: ModalProbeCaseId, action: () => Record<string, unknown>) {
    const before = new Set(owned.keys());
    const entry: ModalProbeCaseResult = { id, passed: false, nodeIds: [], detail: '' };
    try { entry.evidence = action(); entry.passed = true; entry.detail = 'Owned draft API readback passed; production migration and visual parity remain unproven.'; }
    catch (error) {
      entry.failure = failure(error); entry.detail = 'Native capability failed on new owned nodes; retained draft for review.';
      if (error instanceof VariantError && ['PROBE_CREATION_FAILED', 'LIMIT_EXCEEDED', 'OWNERSHIP_ERROR'].includes(error.code)) {
        entry.nodeIds = [...owned.keys()].filter(k => !before.has(k)); result.cases.push(entry); throw error;
      }
    }
    entry.nodeIds = [...owned.keys()].filter(k => !before.has(k)); result.cases.push(entry);
  }
  try {
    checkpoint(); page = recovery ? api.createFrame() : api.createPage(); owned.set(page.id, page); checkpoint();
    if (recovery) {
      if (page.type !== 'FRAME' || page.parent !== api.currentPage || page.parent.id !== placementContext!.pageId) fail('OWNERSHIP_ERROR', { reason: 'Unexpected recovery frame parent' });
      const placement = placementContext!.placement;
      page.layoutMode = 'NONE'; page.clipsContent = false; page.resize(placement.width, placement.height); page.x = placement.x; page.y = placement.y;
    }
    page.setPluginData(ownerKey, marker); page.name = draftName;
    let proposed: { master: ComponentNode; booleanId: string; slotId: string } | undefined;
    run('outside-optional', () => {
      const master = component('01 / Optional outside Title', 0); const optional = text('Optional', 'Optional label');
      const title = frame('Title'); const heading = text('Heading', 'Modal title');
      move(master, optional); move(master, title); move(title, heading);
      const slotId = bindSlot(master, title), booleanId = bindOptional(master, optional);
      proposed = { master, booleanId, slotId };
      const on = instance(master, 400), off = instance(master, 800);
      return { masterId: master.id, optionalId: optional.id, titleId: title.id, booleanId, slotId,
        instances: [verifyInstance(on, booleanId, slotId, true), verifyInstance(off, booleanId, slotId, false)] };
    });
    run('legacy-reparent', () => {
      const master = component('02 / Owned legacy-shaped reparent', 300); const title = frame('Title');
      const optional = text('Optional', 'Legacy optional'), heading = text('Heading', 'Legacy title');
      move(master, title); move(title, optional); move(title, heading); const slotId = bindSlot(master, title);
      const before = { optionalId: optional.id, parentId: optional.parent!.id, titleChildIds: title.children.map(c => c.id) };
      // Only this newly created legacy-shaped subtree is structurally changed.
      const wrapper = frame('Header wrapper'); move(master, wrapper); move(wrapper, optional); move(wrapper, title);
      const booleanId = bindOptional(master, optional);
      if (optional.parent?.id !== wrapper.id || !title.children.some(c => c.id === heading.id) || title.children.some(c => c.id === optional.id)) fail('CAPABILITY_NOT_SUPPORTED', { reason: 'Reparent readback failed' });
      const on = instance(master, 400), off = instance(master, 800);
      return { before, after: { optionalId: optional.id, parentId: optional.parent.id, titleChildIds: title.children.map(c => c.id) }, booleanId, slotId,
        instances: [verifyInstance(on, booleanId, slotId, true), verifyInstance(off, booleanId, slotId, false)] };
    });
    run('custom-title', () => {
      if (!proposed) fail('CAPABILITY_NOT_SUPPORTED', { reason: 'Proposed master unavailable after first case failure' });
      const n = instance(proposed.master, 1200); n.y = 600;
      const slot = find(n, c => c.type === 'SLOT' && obj(c).componentPropertyReferences?.slotContentId === proposed!.slotId) as SlotNode;
      const staged = frame('Preserved displaced Title contents'); staged.x = 1600; staged.y = 600;
      const read = (children: readonly SceneNode[]) => children.map(c => ({ id: c.id, type: c.type, characters: c.type === 'TEXT' ? c.characters : null, visible: c.visible }));
      const displacedBefore = read(slot.children);
      const displaced = [...slot.children]; for (const child of displaced) move(staged, child);
      const displacedAfter = read(staged.children);
      if (stable(displacedBefore) !== stable(displacedAfter) || displaced.some(c => c.parent?.id !== staged.id)) fail('CAPABILITY_NOT_SUPPORTED', { reason: 'Displaced default Title preservation failed' });
      const first = text('Custom title first', 'Custom Title A'), second = text('Custom title second', 'Custom Title B');
      const customExpected = read([first, second]);
      move(slot, first); move(slot, second);
      const before = read(slot.children);
      if (stable(before) !== stable(customExpected)) fail('CAPABILITY_NOT_SUPPORTED', { reason: 'Custom Title insertion preservation failed' });
      verifyInstance(n, proposed!.booleanId, proposed!.slotId, false); const afterToggle = read(slot.children);
      if (stable(before) !== stable(afterToggle)) fail('CAPABILITY_NOT_SUPPORTED', { reason: 'Custom Title content/order/visibility lost on toggle' });
      for (const child of [...slot.children]) move(staged, child);
      const retainedExpected = [...displacedBefore, ...afterToggle];
      const retainedAfterMove = read(staged.children);
      if (stable(retainedAfterMove) !== stable(retainedExpected)) fail('CAPABILITY_NOT_SUPPORTED', { reason: 'Custom Title staging preservation failed' });
      const replacement = text('Replacement title', 'Replacement custom Title'); const replacementExpected = read([replacement]);
      move(slot, replacement); const afterReplace = read(slot.children), retainedAfterReplace = read(staged.children);
      if (stable(afterReplace) !== stable(replacementExpected) || stable(retainedAfterReplace) !== stable(retainedExpected)
        || [...displaced, first, second].some(c => c.parent?.id !== staged.id)) fail('CAPABILITY_NOT_SUPPORTED', { reason: 'Custom replacement preservation/readback failed' });
      if (slot.limitViolations.length) fail('CAPABILITY_NOT_SUPPORTED', { reason: 'Slot limits violated', violations: slot.limitViolations });
      return { instanceId: n.id, titleId: slot.id, displacedDefaultIds: displaced.map(c => c.id), displacedBefore, displacedAfter, before, afterToggle, afterReplace, retainedAfterMove, retainedAfterReplace,
        retainedCustomIds: [first.id, second.id], retainedAtFrameId: staged.id, titleVisible: slot.visible, limitViolations: slot.limitViolations };
    });
    result.status = 'applied'; result.pageId = placementContext?.pageId ?? page.id; result.createdNodeIds = [...owned.keys()]; delete result.expectedState;
    if (recovery) result.containerId = page.id;
    bounded(stable(result), 'public-result', maxResult);
    const state = await capture(api, page, result.createdNodeIds, marker, expectedLinks, placementContext?.pageId);
    const payload = bounded(stable({ result, state }), 'receipt-result', maxState + maxResult);
    const points = Array.from(payload), chunks: string[] = [];
    for (let i = 0; i < points.length; i += 12_000) chunks.push(points.slice(i, i + 12_000).join(''));
    if (chunks.length > 128) fail('LIMIT_EXCEEDED', { stage: 'receipt-chunks' });
    chunks.forEach((part, i) => { bounded(`${key}-${i}` + part, 'receipt-entry', 100_000); api.root.setPluginData(`${key}-${i}`, part); });
    receipt.phase = 'complete'; receipt.chunks = chunks.length; receipt.payloadHash = snapshotDigest(payload); checkpoint();
    return result;
  } catch (error) {
    // Never delete draft nodes: foreign edits, partial native calls and review
    // evidence must survive. Same operation ID remains durably non-retryable.
    result.status = 'partial'; result.pageId = placementContext?.pageId ?? page?.id; result.createdNodeIds = [...owned.keys()]; result.failure = failure(error); delete result.expectedState;
    if (recovery) result.containerId = page?.id;
    receipt.phase = 'partial'; receipt.failure = result.failure;
    try { checkpoint(); } catch (receiptError) { result.failure.message = `${result.failure.message}; receipt write: ${describeError(receiptError)}`.slice(0, 3000); }
    bounded(stable(result), 'public-result', maxResult); return result;
  }
}
