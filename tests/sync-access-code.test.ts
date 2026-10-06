import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { loadOrCreateSyncAccessCode, syncAccessCodePath } from '../src/bridge/sync/access-code.js';

const folders: string[] = [];
afterEach(async () => { for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true }); });
async function fixture() {
  const folder = await mkdtemp(join(tmpdir(), 'sync-access-')); folders.push(folder);
  const project = join(folder, 'project'), storage = join(folder, 'private');
  await mkdir(project); return { project, storage };
}
it('keeps the same project code after restart and concurrent startup', async () => {
  const { project, storage } = await fixture();
  const codes = await Promise.all(Array.from({ length: 4 }, () => loadOrCreateSyncAccessCode(project, storage)));
  expect(codes[0]).toMatch(/^[a-f0-9]{64}$/);
  expect(new Set(codes).size).toBe(1);
  expect(await loadOrCreateSyncAccessCode(project, storage)).toBe(codes[0]);
});
it('uses different codes for different projects and keeps tokens outside served project files', async () => {
  const { project, storage } = await fixture();
  const other = project + '-other'; await mkdir(other);
  expect(await loadOrCreateSyncAccessCode(project, storage)).not.toBe(await loadOrCreateSyncAccessCode(other, storage));
  expect(await syncAccessCodePath(project, storage)).toContain(storage);
});
it('preserves an existing valid code and rejects a corrupt file instead of silently replacing it', async () => {
  const { project, storage } = await fixture(); await mkdir(storage);
  const path = await syncAccessCodePath(project, storage);
  await writeFile(path, 'a'.repeat(64));
  expect(await loadOrCreateSyncAccessCode(project, storage)).toBe('a'.repeat(64));
  await writeFile(path, 'corrupt');
  await expect(loadOrCreateSyncAccessCode(project, storage)).rejects.toThrow('INVALID_SYNC_ACCESS_CODE_FILE');
  expect(await readFile(path, 'utf8')).toBe('corrupt');
});
