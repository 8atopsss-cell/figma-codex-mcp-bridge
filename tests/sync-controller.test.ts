import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { SyncController } from '../src/bridge/sync/controller.js';
import { startSyncHttp } from '../src/bridge/sync/http.js';

const folders: string[] = [];
afterEach(async () => { for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true }); });

async function fixture() {
  const project = await mkdtemp(join(tmpdir(), 'figma-sync-'));
  folders.push(project);
  for (const path of ['src', '.storybook', 'scripts', 'docs', 'source/figma']) await mkdir(join(project, path), { recursive: true });
  const source = { id: 'set', type: 'COMPONENT_SET', name: 'Button', childCount: 0, children: [], properties: { paddingLeft: 8 } };
  await writeFile(join(project, 'source/figma/export.json'), JSON.stringify({ light: source }));
  await writeFile(join(project, 'source/figma/component-links.json'), JSON.stringify({ schemaVersion: 1, components: [{
    componentId: 'button', displayName: 'Button', modulePath: 'src/Button.tsx',
    storybook: { componentEntryId: 'button', storyIds: ['button--light'] },
    figma: { displayName: 'Same name', fileKey: 'original', sources: [{ theme: 'light', componentSetId: 'set' }] },
    baselineCandidate: { rawExport: 'source/figma/export.json', status: 'unverified' },
  }] }));
  let file = { id: '11111111-1111-4111-8111-111111111111', name: 'Same name', active: true, visible: true };
  let padding = 8;
  let incomplete = false;
  const reader = { call: async (method: string) => {
    if (method === 'styles.list') return { paints: [], texts: [], effects: [] };
    return { ...source, properties: { paddingLeft: padding }, warnings: incomplete ? ['component property definitions unavailable'] : [] };
  } };
  const host = { listFiles: () => [file], pinCurrentFile: () => reader };
  const controller = new SyncController(project, host);
  return { controller, project, file, setPadding: (next: number) => { padding = next; },
    setIncomplete: (next: boolean) => { incomplete = next; },
    reconnect: () => { file = { ...file, id: '22222222-2222-4222-8222-222222222222' }; } };
}

it('does not treat export as implementation or user acceptance; rejects stale OK after a Figma edit', async () => {
  const f = await fixture();
  await expect(f.controller.compare('button')).rejects.toThrow('FILE_CONFIRMATION_REQUIRED');
  await f.controller.bind('original', f.file.id);
  let result = await f.controller.compare('button');
  let row = result.components[0];
  expect(row.status).toBe('no-baseline');
  result = await f.controller.implemented('button', row.snapshotId!, row.revision!);
  row = result.components[0];
  expect(row.status).toBe('ready');
  f.setPadding(16);
  await expect(f.controller.accept('button', row.snapshotId!, row.revision!)).rejects.toThrow('SOURCE_OR_IMPLEMENTATION_CHANGED');
  expect((await f.controller.list()).components[0].status).toBe('needs-transfer');
  f.setPadding(8);
  row = (await f.controller.compare('button')).components[0];
  expect(row.status).toBe('ready');
  expect((await f.controller.accept('button', row.snapshotId!, row.revision!)).components[0].status).toBe('accepted');
});

it('blocks incomplete observations and requires source confirmation again after reconnect', async () => {
  const f = await fixture(); await f.controller.bind('original', f.file.id);
  const old = (await f.controller.compare('button')).components[0];
  f.setIncomplete(true);
  const current = (await f.controller.compare('button')).components[0];
  expect(current.snapshotId).toBe(old.snapshotId);
  expect(current.status).toBe('incomplete');
  await expect(f.controller.implemented('button', current.snapshotId!, current.revision!)).rejects.toThrow('SNAPSHOT_INCOMPLETE');
  f.reconnect();
  await expect(f.controller.compare('button')).rejects.toThrow('FILE_CONFIRMATION_REQUIRED');
});

it('invalidates visual acceptance when implementation files change and restores state after restart', async () => {
  const f = await fixture(); await f.controller.bind('original', f.file.id);
  let row = (await f.controller.compare('button')).components[0];
  row = (await f.controller.implemented('button', row.snapshotId!, row.revision!)).components[0];
  await writeFile(join(f.project, 'src/Button.tsx'), 'changed implementation');
  await expect(f.controller.accept('button', row.snapshotId!, row.revision!)).rejects.toThrow('STALE_ACCEPTANCE_REQUEST');
  const restarted = new SyncController(f.project, { listFiles: () => [], pinCurrentFile: () => { throw new Error('NOT_CONNECTED'); } });
  const current = (await restarted.list()).components[0];
  expect(current.status).toBe('implementation-changed');
  expect(current.stale).toBe(true);
});

it('protects the local API with Origin and a separate scoped code and exposes no implementation-write endpoint', async () => {
  const f = await fixture();
  const server = await startSyncHttp(f.controller, 0);
  const url = `http://127.0.0.1:${server.port}`;
  const headers = { Origin: 'http://127.0.0.1:6007', Authorization: `Bearer ${f.controller.accessCode}` };
  try {
    expect((await fetch(`${url}/sync/components`)).status).toBe(403);
    expect((await fetch(`${url}/sync/components`, { headers: { Origin: headers.Origin } })).status).toBe(401);
    expect((await fetch(`${url}/sync/components`, { headers })).status).toBe(200);
    expect((await fetch(`${url}/sync/previews?componentId=button`)).status).toBe(403);
    expect((await fetch(`${url}/sync/previews?componentId=button`, { headers })).status).toBe(409);
    await f.controller.bind('original', f.file.id);
    const row = (await f.controller.compare('button')).components[0];
    await f.controller.implemented('button', row.snapshotId!, row.revision!);
    const previews = await fetch(`${url}/sync/previews?componentId=button`, { headers });
    expect(previews.status).toBe(200);
    expect(await previews.json()).toMatchObject({ componentId: 'button', baselineId: row.snapshotId, variants: [] });
    expect((await fetch(`${url}/sync/previews?componentId=button&project=C:/`, { headers })).status).toBe(409);
    expect((await fetch(`${url}/sync/implemented`, { method: 'POST', headers })).status).toBe(404);
    expect((await fetch(`${url}/sync/compare`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ componentId: 'button', project: 'C:/' }) })).status).toBe(409);
    expect((await fetch(`${url}/sync/components`, { headers: { ...headers, Origin: 'https://example.com' } })).status).toBe(403);
  } finally { await server.close(); }
});
